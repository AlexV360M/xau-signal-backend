const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

// ── State (in-memory) ──────────────────────────────────────────────────────
let activeSignal = null;
let signalHistory = [];
let lastAnalysis = null;

// ── Market hours ───────────────────────────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (day === 6) return false;                    // Saturday: always closed
  if (day === 0 && hour < 22) return false;       // Sunday: opens 22:00 UTC
  if (day === 5 && hour >= 22) return false;      // Friday: closes 22:00 UTC
  return true;
}

function getSession() {
  const hour = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  if (hour >= 22 || hour < 7) return 'sydney';
  if (hour >= 7 && hour < 9) return 'pre-london';
  if (hour >= 9 && hour < 12) return 'london';
  if (hour >= 12 && hour < 16) return 'london-ny-overlap'; // Best time
  if (hour >= 16 && hour < 22) return 'new-york';
  return 'closed';
}

function isLondonNYOverlap() {
  const hour = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  return hour >= 12 && hour < 16;
}

// ── Indicators ─────────────────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

// ── Zone detection (M30) ───────────────────────────────────────────────────
function detectZones(candles) {
  const zones = [];
  const lookback = 5;

  for (let i = lookback; i < candles.length - lookback; i++) {
    const before = candles.slice(i - lookback, i);
    const after = candles.slice(i + 1, i + lookback + 1);

    // Swing High = resistance
    const isSwingHigh = before.every(c => c.high <= candles[i].high) &&
                        after.every(c => c.high <= candles[i].high);
    // Swing Low = support
    const isSwingLow = before.every(c => c.low >= candles[i].low) &&
                       after.every(c => c.low >= candles[i].low);

    if (isSwingHigh) {
      zones.push({ type: 'resistance', price: candles[i].high, time: candles[i].datetime, touches: 1 });
    }
    if (isSwingLow) {
      zones.push({ type: 'support', price: candles[i].low, time: candles[i].datetime, touches: 1 });
    }
  }

  // Merge nearby zones within $3 for gold
  const merged = [];
  for (const z of zones) {
    const existing = merged.find(m =>
      m.type === z.type && Math.abs(m.price - z.price) < 3.0
    );
    if (existing) {
      existing.touches++;
      existing.price = parseFloat(((existing.price + z.price) / 2).toFixed(2));
    } else {
      merged.push({ ...z });
    }
  }

  // Sort by strength (touches) and return top 8
  return merged
    .filter(z => z.touches >= 1)
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 8);
}

// ── M5 confirmation patterns ───────────────────────────────────────────────
function detectM5Pattern(candles) {
  if (candles.length < 3) return null;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  if (range === 0) return null;

  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  // Bullish pin bar (long lower wick, small body at top)
  const bullishPin = lowerWick > body * 2.5 && lowerWick > range * 0.6 && last.close > last.open;
  // Bearish pin bar (long upper wick, small body at bottom)
  const bearishPin = upperWick > body * 2.5 && upperWick > range * 0.6 && last.close < last.open;

  if (bullishPin) return { pattern: 'bullish_pin_bar', direction: 'buy' };
  if (bearishPin) return { pattern: 'bearish_pin_bar', direction: 'sell' };

  // Bullish engulfing
  const bullishEngulf = last.close > last.open &&
                        prev.close < prev.open &&
                        last.open <= prev.close &&
                        last.close >= prev.open &&
                        Math.abs(last.close - last.open) > Math.abs(prev.close - prev.open);

  // Bearish engulfing
  const bearishEngulf = last.close < last.open &&
                        prev.close > prev.open &&
                        last.open >= prev.close &&
                        last.close <= prev.open &&
                        Math.abs(last.close - last.open) > Math.abs(prev.close - prev.open);

  if (bullishEngulf) return { pattern: 'bullish_engulfing', direction: 'buy' };
  if (bearishEngulf) return { pattern: 'bearish_engulfing', direction: 'sell' };

  return null;
}

// ── Signal quality score ───────────────────────────────────────────────────
function calcQuality(zone, m5Pattern, rsi, overlap, h4Spread) {
  let score = 0;

  // H4 trend strength based on EMA spread (max 25)
  const spreadScore = Math.min(25, Math.round(h4Spread / 4));
  score += spreadScore;

  // Zone strength — touches (max 20)
  score += Math.min(20, zone.touches * 5);

  // M5 pattern (max 30)
  if (m5Pattern) {
    if (m5Pattern.pattern.includes('engulfing')) score += 30;
    else if (m5Pattern.pattern.includes('pin_bar')) score += 25;
  }

  // RSI positioning (max 15)
  if (rsi !== null) {
    if (rsi < 30 || rsi > 70) score += 15;
    else if (rsi < 40 || rsi > 60) score += 8;
  }

  // London-NY overlap bonus (max 10)
  if (overlap) score += 10;

  return Math.min(100, score);
}

// ── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

// ── Twelve Data fetch ──────────────────────────────────────────────────────
async function fetchCandles(interval, outputsize = 150) {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVEDATA_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.values || !Array.isArray(data.values)) {
    throw new Error(`Twelve Data feil for ${interval}: ${JSON.stringify(data)}`);
  }

  // Twelve Data returns newest first — reverse to oldest first
  return data.values.reverse().map(c => ({
    datetime: c.datetime,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close)
  }));
}

// ── Main analysis ──────────────────────────────────────────────────────────
async function analyzeMarket() {
  if (!isMarketOpen()) {
    return {
      marketClosed: true,
      message: 'Weekend — market closed',
      signal: activeSignal,
      signalHistory: signalHistory.slice(0, 20)
    };
  }

  // Fetch three timeframes in parallel
  const [h4Candles, m30Candles, m5Candles] = await Promise.all([
    fetchCandles('4h', 200),
    fetchCandles('30min', 150),
    fetchCandles('5min', 50)
  ]);

  // ── H4: Direction/Bias ──────────────────────────────────────────────────
  const h4Closes = h4Candles.map(c => c.close);
  const ema50_h4 = calcEMA(h4Closes, 50);
  const ema200_h4 = calcEMA(h4Closes, 200);
  const h4Bias = (ema50_h4 && ema200_h4)
    ? (ema50_h4 > ema200_h4 ? 'bullish' : 'bearish')
    : 'range';
  const h4Spread = ema50_h4 && ema200_h4 ? Math.abs(ema50_h4 - ema200_h4) : 0;
  const lastH4 = h4Candles[h4Candles.length - 1];

  // ── M30: Support & Resistance zones ────────────────────────────────────
  const zones = detectZones(m30Candles);
  const lastM30 = m30Candles[m30Candles.length - 1];
  const currentPrice = lastM30.close;

  // ── M5: Entry confirmation ──────────────────────────────────────────────
  const m5Closes = m5Candles.map(c => c.close);
  const rsi_m5 = calcRSI(m5Closes, 14);
  const m5Pattern = detectM5Pattern(m5Candles);
  const lastM5 = m5Candles[m5Candles.length - 1];

  const overlap = isLondonNYOverlap();
  const session = getSession();
  const zoneBuffer = 2.5; // $2.5 buffer for gold

  // ── Check if active signal hit TP or SL ────────────────────────────────
  if (activeSignal) {
    const p = currentPrice;

    if (activeSignal.direction === 'buy') {
      if (p >= activeSignal.takeProfit) {
        const pips = parseFloat(((activeSignal.takeProfit - activeSignal.entry) * 10).toFixed(1));
        activeSignal.outcome = 'tp_hit';
        activeSignal.closedAt = activeSignal.takeProfit;
        activeSignal.pips = `+${pips}`;
        activeSignal.closedTime = new Date().toISOString();
        signalHistory.unshift({ ...activeSignal });
        await sendTelegram(
          `✅ <b>XAU SIGNAL — TP HIT</b>\n` +
          `▲ BUY\n` +
          `Entry: $${activeSignal.entry}\n` +
          `Close: $${activeSignal.takeProfit}\n` +
          `Pips: +${pips} pips 💰`
        );
        activeSignal = null;
      } else if (p <= activeSignal.stopLoss) {
        const pips = parseFloat(((activeSignal.entry - activeSignal.stopLoss) * 10).toFixed(1));
        activeSignal.outcome = 'sl_hit';
        activeSignal.closedAt = activeSignal.stopLoss;
        activeSignal.pips = `-${pips}`;
        activeSignal.closedTime = new Date().toISOString();
        signalHistory.unshift({ ...activeSignal });
        await sendTelegram(
          `❌ <b>XAU SIGNAL — SL HIT</b>\n` +
          `▲ BUY\n` +
          `Entry: $${activeSignal.entry}\n` +
          `Close: $${activeSignal.stopLoss}\n` +
          `Pips: -${pips} pips`
        );
        activeSignal = null;
      }
    }

    if (activeSignal && activeSignal.direction === 'sell') {
      if (p <= activeSignal.takeProfit) {
        const pips = parseFloat(((activeSignal.entry - activeSignal.takeProfit) * 10).toFixed(1));
        activeSignal.outcome = 'tp_hit';
        activeSignal.closedAt = activeSignal.takeProfit;
        activeSignal.pips = `+${pips}`;
        activeSignal.closedTime = new Date().toISOString();
        signalHistory.unshift({ ...activeSignal });
        await sendTelegram(
          `✅ <b>XAU SIGNAL — TP HIT</b>\n` +
          `▼ SELL\n` +
          `Entry: $${activeSignal.entry}\n` +
          `Close: $${activeSignal.takeProfit}\n` +
          `Pips: +${pips} pips 💰`
        );
        activeSignal = null;
      } else if (p >= activeSignal.stopLoss) {
        const pips = parseFloat(((activeSignal.stopLoss - activeSignal.entry) * 10).toFixed(1));
        activeSignal.outcome = 'sl_hit';
        activeSignal.closedAt = activeSignal.stopLoss;
        activeSignal.pips = `-${pips}`;
        activeSignal.closedTime = new Date().toISOString();
        signalHistory.unshift({ ...activeSignal });
        await sendTelegram(
          `❌ <b>XAU SIGNAL — SL HIT</b>\n` +
          `▼ SELL\n` +
          `Entry: $${activeSignal.entry}\n` +
          `Close: $${activeSignal.stopLoss}\n` +
          `Pips: -${pips} pips`
        );
        activeSignal = null;
      }
    }
  }

  // ── Generate new signal — only if no active signal ──────────────────────
  if (!activeSignal) {
    for (const zone of zones) {
      const inZone = Math.abs(currentPrice - zone.price) <= zoneBuffer;
      if (!inZone) continue;

      // BUY: price in support zone + H4 bullish + M5 bullish confirmation
      if (zone.type === 'support' && h4Bias === 'bullish') {
        const m5Confirms = m5Pattern && m5Pattern.direction === 'buy';
        const status = m5Confirms ? 'confirmed' : 'armed';

        const sl = parseFloat((zone.price - zoneBuffer * 2).toFixed(2));
        const slDistance = currentPrice - sl;
        const tp = parseFloat((currentPrice + slDistance * 2).toFixed(2));
        const quality = calcQuality(zone, m5Confirms ? m5Pattern : null, rsi_m5, overlap, h4Spread);

        activeSignal = {
          id: Date.now(),
          createdAt: new Date().toISOString(),
          direction: 'buy',
          status,
          entry: parseFloat(currentPrice.toFixed(2)),
          stopLoss: sl,
          takeProfit: tp,
          riskReward: '1:2',
          zone: parseFloat(zone.price.toFixed(2)),
          zoneType: zone.type,
          zoneTouches: zone.touches,
          m5Pattern: m5Pattern ? m5Pattern.pattern : 'scanning',
          m5Rsi: rsi_m5,
          overlap,
          session,
          quality,
          h4Bias,
          ema50: ema50_h4,
          ema200: ema200_h4,
          outcome: 'open',
          reasoning: `H4 BULLISH (EMA50 $${ema50_h4} > EMA200 $${ema200_h4}) · M30 støttesone $${zone.price.toFixed(2)} (${zone.touches} touches) · M5: ${m5Pattern ? m5Pattern.pattern : 'venter på bekreftelse'}`
        };

        if (status === 'confirmed') {
          await sendTelegram(
            `🚨 <b>XAU SIGNAL CONFIRMED</b>\n\n` +
            `▲ <b>BUY</b>\n` +
            `Entry: <b>$${activeSignal.entry}</b>\n` +
            `Stop Loss: $${activeSignal.stopLoss}\n` +
            `Take Profit: $${activeSignal.takeProfit}\n` +
            `Risk/Reward: 1:2\n\n` +
            `H4 Bias: BULLISH\n` +
            `M30 Zone: $${zone.price.toFixed(2)} (${zone.touches} touches)\n` +
            `M5 Pattern: ${m5Pattern.pattern}\n` +
            `RSI: ${rsi_m5}\n` +
            `Quality: ${quality}/100\n` +
            `Session: ${session}`
          );
        }
        break;
      }

      // SELL: price in resistance zone + H4 bearish + M5 bearish confirmation
      if (zone.type === 'resistance' && h4Bias === 'bearish') {
        const m5Confirms = m5Pattern && m5Pattern.direction === 'sell';
        const status = m5Confirms ? 'confirmed' : 'armed';

        const sl = parseFloat((zone.price + zoneBuffer * 2).toFixed(2));
        const slDistance = sl - currentPrice;
        const tp = parseFloat((currentPrice - slDistance * 2).toFixed(2));
        const quality = calcQuality(zone, m5Confirms ? m5Pattern : null, rsi_m5, overlap, h4Spread);

        activeSignal = {
          id: Date.now(),
          createdAt: new Date().toISOString(),
          direction: 'sell',
          status,
          entry: parseFloat(currentPrice.toFixed(2)),
          stopLoss: sl,
          takeProfit: tp,
          riskReward: '1:2',
          zone: parseFloat(zone.price.toFixed(2)),
          zoneType: zone.type,
          zoneTouches: zone.touches,
          m5Pattern: m5Pattern ? m5Pattern.pattern : 'scanning',
          m5Rsi: rsi_m5,
          overlap,
          session,
          quality,
          h4Bias,
          ema50: ema50_h4,
          ema200: ema200_h4,
          outcome: 'open',
          reasoning: `H4 BEARISH (EMA50 $${ema50_h4} < EMA200 $${ema200_h4}) · M30 motstandssone $${zone.price.toFixed(2)} (${zone.touches} touches) · M5: ${m5Pattern ? m5Pattern.pattern : 'venter på bekreftelse'}`
        };

        if (status === 'confirmed') {
          await sendTelegram(
            `🚨 <b>XAU SIGNAL CONFIRMED</b>\n\n` +
            `▼ <b>SELL</b>\n` +
            `Entry: <b>$${activeSignal.entry}</b>\n` +
            `Stop Loss: $${activeSignal.stopLoss}\n` +
            `Take Profit: $${activeSignal.takeProfit}\n` +
            `Risk/Reward: 1:2\n\n` +
            `H4 Bias: BEARISH\n` +
            `M30 Zone: $${zone.price.toFixed(2)} (${zone.touches} touches)\n` +
            `M5 Pattern: ${m5Pattern.pattern}\n` +
            `RSI: ${rsi_m5}\n` +
            `Quality: ${quality}/100\n` +
            `Session: ${session}`
          );
        }
        break;
      }
    }
  }

  // Update live pips for open signal
  if (activeSignal && activeSignal.outcome === 'open') {
    const livePips = activeSignal.direction === 'buy'
      ? parseFloat(((currentPrice - activeSignal.entry) * 10).toFixed(1))
      : parseFloat(((activeSignal.entry - currentPrice) * 10).toFixed(1));
    activeSignal.livePips = livePips;
  }

  lastAnalysis = {
    symbol: 'XAUUSD',
    price: parseFloat(currentPrice.toFixed(2)),
    open: lastM30.open,
    high: lastM30.high,
    low: lastM30.low,
    ema50: ema50_h4,
    ema200: ema200_h4,
    rsi: rsi_m5,
    bias: h4Bias,
    h4Spread: parseFloat(h4Spread.toFixed(2)),
    session,
    zones,
    signal: activeSignal,
    signalHistory: signalHistory.slice(0, 20),
    overlap,
    marketClosed: false,
    dataSource: 'Twelve Data · H4 + M30 + M5',
    updatedAt: new Date().toISOString()
  };

  return lastAnalysis;
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), market: isMarketOpen() ? 'open' : 'closed' });
});

app.get('/api/market', async (req, res) => {
  try {
    if (!TWELVEDATA_API_KEY) {
      return res.status(500).json({ error: 'TWELVEDATA_API_KEY mangler i Secrets' });
    }
    const data = await analyzeMarket();
    res.json(data);
  } catch (err) {
    console.error('Market error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    if (!NEWS_API_KEY) return res.json({ events: [], newsLocked: false });

    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    // Fetch USD high-impact events (these move gold)
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${tomorrow}&token=${NEWS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    const goldKeywords = ['fed', 'fomc', 'cpi', 'inflation', 'nfp', 'payroll', 'gdp', 'interest rate', 'powell', 'pce', 'pmi', 'ism'];

    const relevant = (data.economicCalendar || [])
      .filter(e => {
        const isUSD = ['USD', 'US'].includes(e.country);
        const isHighImpact = ['high', 'medium'].includes((e.impact || '').toLowerCase());
        const isGoldRelevant = goldKeywords.some(k => (e.event || '').toLowerCase().includes(k));
        return isUSD && isHighImpact;
      })
      .map(e => ({
        time: e.time,
        event: e.event,
        country: e.country,
        impact: e.impact,
        minsUntil: Math.round((new Date(e.time) - Date.now()) / 60000)
      }))
      .sort((a, b) => a.minsUntil - b.minsUntil);

    const newsLocked = relevant.some(e => e.minsUntil >= -15 && e.minsUntil <= 60);

    res.json({ events: relevant.slice(0, 8), newsLocked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test-telegram', async (req, res) => {
  await sendTelegram(
    '🔔 <b>XAU Signal Desk — Test</b>\n\nTelegram fungerer! ✅\nSystemet er klart for signaler.'
  );
  res.json({ sent: true, chatId: TELEGRAM_CHAT_ID });
});

// ── Dashboard HTML ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(getDashboardHTML());
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0"/>
  <title>XAU Signal Desk</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
    :root {
      --gold:#D4AF37; --gold-dim:#8a7020; --gold-glow:rgba(212,175,55,0.15);
      --bg:#0a0a0b; --bg-card:#111114; --bg-card2:#16161a;
      --border:#222228; --text:#e8e8f0; --text-dim:#666675;
      --green:#00c896; --green-glow:rgba(0,200,150,0.12);
      --red:#ff4560; --red-glow:rgba(255,69,96,0.12);
      --yellow:#f5a623; --blue:#4a9eff;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:var(--bg); color:var(--text); font-family:'Space Grotesk',sans-serif; min-height:100vh; }

    /* Header */
    header { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid var(--border); background:var(--bg-card); position:sticky; top:0; z-index:100; }
    .logo { display:flex; align-items:center; gap:10px; }
    .logo-icon { width:32px; height:32px; background:var(--gold); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:16px; }
    .logo-text { font-size:16px; font-weight:700; }
    .logo-sub { font-size:10px; color:var(--text-dim); font-family:'Space Mono',monospace; }
    .header-right { display:flex; align-items:center; gap:8px; }
    .live-badge { display:flex; align-items:center; gap:5px; font-size:10px; color:var(--text-dim); font-family:'Space Mono',monospace; }
    .live-dot { width:6px; height:6px; border-radius:50%; background:var(--green); animation:blink 2s infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .refresh-btn { background:var(--bg-card2); border:1px solid var(--border); color:var(--gold); padding:5px 10px; border-radius:6px; font-size:11px; font-family:'Space Mono',monospace; cursor:pointer; }

    /* Banners */
    .banner { display:none; align-items:center; gap:8px; padding:10px 16px; margin:10px 16px 0; border-radius:8px; font-size:12px; font-weight:500; }
    .banner.show { display:flex; }
    .banner-closed { background:rgba(74,158,255,0.08); border:1px solid rgba(74,158,255,0.25); color:var(--blue); }
    .banner-news { background:rgba(255,69,96,0.08); border:1px solid rgba(255,69,96,0.25); color:var(--red); }
    .banner-overlap { background:rgba(245,166,35,0.08); border:1px solid rgba(245,166,35,0.25); color:var(--yellow); }

    /* Main */
    main { padding:14px; display:flex; flex-direction:column; gap:12px; }

    /* Price card */
    .price-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:16px 18px; display:flex; align-items:center; justify-content:space-between; }
    .price-val { font-size:34px; font-weight:700; color:var(--gold); font-family:'Space Mono',monospace; letter-spacing:-1px; }
    .price-meta { font-size:11px; color:var(--text-dim); font-family:'Space Mono',monospace; margin-top:4px; }
    .price-label { font-size:10px; color:var(--text-dim); font-family:'Space Mono',monospace; margin-bottom:3px; letter-spacing:1px; }
    .bias-pill { padding:7px 14px; border-radius:7px; font-size:12px; font-weight:700; font-family:'Space Mono',monospace; letter-spacing:1px; }
    .bias-pill.bullish { background:var(--green-glow); color:var(--green); border:1px solid rgba(0,200,150,0.3); }
    .bias-pill.bearish { background:var(--red-glow); color:var(--red); border:1px solid rgba(255,69,96,0.3); }
    .bias-pill.range { background:var(--gold-glow); color:var(--gold); border:1px solid rgba(212,175,55,0.3); }

    /* Stats */
    .stats-row { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
    .stat { background:var(--bg-card); border:1px solid var(--border); border-radius:10px; padding:10px 12px; text-align:center; }
    .stat-lbl { font-size:9px; color:var(--text-dim); font-family:'Space Mono',monospace; letter-spacing:0.5px; margin-bottom:3px; }
    .stat-val { font-size:16px; font-weight:700; font-family:'Space Mono',monospace; color:var(--gold); }

    /* Signal card */
    .signal-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
    .card-header { padding:12px 16px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; }
    .card-title { font-size:11px; font-family:'Space Mono',monospace; color:var(--text-dim); letter-spacing:1px; }
    .card-body { padding:16px; }
    .no-signal { text-align:center; padding:24px 0; color:var(--text-dim); font-size:13px; }

    .sig-top { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
    .dir-badge { padding:9px 20px; border-radius:7px; font-size:18px; font-weight:700; font-family:'Space Mono',monospace; }
    .dir-badge.buy { background:var(--green-glow); color:var(--green); border:1px solid rgba(0,200,150,0.4); }
    .dir-badge.sell { background:var(--red-glow); color:var(--red); border:1px solid rgba(255,69,96,0.4); }
    .status-badge { padding:5px 10px; border-radius:5px; font-size:10px; font-weight:700; font-family:'Space Mono',monospace; letter-spacing:1px; }
    .status-badge.confirmed { background:var(--green-glow); color:var(--green); border:1px solid rgba(0,200,150,0.3); animation:glow 1.5s infinite; }
    .status-badge.armed { background:rgba(245,166,35,0.1); color:var(--yellow); border:1px solid rgba(245,166,35,0.3); }
    @keyframes glow { 0%,100%{box-shadow:0 0 0 0 rgba(0,200,150,0)} 50%{box-shadow:0 0 10px 3px rgba(0,200,150,0.2)} }

    .sig-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; }
    .sig-item { background:var(--bg-card2); border-radius:7px; padding:9px 11px; }
    .sig-item-lbl { font-size:9px; color:var(--text-dim); font-family:'Space Mono',monospace; margin-bottom:2px; }
    .sig-item-val { font-size:14px; font-weight:600; font-family:'Space Mono',monospace; }
    .sig-item-val.sl { color:var(--red); }
    .sig-item-val.tp { color:var(--green); }
    .sig-item-val.rr { color:var(--gold); font-size:17px; }
    .sig-item-val.pips-pos { color:var(--green); }
    .sig-item-val.pips-neg { color:var(--red); }

    .quality-wrap { background:var(--bg-card2); border-radius:7px; padding:10px; margin-bottom:10px; }
    .quality-top { display:flex; justify-content:space-between; font-size:10px; font-family:'Space Mono',monospace; color:var(--text-dim); margin-bottom:6px; }
    .quality-bar { height:5px; background:var(--border); border-radius:3px; overflow:hidden; }
    .quality-fill { height:100%; border-radius:3px; transition:width 0.5s; }

    .reasoning { background:var(--bg-card2); border-radius:7px; padding:10px; font-size:11px; color:var(--text-dim); line-height:1.6; }

    /* Zones */
    .zones-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
    .zone-row { display:flex; align-items:center; justify-content:space-between; padding:10px 16px; border-bottom:1px solid var(--border); }
    .zone-row:last-child { border-bottom:none; }
    .zone-left { display:flex; align-items:center; gap:9px; }
    .zone-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
    .zone-dot.support { background:var(--green); }
    .zone-dot.resistance { background:var(--red); }
    .zone-type-lbl { font-size:9px; color:var(--text-dim); font-family:'Space Mono',monospace; text-transform:uppercase; }
    .zone-price-lbl { font-size:14px; font-weight:600; font-family:'Space Mono',monospace; }
    .zone-right { text-align:right; }
    .zone-dist { font-size:10px; color:var(--text-dim); font-family:'Space Mono',monospace; }
    .zone-touches { font-size:9px; color:var(--text-dim); font-family:'Space Mono',monospace; }

    /* History */
    .history-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
    .history-stats { display:flex; gap:10px; font-size:10px; font-family:'Space Mono',monospace; }
    table { width:100%; border-collapse:collapse; font-size:11px; }
    th { padding:7px 10px; text-align:left; color:var(--text-dim); font-family:'Space Mono',monospace; font-size:9px; border-bottom:1px solid var(--border); white-space:nowrap; }
    td { padding:9px 10px; border-bottom:1px solid var(--border); font-family:'Space Mono',monospace; white-space:nowrap; }
    .outcome-tp { color:var(--green); font-weight:600; }
    .outcome-sl { color:var(--red); font-weight:600; }
    .outcome-open { color:var(--yellow); }
    .pip-pos { color:var(--green); }
    .pip-neg { color:var(--red); }

    /* Calculator */
    .calc-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; overflow:hidden; margin-bottom:16px; }
    .calc-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:14px 16px; }
    .calc-lbl { font-size:9px; color:var(--text-dim); font-family:'Space Mono',monospace; margin-bottom:4px; }
    .calc-input { background:var(--bg-card2); border:1px solid var(--border); border-radius:6px; padding:8px 10px; color:var(--text); font-family:'Space Mono',monospace; font-size:13px; width:100%; }
    .calc-input:focus { outline:none; border-color:var(--gold); }
    .calc-result { margin:0 16px 14px; background:var(--gold-glow); border:1px solid rgba(212,175,55,0.2); border-radius:7px; padding:10px 12px; display:flex; justify-content:space-between; align-items:center; }
    .calc-result-val { font-size:18px; font-weight:700; color:var(--gold); font-family:'Space Mono',monospace; }

    /* News */
    .news-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; overflow:hidden; margin-bottom:8px; }
    .news-row { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--border); font-size:11px; }
    .news-row:last-child { border-bottom:none; }
    .news-impact { padding:2px 6px; border-radius:3px; font-size:9px; font-weight:700; font-family:'Space Mono',monospace; min-width:36px; text-align:center; }
    .news-impact.high { background:rgba(255,69,96,0.15); color:var(--red); }
    .news-impact.medium { background:rgba(245,166,35,0.15); color:var(--yellow); }
    .news-event { flex:1; }
    .news-time { color:var(--text-dim); font-family:'Space Mono',monospace; font-size:10px; }
    .no-news { padding:14px 16px; font-size:12px; color:var(--text-dim); text-align:center; }

    /* Footer */
    .footer { text-align:center; padding:0 0 16px; }
    .footer-time { font-size:10px; color:var(--text-dim); font-family:'Space Mono',monospace; }
    .footer-src { font-size:9px; color:var(--gold-dim); font-family:'Space Mono',monospace; margin-top:2px; }

    /* Loader / Error */
    .loader { text-align:center; padding:60px 20px; color:var(--text-dim); }
    .spinner { width:36px; height:36px; border:3px solid var(--border); border-top-color:var(--gold); border-radius:50%; animation:spin 0.8s linear infinite; margin:0 auto 14px; }
    @keyframes spin { to { transform:rotate(360deg) } }
    .err { background:rgba(255,69,96,0.07); border:1px solid rgba(255,69,96,0.2); border-radius:10px; padding:14px; color:var(--red); font-size:12px; text-align:center; margin:8px; }
  </style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <div>
      <div class="logo-text">XAU Signal Desk</div>
      <div class="logo-sub">XAUUSD · H4 · M30 · M5</div>
    </div>
  </div>
  <div class="header-right">
    <div class="live-badge"><div class="live-dot" id="liveDot"></div><span id="liveText">LIVE</span></div>
    <button class="refresh-btn" onclick="loadAll()">↻</button>
  </div>
</header>

<div id="bannerClosed" class="banner banner-closed">🔒 Markedet stengt — Weekend. Åpner søndag 22:00 UTC.</div>
<div id="bannerNews" class="banner banner-news">🚫 <span id="newsText">NEWS LOCK</span></div>
<div id="bannerOverlap" class="banner banner-overlap">⚡ London–NY Overlapp aktiv — Beste handelstid</div>

<main id="main">
  <div class="loader"><div class="spinner"></div>Kobler til markedet...</div>
</main>

<script>
let refreshTimer = null;
let lastSigId = null;

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1100, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.3, ctx.currentTime + i*0.15);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i*0.15 + 0.2);
      o.start(ctx.currentTime + i*0.15);
      o.stop(ctx.currentTime + i*0.15 + 0.2);
    });
  } catch(e) {}
}

async function loadAll() {
  clearTimeout(refreshTimer);
  try {
    const [mRes, nRes] = await Promise.all([fetch('/api/market'), fetch('/api/news')]);
    const m = await mRes.json();
    const n = await nRes.json().catch(() => ({ events: [], newsLocked: false }));
    render(m, n);
    document.getElementById('liveDot').style.background = 'var(--green)';
    document.getElementById('liveText').textContent = 'LIVE';
  } catch(e) {
    document.getElementById('main').innerHTML = '<div class="err">⚠️ ' + e.message + '</div>';
    document.getElementById('liveDot').style.background = 'var(--red)';
    document.getElementById('liveText').textContent = 'FRAKOBLET';
  }
  refreshTimer = setTimeout(loadAll, 60000);
}

function render(m, n) {
  // Banners
  document.getElementById('bannerClosed').className = 'banner banner-closed' + (m.marketClosed ? ' show' : '');
  document.getElementById('bannerNews').className = 'banner banner-news' + (n.newsLocked ? ' show' : '');
  document.getElementById('bannerOverlap').className = 'banner banner-overlap' + (m.overlap ? ' show' : '');
  if (n.newsLocked) {
    const next = (n.events||[]).find(e => e.minsUntil >= -15 && e.minsUntil <= 60);
    if (next) document.getElementById('newsText').textContent = 'NEWS LOCK — ' + next.event + ' om ' + next.minsUntil + ' min';
  }

  // Alert
  const sig = m.signal;
  if (sig && sig.status === 'confirmed' && sig.id !== lastSigId) { beep(); lastSigId = sig.id; }

  document.getElementById('main').innerHTML =
    priceCard(m) +
    statsRow(m) +
    signalCard(sig, n.newsLocked) +
    zonesCard(m.zones||[], m.price) +
    historyCard(m.signalHistory||[]) +
    calcCard(sig) +
    newsCard(n.events||[]) +
    footer(m);

  calcLot(sig);
}

function priceCard(m) {
  const b = m.bias||'range';
  const bl = {bullish:'▲ BULLISH', bearish:'▼ BEARISH', range:'◆ RANGE'}[b]||b;
  return \`<div class="price-card">
    <div>
      <div class="price-label">XAU/USD · H4 BIAS · LIVE</div>
      <div class="price-val">$\${m.price||'—'}</div>
      <div class="price-meta">H \${m.high?.toFixed(2)||'—'} · L \${m.low?.toFixed(2)||'—'} · Session: \${m.session||'—'}</div>
    </div>
    <div class="bias-pill \${b}">\${bl}</div>
  </div>\`;
}

function statsRow(m) {
  const rc = m.rsi > 70 ? 'var(--red)' : m.rsi < 30 ? 'var(--green)' : 'var(--gold)';
  const rcond = m.rsi > 70 ? 'Overkjøpt' : m.rsi < 30 ? 'Oversolgt' : 'Nøytral';
  return \`<div class="stats-row">
    <div class="stat"><div class="stat-lbl">H4 EMA 50</div><div class="stat-val">$\${m.ema50||'—'}</div></div>
    <div class="stat"><div class="stat-lbl">H4 EMA 200</div><div class="stat-val">$\${m.ema200||'—'}</div></div>
    <div class="stat"><div class="stat-lbl">M5 RSI 14</div><div class="stat-val" style="color:\${rc}">\${m.rsi||'—'}</div></div>
  </div>\`;
}

function signalCard(sig, locked) {
  let body = '';
  if (!sig) {
    body = \`<div class="no-signal">⏳ Ingen aktive signal<br><span style="font-size:10px;color:#333">Overvåker H4 · M30 · M5...</span></div>\`;
  } else {
    const q = sig.quality||0;
    const qc = q>=70?'var(--green)':q>=50?'var(--yellow)':'var(--red)';
    const lp = sig.livePips !== undefined ? sig.livePips : 0;
    const lpClass = lp >= 0 ? 'pips-pos' : 'pips-neg';
    body = \`
      <div class="sig-top">
        <div class="dir-badge \${sig.direction}">\${sig.direction.toUpperCase()}</div>
        <div class="status-badge \${sig.status}">\${sig.status.toUpperCase()}</div>
        \${locked ? '<span style="font-size:10px;color:var(--red)">🚫 NEWS</span>' : ''}
      </div>
      <div class="sig-grid">
        <div class="sig-item"><div class="sig-item-lbl">ENTRY</div><div class="sig-item-val">$\${sig.entry}</div></div>
        <div class="sig-item"><div class="sig-item-lbl">LIVE PIPS</div><div class="sig-item-val \${lpClass}">\${lp>=0?'+':''}\${lp}</div></div>
        <div class="sig-item"><div class="sig-item-lbl">STOP LOSS</div><div class="sig-item-val sl">$\${sig.stopLoss}</div></div>
        <div class="sig-item"><div class="sig-item-lbl">TAKE PROFIT</div><div class="sig-item-val tp">$\${sig.takeProfit}</div></div>
        <div class="sig-item"><div class="sig-item-lbl">RISK/REWARD</div><div class="sig-item-val rr">\${sig.riskReward}</div></div>
        <div class="sig-item"><div class="sig-item-lbl">M5 MØNSTER</div><div class="sig-item-val" style="font-size:11px">\${sig.m5Pattern}</div></div>
      </div>
      <div class="quality-wrap">
        <div class="quality-top"><span>SIGNAL QUALITY</span><span style="color:\${qc}">\${q}/100</span></div>
        <div class="quality-bar"><div class="quality-fill" style="width:\${q}%;background:\${qc}"></div></div>
      </div>
      <div class="reasoning">💡 \${sig.reasoning||''}</div>
    \`;
  }
  return \`<div class="signal-card">
    <div class="card-header">
      <span class="card-title">AKTIVT SIGNAL</span>
      \${sig?'<span style="font-size:9px;font-family:monospace;color:'+(sig.direction==='buy'?'var(--green)':'var(--red)')+'">● XAUUSD</span>':''}
    </div>
    <div class="card-body">\${body}</div>
  </div>\`;
}

function zonesCard(zones, price) {
  if (!zones.length) return '';
  const rows = zones.slice(0,6).map(z => {
    const dist = price ? (price - z.price).toFixed(2) : '—';
    const sign = dist > 0 ? '+' : '';
    return \`<div class="zone-row">
      <div class="zone-left">
        <div class="zone-dot \${z.type}"></div>
        <div>
          <div class="zone-type-lbl">\${z.type==='support'?'STØTTE':'MOTSTAND'}</div>
          <div class="zone-price-lbl">$\${z.price.toFixed(2)}</div>
        </div>
      </div>
      <div class="zone-right">
        <div class="zone-dist">\${sign}$\${dist}</div>
        <div class="zone-touches">\${z.touches} touches</div>
      </div>
    </div>\`;
  }).join('');
  return \`<div class="zones-card">
    <div class="card-header"><span class="card-title">STØTTE & MOTSTAND · M30</span></div>
    \${rows}
  </div>\`;
}

function historyCard(history) {
  if (!history.length) return '';
  const tp = history.filter(s=>s.outcome==='tp_hit').length;
  const sl = history.filter(s=>s.outcome==='sl_hit').length;
  const wr = tp+sl>0 ? Math.round(tp/(tp+sl)*100) : 0;
  const rows = history.map(s => {
    const dir = s.direction==='buy'
      ? '<span style="color:var(--green)">▲ BUY</span>'
      : '<span style="color:var(--red)">▼ SELL</span>';
    let outcome = '<span class="outcome-open">● OPEN</span>';
    if (s.outcome==='tp_hit') outcome = '<span class="outcome-tp">✓ TP</span>';
    if (s.outcome==='sl_hit') outcome = '<span class="outcome-sl">✗ SL</span>';
    const pipClass = s.pips&&s.pips.startsWith('+') ? 'pip-pos' : 'pip-neg';
    const t = new Date(s.createdAt).toLocaleString('no-NO',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    return \`<tr>
      <td>\${t}</td>
      <td>\${dir}</td>
      <td>$\${s.entry}</td>
      <td style="color:var(--red)">$\${s.stopLoss}</td>
      <td style="color:var(--green)">$\${s.takeProfit}</td>
      <td>\${outcome}</td>
      <td>$\${s.closedAt||'—'}</td>
      <td class="\${pipClass}">\${s.pips||'—'}</td>
    </tr>\`;
  }).join('');
  return \`<div class="history-card">
    <div class="card-header">
      <span class="card-title">SIGNAL HISTORIKK</span>
      <div class="history-stats">
        <span class="outcome-tp">\${tp} TP</span>
        <span class="outcome-sl">\${sl} SL</span>
        <span style="color:var(--gold)">\${wr}% Win</span>
      </div>
    </div>
    <div style="overflow-x:auto">
      <table>
        <tr><th>TID</th><th>DIR</th><th>ENTRY</th><th>SL</th><th>TP</th><th>UTFALL</th><th>CLOSE</th><th>PIPS</th></tr>
        \${rows}
      </table>
    </div>
  </div>\`;
}

function calcCard(sig) {
  return \`<div class="calc-card">
    <div class="card-header"><span class="card-title">RISIKOKALKULATOR</span></div>
    <div class="calc-grid">
      <div><div class="calc-lbl">KONTO ($)</div><input class="calc-input" id="cBal" type="number" value="10000" oninput="calcLot()"></div>
      <div><div class="calc-lbl">RISIKO (%)</div><input class="calc-input" id="cRisk" type="number" value="1" step="0.1" oninput="calcLot()"></div>
      <div><div class="calc-lbl">SL (pips)</div><input class="calc-input" id="cSL" type="number" value="80" oninput="calcLot()"></div>
      <div><div class="calc-lbl">PIP-VERDI ($)</div><input class="calc-input" id="cPip" type="number" value="1" step="0.1" oninput="calcLot()"></div>
    </div>
    <div class="calc-result">
      <span style="font-size:10px;color:var(--gold-dim);font-family:monospace">LOT-STØRRELSE</span>
      <span class="calc-result-val" id="cRes">0.13 lot</span>
    </div>
  </div>\`;
}

function newsCard(events) {
  if (!events.length) {
    return \`<div class="news-card">
      <div class="card-header"><span class="card-title">NYHETSKALENDER · USD</span></div>
      <div class="no-news">Ingen high/medium-impact USD-nyheter i dag</div>
    </div>\`;
  }
  const rows = events.map(e => {
    const t = e.minsUntil >= 0 ? 'om ' + e.minsUntil + ' min' : Math.abs(e.minsUntil) + ' min siden';
    return \`<div class="news-row">
      <span class="news-impact \${(e.impact||'').toLowerCase()}">\${(e.impact||'').toUpperCase()}</span>
      <span class="news-event">\${e.event}</span>
      <span class="news-time">\${t}</span>
    </div>\`;
  }).join('');
  return \`<div class="news-card">
    <div class="card-header"><span class="card-title">NYHETSKALENDER · USD</span></div>
    \${rows}
  </div>\`;
}

function footer(m) {
  return \`<div class="footer">
    <div class="footer-time">Oppdatert: \${new Date().toLocaleTimeString('no-NO')} · Auto-refresh 60s</div>
    <div class="footer-src">\${m.dataSource||'Twelve Data · H4 + M30 + M5'}</div>
  </div>\`;
}

function calcLot(sig) {
  if (sig && sig.stopLoss && sig.entry) {
    const el = document.getElementById('cSL');
    if (el) el.value = Math.round(Math.abs(sig.entry - sig.stopLoss) * 10);
  }
  const bal = parseFloat(document.getElementById('cBal')?.value)||10000;
  const risk = parseFloat(document.getElementById('cRisk')?.value)||1;
  const sl = parseFloat(document.getElementById('cSL')?.value)||80;
  const pip = parseFloat(document.getElementById('cPip')?.value)||1;
  const lot = sl > 0 ? (bal * risk/100) / (sl * pip * 100) : 0;
  const el = document.getElementById('cRes');
  if (el) el.textContent = lot.toFixed(2) + ' lot';
}

loadAll();
</script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`XAU Signal Desk kjører på port ${PORT}`));
