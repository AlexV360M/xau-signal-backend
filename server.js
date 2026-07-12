const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const METAAPI_ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

const BASE_URL = `https://mt-market-data-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${METAAPI_ACCOUNT_ID}`;

// ── State ──────────────────────────────────────────────────────────────────
let activeSignal = null;
let signalHistory = [];

// ── Helpers ────────────────────────────────────────────────────────────────
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

function detectZones(candles) {
  const zones = [];
  const lookback = 5;
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const maxHigh = Math.max(...slice.map(c => c.high));
    const minLow = Math.min(...slice.map(c => c.low));
    if (candles[i].high === maxHigh) {
      zones.push({ type: 'resistance', price: candles[i].high, index: i });
    }
    if (candles[i].low === minLow) {
      zones.push({ type: 'support', price: candles[i].low, index: i });
    }
  }
  const merged = [];
  for (const z of zones) {
    const existing = merged.find(m => m.type === z.type && Math.abs(m.price - z.price) < 2.0);
    if (existing) {
      existing.touches = (existing.touches || 1) + 1;
      existing.price = (existing.price + z.price) / 2;
    } else {
      merged.push({ ...z, touches: 1 });
    }
  }
  return merged.sort((a, b) => b.touches - a.touches).slice(0, 8);
}

function isPinBar(candle) {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (range === 0) return false;
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return (lowerWick > body * 2 && lowerWick > range * 0.6) ||
         (upperWick > body * 2 && upperWick > range * 0.6);
}

function isEngulfing(prev, curr) {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  const bullish = curr.close > curr.open && prev.close < prev.open &&
                  curr.open <= prev.close && curr.close >= prev.open;
  const bearish = curr.close < curr.open && prev.close > prev.open &&
                  curr.open >= prev.close && curr.close <= prev.open;
  return (bullish || bearish) && currBody > prevBody;
}

function isLondonNYOverlap() {
  const utcHour = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  return utcHour >= 12 && utcHour <= 16;
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (day === 6) return false;
  if (day === 0 && hour < 22) return false;
  if (day === 5 && hour >= 22) return false;
  return true;
}

function calcSignalQuality(h4Bias, zone, m5Pattern, rsi, overlap) {
  let score = 0;
  // H4 trend strength (max 25)
  score += Math.min(25, Math.round(25 * 0.7));
  // M30 zone touches (max 20)
  score += Math.min(20, (zone.touches || 1) * 4);
  // M5 pattern (max 30)
  if (m5Pattern === 'pin_bar') score += 25;
  else if (m5Pattern === 'engulfing') score += 30;
  else if (m5Pattern === 'rsi_divergence') score += 20;
  else score += 0;
  // RSI positioning (max 15)
  if (rsi < 35 || rsi > 65) score += 15;
  else if (rsi < 45 || rsi > 55) score += 8;
  else score += 0;
  // Session overlap (max 10)
  if (overlap) score += 10;
  return Math.min(100, score);
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

// ── MetaApi fetch ──────────────────────────────────────────────────────────
async function fetchCandles(timeframe, limit = 150) {
  const url = `${BASE_URL}/historical-market-data/symbols/XAUUSD/timeframes/${timeframe}/candles?limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'auth-token': METAAPI_TOKEN, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`MetaApi ${res.status} for ${timeframe}`);
  const data = await res.json();
  // MetaApi returns newest first — reverse to oldest first
  return data.reverse().map(c => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  }));
}

// ── Main analysis ──────────────────────────────────────────────────────────
async function analyzeMarket() {
  if (!isMarketOpen()) {
    return { marketClosed: true, message: 'Weekend — market closed' };
  }

  // Fetch all three timeframes from MetaApi (same prices as your MT5 chart)
  const [h4Candles, m30Candles, m5Candles] = await Promise.all([
    fetchCandles('H4', 200),
    fetchCandles('M30', 150),
    fetchCandles('M5', 50)
  ]);

  // H4 — Direction
  const h4Closes = h4Candles.map(c => c.close);
  const ema50_h4 = calcEMA(h4Closes, 50);
  const ema200_h4 = calcEMA(h4Closes, 200);
  const h4Bias = ema50_h4 > ema200_h4 ? 'bullish' : 'bearish';
  const lastH4 = h4Candles[h4Candles.length - 1];

  // M30 — Support & Resistance zones
  const zones = detectZones(m30Candles);
  const lastM30 = m30Candles[m30Candles.length - 1];
  const currentPrice = lastM30.close;

  // M5 — Entry confirmation
  const m5Closes = m5Candles.map(c => c.close);
  const rsi_m5 = calcRSI(m5Closes, 14);
  const lastM5 = m5Candles[m5Candles.length - 1];
  const prevM5 = m5Candles[m5Candles.length - 2];

  let m5Pattern = null;
  if (isPinBar(lastM5)) m5Pattern = 'pin_bar';
  else if (prevM5 && isEngulfing(prevM5, lastM5)) m5Pattern = 'engulfing';

  const overlap = isLondonNYOverlap();
  const zoneBuffer = 2.0;

  // Check if active signal should be closed
  if (activeSignal) {
    const p = currentPrice;
    if (activeSignal.direction === 'buy') {
      if (p >= activeSignal.takeProfit) {
        const pips = ((activeSignal.takeProfit - activeSignal.entry) * 10).toFixed(1);
        activeSignal.status = 'tp_hit';
        activeSignal.closedAt = activeSignal.takeProfit;
        activeSignal.pips = `+${pips}`;
        signalHistory.unshift({ ...activeSignal });
        await sendTelegram(
          `✅ <b>XAU SIGNAL — TP HIT</b>\nDirection: BUY\nEntry: $${activeSignal.entry}\nClose: $${activeSignal.takeProfit}\nPips: +${pips} pips`
        );
        activeSignal = null;
      } else if (p <= activeSignal.stopLoss) {
        const pips = ((activeSignal.entry - activeSignal.stopLoss) * 10).toFixed(1);
        activeSignal.status = 'sl_hit';
        activeSignal.closedAt = activeSignal.stopLoss;
        activeSignal.pips = `-${pips}`;
        signalHistory.unshift({ ...activeSignal });
        await sendTelegram(
          `❌ <b>XAU SIGNAL — SL HIT</b>\nDirection: BUY\nEntry: $${activeSignal.entry}\nClose: $${activeSignal.stopLoss}\nPips: -${pips} pips`
        );
        activeSignal = null;
      }
    } else if (activeSignal.direction === 'sell') {
      if (p <= activeSignal.takeProfit) {
        const pips = ((activeSignal.entry - activeSignal.takeProfit) * 10).toFixed(1);
        activeSignal.status = 'tp_hit';
        activeSignal.closedAt = activeSignal.takeProfit;
        activeSignal.pips = `+${pips}`;
        signalHistory.unshift({ ...activeSignal });
        await sendTelegram(
          `✅ <b>XAU SIGNAL — TP HIT</b>\nDirection: SELL\nEntry: $${activeSignal.entry}\nClose: $${activeSignal.takeProfit}\nPips: +${pips} pips`
        );
        activeSignal = null;
      } else if (p >= activeSignal.stopLoss) {
        const pips = ((activeSignal.stopLoss - activeSignal.entry) * 10).toFixed(1);
        activeSignal.status = 'sl_hit';
        activeSignal.closedAt = activeSignal.stopLoss;
        activeSignal.pips = `-${pips}`;
        signalHistory.unshift({ ...activeSignal });
        await sendTelegram(
          `❌ <b>XAU SIGNAL — SL HIT</b>\nDirection: SELL\nEntry: $${activeSignal.entry}\nClose: $${activeSignal.stopLoss}\nPips: -${pips} pips`
        );
        activeSignal = null;
      }
    }
  }

  // Generate new signal only if no active signal
  if (!activeSignal) {
    for (const zone of zones) {
      const inZone = Math.abs(currentPrice - zone.price) <= zoneBuffer;
      if (!inZone) continue;

      if (zone.type === 'support' && h4Bias === 'bullish') {
        const sl = parseFloat((zone.price - zoneBuffer * 2).toFixed(2));
        const tp = parseFloat((currentPrice + (currentPrice - sl) * 2).toFixed(2));
        const quality = calcSignalQuality(h4Bias, zone, m5Pattern, rsi_m5, overlap);
        const status = m5Pattern ? 'confirmed' : 'armed';

        activeSignal = {
          id: Date.now(),
          createdAt: new Date().toISOString(),
          direction: 'buy',
          status,
          entry: parseFloat(currentPrice.toFixed(2)),
          stopLoss: sl,
          takeProfit: tp,
          riskReward: '1:2',
          zone: zone.price,
          m5Pattern: m5Pattern || 'scanning',
          m5Rsi: rsi_m5,
          overlap,
          quality,
          reasoning: `Pris i støttesone $${zone.price.toFixed(2)}, H4 bullish bias, ${m5Pattern || 'venter på M5-bekreftelse'}`
        };

        if (status === 'confirmed') {
          await sendTelegram(
            `🚨 <b>XAU SIGNAL CONFIRMED</b>\n` +
            `Direction: BUY ▲\n` +
            `Entry: $${activeSignal.entry}\n` +
            `Stop Loss: $${activeSignal.stopLoss}\n` +
            `Take Profit: $${activeSignal.takeProfit}\n` +
            `Risk/Reward: 1:2\n` +
            `M5 Pattern: ${m5Pattern}\n` +
            `Quality: ${quality}/100\n` +
            `Bias: BULLISH`
          );
        }
        break;
      }

      if (zone.type === 'resistance' && h4Bias === 'bearish') {
        const sl = parseFloat((zone.price + zoneBuffer * 2).toFixed(2));
        const tp = parseFloat((currentPrice - (sl - currentPrice) * 2).toFixed(2));
        const quality = calcSignalQuality(h4Bias, zone, m5Pattern, rsi_m5, overlap);
        const status = m5Pattern ? 'confirmed' : 'armed';

        activeSignal = {
          id: Date.now(),
          createdAt: new Date().toISOString(),
          direction: 'sell',
          status,
          entry: parseFloat(currentPrice.toFixed(2)),
          stopLoss: sl,
          takeProfit: tp,
          riskReward: '1:2',
          zone: zone.price,
          m5Pattern: m5Pattern || 'scanning',
          m5Rsi: rsi_m5,
          overlap,
          quality,
          reasoning: `Pris i motstandssone $${zone.price.toFixed(2)}, H4 bearish bias, ${m5Pattern || 'venter på M5-bekreftelse'}`
        };

        if (status === 'confirmed') {
          await sendTelegram(
            `🚨 <b>XAU SIGNAL CONFIRMED</b>\n` +
            `Direction: SELL ▼\n` +
            `Entry: $${activeSignal.entry}\n` +
            `Stop Loss: $${activeSignal.stopLoss}\n` +
            `Take Profit: $${activeSignal.takeProfit}\n` +
            `Risk/Reward: 1:2\n` +
            `M5 Pattern: ${m5Pattern}\n` +
            `Quality: ${quality}/100\n` +
            `Bias: BEARISH`
          );
        }
        break;
      }
    }
  }

  return {
    symbol: 'XAUUSD',
    price: parseFloat(currentPrice.toFixed(2)),
    open: lastM30.open,
    high: lastM30.high,
    low: lastM30.low,
    ema50: ema50_h4,
    ema200: ema200_h4,
    rsi: rsi_m5,
    bias: h4Bias,
    zones,
    signal: activeSignal,
    signalHistory: signalHistory.slice(0, 20),
    overlap,
    marketClosed: false,
    dataSource: 'MetaApi (MT5)',
    updatedAt: new Date().toISOString()
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/api/market', async (req, res) => {
  try {
    if (!METAAPI_TOKEN || !METAAPI_ACCOUNT_ID) {
      return res.status(500).json({ error: 'METAAPI_TOKEN og METAAPI_ACCOUNT_ID mangler i Secrets' });
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
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${tomorrow}&token=${NEWS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    const relevant = (data.economicCalendar || []).filter(e =>
      ['USD', 'XAU', 'US'].includes(e.country) &&
      ['high', 'medium'].includes((e.impact || '').toLowerCase())
    ).map(e => ({
      time: e.time,
      event: e.event,
      country: e.country,
      impact: e.impact,
      minsUntil: Math.round((new Date(e.time) - Date.now()) / 60000)
    }));
    const newsLocked = relevant.some(e => e.minsUntil >= 0 && e.minsUntil <= 60);
    res.json({ events: relevant, newsLocked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test-telegram', async (req, res) => {
  await sendTelegram('🔔 <b>XAU Signal Desk</b>\nTelegram-tilkobling fungerer! ✅');
  res.json({ sent: true });
});

// ── Serve dashboard ────────────────────────────────────────────────────────
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
    :root{--gold:#D4AF37;--gold-dim:#8a7020;--gold-glow:rgba(212,175,55,0.15);--bg:#0a0a0b;--bg-card:#111114;--bg-card2:#16161a;--border:#222228;--text:#e8e8f0;--text-dim:#666675;--green:#00c896;--green-glow:rgba(0,200,150,0.12);--red:#ff4560;--red-glow:rgba(255,69,96,0.12);--yellow:#f5a623;}
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:var(--bg);color:var(--text);font-family:'Space Grotesk',sans-serif;min-height:100vh;}
    header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);background:var(--bg-card);position:sticky;top:0;z-index:100;}
    .logo{display:flex;align-items:center;gap:10px;}
    .logo-icon{width:34px;height:34px;background:var(--gold);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;}
    .logo-text{font-size:17px;font-weight:700;}
    .logo-sub{font-size:11px;color:var(--text-dim);font-family:'Space Mono',monospace;}
    .header-right{display:flex;align-items:center;gap:10px;}
    .live-dot{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);font-family:'Space Mono',monospace;}
    .dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse-dot 2s infinite;}
    @keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:0.4}}
    .refresh-btn{background:var(--bg-card2);border:1px solid var(--border);color:var(--gold);padding:6px 12px;border-radius:6px;font-size:12px;font-family:'Space Mono',monospace;cursor:pointer;}
    .banner{padding:10px 16px;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:500;display:none;margin:12px 16px 0;}
    .banner.show{display:flex;}
    .banner.closed{background:rgba(74,158,255,0.1);border:1px solid rgba(74,158,255,0.3);color:#4a9eff;border-radius:8px;}
    .banner.news{background:rgba(255,69,96,0.1);border:1px solid rgba(255,69,96,0.3);color:var(--red);border-radius:8px;}
    .banner.overlap{background:rgba(245,166,35,0.1);border:1px solid rgba(245,166,35,0.3);color:var(--yellow);border-radius:8px;}
    main{padding:16px;display:flex;flex-direction:column;gap:14px;}
    .price-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;}
    .price-value{font-size:36px;font-weight:700;color:var(--gold);font-family:'Space Mono',monospace;letter-spacing:-1px;}
    .price-label{font-size:11px;color:var(--text-dim);font-family:'Space Mono',monospace;letter-spacing:1px;margin-bottom:4px;}
    .price-meta{margin-top:6px;font-size:12px;color:var(--text-dim);font-family:'Space Mono',monospace;}
    .bias-badge{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-family:'Space Mono',monospace;}
    .bias-badge.bullish{background:var(--green-glow);color:var(--green);border:1px solid rgba(0,200,150,0.3);}
    .bias-badge.bearish{background:var(--red-glow);color:var(--red);border:1px solid rgba(255,69,96,0.3);}
    .stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
    .stat-card{background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;text-align:center;}
    .stat-label{font-size:10px;color:var(--text-dim);font-family:'Space Mono',monospace;margin-bottom:4px;}
    .stat-value{font-size:18px;font-weight:700;font-family:'Space Mono',monospace;color:var(--gold);}
    .signal-card{background:var(--bg-card);border-radius:12px;overflow:hidden;border:1px solid var(--border);}
    .signal-header{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);}
    .signal-title{font-size:12px;font-family:'Space Mono',monospace;color:var(--text-dim);letter-spacing:1px;}
    .signal-body{padding:18px;}
    .no-signal{text-align:center;color:var(--text-dim);font-size:14px;padding:20px 0;}
    .signal-dir-badge{padding:10px 22px;border-radius:8px;font-size:20px;font-weight:700;font-family:'Space Mono',monospace;letter-spacing:2px;}
    .signal-dir-badge.buy{background:var(--green-glow);color:var(--green);border:1px solid rgba(0,200,150,0.4);}
    .signal-dir-badge.sell{background:var(--red-glow);color:var(--red);border:1px solid rgba(255,69,96,0.4);}
    .signal-status-badge{padding:6px 12px;border-radius:6px;font-size:11px;font-weight:700;font-family:'Space Mono',monospace;letter-spacing:1px;}
    .signal-status-badge.confirmed{background:var(--green-glow);color:var(--green);border:1px solid rgba(0,200,150,0.3);animation:pulse-glow 1.5s infinite;}
    .signal-status-badge.armed{background:rgba(245,166,35,0.1);color:var(--yellow);border:1px solid rgba(245,166,35,0.3);}
    @keyframes pulse-glow{0%,100%{box-shadow:0 0 0 0 rgba(0,200,150,0)}50%{box-shadow:0 0 12px 4px rgba(0,200,150,0.2)}}
    .signal-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0;}
    .signal-item{background:var(--bg-card2);border-radius:8px;padding:10px 12px;}
    .signal-item-label{font-size:10px;color:var(--text-dim);font-family:'Space Mono',monospace;margin-bottom:3px;}
    .signal-item-value{font-size:15px;font-weight:600;font-family:'Space Mono',monospace;}
    .signal-item-value.sl{color:var(--red);}
    .signal-item-value.tp{color:var(--green);}
    .signal-item-value.rr{color:var(--gold);font-size:18px;}
    .quality-bar{background:var(--bg-card2);border-radius:8px;padding:12px;margin-top:10px;}
    .quality-label{font-size:10px;color:var(--text-dim);font-family:'Space Mono',monospace;margin-bottom:6px;}
    .quality-track{height:6px;background:var(--border);border-radius:3px;overflow:hidden;}
    .quality-fill{height:100%;border-radius:3px;transition:width 0.5s;}
    .reasoning{background:var(--bg-card2);border-radius:8px;padding:12px;font-size:12px;color:var(--text-dim);line-height:1.5;margin-top:10px;}
    .zones-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
    .zones-header{padding:14px 18px;border-bottom:1px solid var(--border);font-size:12px;font-family:'Space Mono',monospace;color:var(--text-dim);letter-spacing:1px;}
    .zone-item{display:flex;align-items:center;justify-content:space-between;padding:11px 18px;border-bottom:1px solid var(--border);}
    .zone-item:last-child{border-bottom:none;}
    .zone-dot{width:8px;height:8px;border-radius:50%;margin-right:10px;}
    .zone-dot.support{background:var(--green);}
    .zone-dot.resistance{background:var(--red);}
    .zone-type{font-size:11px;color:var(--text-dim);font-family:'Space Mono',monospace;text-transform:uppercase;}
    .zone-price{font-size:15px;font-weight:600;font-family:'Space Mono',monospace;}
    .history-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
    .history-header{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;}
    .history-title{font-size:12px;font-family:'Space Mono',monospace;color:var(--text-dim);letter-spacing:1px;}
    .history-stats{display:flex;gap:12px;font-size:11px;font-family:'Space Mono',monospace;}
    table{width:100%;border-collapse:collapse;font-size:12px;}
    th{padding:8px 12px;text-align:left;color:var(--text-dim);font-family:'Space Mono',monospace;font-size:10px;border-bottom:1px solid var(--border);}
    td{padding:10px 12px;border-bottom:1px solid var(--border);font-family:'Space Mono',monospace;}
    .tp-hit{color:var(--green);}
    .sl-hit{color:var(--red);}
    .open-badge{color:var(--yellow);}
    .pips-pos{color:var(--green);}
    .pips-neg{color:var(--red);}
    .calc-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px;}
    .calc-header{padding:14px 18px;border-bottom:1px solid var(--border);font-size:12px;font-family:'Space Mono',monospace;color:var(--text-dim);letter-spacing:1px;}
    .calc-body{padding:16px 18px;}
    .calc-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}
    .calc-label{font-size:10px;color:var(--text-dim);font-family:'Space Mono',monospace;margin-bottom:5px;}
    .calc-input{background:var(--bg-card2);border:1px solid var(--border);border-radius:7px;padding:10px 12px;color:var(--text);font-family:'Space Mono',monospace;font-size:14px;width:100%;}
    .calc-input:focus{outline:none;border-color:var(--gold);}
    .calc-result{background:var(--gold-glow);border:1px solid rgba(212,175,55,0.2);border-radius:8px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;}
    .calc-result-value{font-size:20px;font-weight:700;color:var(--gold);font-family:'Space Mono',monospace;}
    .last-updated{text-align:center;font-size:10px;color:var(--text-dim);font-family:'Space Mono',monospace;padding-bottom:8px;}
    .data-source{text-align:center;font-size:10px;color:var(--gold-dim);font-family:'Space Mono',monospace;padding-bottom:16px;}
    .loading{text-align:center;padding:60px 20px;color:var(--text-dim);}
    .loading-spinner{width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px;}
    @keyframes spin{to{transform:rotate(360deg)}}
    .error-msg{background:rgba(255,69,96,0.08);border:1px solid rgba(255,69,96,0.2);border-radius:10px;padding:16px;color:var(--red);font-size:13px;text-align:center;}
  </style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <div>
      <div class="logo-text">XAU Signal Desk</div>
      <div class="logo-sub">XAUUSD · MetaTrader · Live</div>
    </div>
  </div>
  <div class="header-right">
    <div class="live-dot"><div class="dot" id="liveDot"></div><span id="liveText">LIVE</span></div>
    <button class="refresh-btn" onclick="loadData()">↻ REFRESH</button>
  </div>
</header>

<div id="closedBanner" class="banner closed">🔒 Market Closed — Weekend. No new signals.</div>
<div id="newsBanner" class="banner news">🚫 <span id="newsText">NEWS LOCK</span></div>
<div id="overlapBanner" class="banner overlap">⚡ London–NY Overlap — Økt volatilitet</div>

<main id="mainContent">
  <div class="loading"><div class="loading-spinner"></div>Kobler til MetaTrader...</div>
</main>

<script>
const REFRESH_INTERVAL = 60000;
let refreshTimer = null;
let lastSignalId = null;

function playAlert() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1100, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq; osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.2);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.2);
    });
  } catch(e) {}
}

async function loadData() {
  if (refreshTimer) clearTimeout(refreshTimer);
  try {
    const [mRes, nRes] = await Promise.all([fetch('/api/market'), fetch('/api/news')]);
    const market = await mRes.json();
    const news = await nRes.json().catch(() => ({ events: [], newsLocked: false }));
    render(market, news);
    document.getElementById('liveDot').style.background = 'var(--green)';
    document.getElementById('liveText').textContent = 'LIVE';
  } catch(err) {
    document.getElementById('mainContent').innerHTML = '<div class="error-msg">⚠️ ' + err.message + '</div>';
    document.getElementById('liveDot').style.background = 'var(--red)';
    document.getElementById('liveText').textContent = 'FRAKOBLET';
  }
  refreshTimer = setTimeout(loadData, REFRESH_INTERVAL);
}

function render(m, news) {
  document.getElementById('closedBanner').className = 'banner closed' + (m.marketClosed ? ' show' : '');
  document.getElementById('newsBanner').className = 'banner news' + (news.newsLocked ? ' show' : '');
  document.getElementById('overlapBanner').className = 'banner overlap' + (m.overlap ? ' show' : '');

  const sig = m.signal;
  if (sig && sig.status === 'confirmed' && sig.id !== lastSignalId) {
    playAlert(); lastSignalId = sig.id;
  }

  document.getElementById('mainContent').innerHTML =
    renderPrice(m) + renderStats(m) + renderSignal(sig, news.newsLocked) +
    renderZones(m.zones || [], m.price) + renderHistory(m.signalHistory || []) +
    renderCalc(sig) +
    '<div class="last-updated">Sist oppdatert: ' + new Date().toLocaleTimeString('no-NO') + '</div>' +
    '<div class="data-source">📊 Data: MetaApi · Samme priser som MetaTrader</div>';

  calcLot(sig);
}

function renderPrice(m) {
  const bias = m.bias || 'range';
  const biasLabel = { bullish: '▲ BULLISH', bearish: '▼ BEARISH', range: '◆ RANGE' }[bias] || bias.toUpperCase();
  return '<div class="price-card"><div><div class="price-label">XAU/USD · H4 BIAS · MT5</div>' +
    '<div class="price-value">$' + (m.price || '—') + '</div>' +
    '<div class="price-meta">H ' + (m.high?.toFixed(2)||'—') + ' · L ' + (m.low?.toFixed(2)||'—') + '</div></div>' +
    '<div class="bias-badge ' + bias + '">' + biasLabel + '</div></div>';
}

function renderStats(m) {
  const rsiColor = m.rsi > 70 ? 'var(--red)' : m.rsi < 30 ? 'var(--green)' : 'var(--gold)';
  return '<div class="stats-row">' +
    '<div class="stat-card"><div class="stat-label">H4 EMA 50</div><div class="stat-value">$' + (m.ema50||'—') + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">H4 EMA 200</div><div class="stat-value">$' + (m.ema200||'—') + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">M5 RSI 14</div><div class="stat-value" style="color:' + rsiColor + '">' + (m.rsi||'—') + '</div></div>' +
    '</div>';
}

function renderSignal(sig, locked) {
  let body = '';
  if (!sig) {
    body = '<div class="no-signal">📊 Ingen aktive signal<br><span style="font-size:11px;color:#444">Systemet overvåker H4 · M30 · M5...</span></div>';
  } else {
    const q = sig.quality || 0;
    const qColor = q >= 70 ? 'var(--green)' : q >= 50 ? 'var(--yellow)' : 'var(--red)';
    body = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">' +
      '<div class="signal-dir-badge ' + sig.direction + '">' + sig.direction.toUpperCase() + '</div>' +
      '<div class="signal-status-badge ' + sig.status + '">' + sig.status.toUpperCase() + '</div>' +
      (locked ? '<span style="font-size:11px;color:var(--red)">🚫 NEWS</span>' : '') + '</div>' +
      '<div class="signal-grid">' +
      '<div class="signal-item"><div class="signal-item-label">ENTRY</div><div class="signal-item-value">$' + sig.entry + '</div></div>' +
      '<div class="signal-item"><div class="signal-item-label">RISK/REWARD</div><div class="signal-item-value rr">' + sig.riskReward + '</div></div>' +
      '<div class="signal-item"><div class="signal-item-label">STOP LOSS</div><div class="signal-item-value sl">$' + sig.stopLoss + '</div></div>' +
      '<div class="signal-item"><div class="signal-item-label">TAKE PROFIT</div><div class="signal-item-value tp">$' + sig.takeProfit + '</div></div>' +
      '</div>' +
      '<div class="quality-bar"><div class="quality-label">SIGNAL QUALITY: ' + q + '/100</div>' +
      '<div class="quality-track"><div class="quality-fill" style="width:' + q + '%;background:' + qColor + '"></div></div></div>' +
      '<div class="reasoning">💡 ' + (sig.reasoning || '') + '</div>';
  }
  return '<div class="signal-card"><div class="signal-header"><span class="signal-title">AKTIVT SIGNAL</span>' +
    (sig ? '<span style="font-size:10px;font-family:monospace;color:' + (sig.direction==='buy'?'var(--green)':'var(--red)') + '">● XAUUSD</span>' : '') +
    '</div><div class="signal-body">' + body + '</div></div>';
}

function renderZones(zones, price) {
  if (!zones.length) return '';
  return '<div class="zones-card"><div class="zones-header">STØTTE & MOTSTAND · M30</div>' +
    zones.slice(0, 6).map(z => {
      const dist = price ? (price - z.price).toFixed(2) : '—';
      const sign = dist > 0 ? '+' : '';
      return '<div class="zone-item"><div style="display:flex;align-items:center">' +
        '<div class="zone-dot ' + z.type + '"></div><div>' +
        '<div class="zone-type">' + (z.type === 'support' ? 'STØTTE' : 'MOTSTAND') + '</div>' +
        '<div class="zone-price">$' + z.price.toFixed(2) + '</div></div></div>' +
        '<div style="text-align:right"><div style="font-size:11px;color:var(--text-dim);font-family:monospace">' + sign + '$' + dist + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim);font-family:monospace">' + (z.touches||1) + ' touches</div></div></div>';
    }).join('') + '</div>';
}

function renderHistory(history) {
  if (!history.length) return '';
  const tp = history.filter(s => s.status === 'tp_hit').length;
  const sl = history.filter(s => s.status === 'sl_hit').length;
  const wr = tp + sl > 0 ? Math.round(tp / (tp + sl) * 100) : 0;
  return '<div class="history-card"><div class="history-header"><span class="history-title">SIGNAL HISTORIKK</span>' +
    '<div class="history-stats"><span class="tp-hit">' + tp + ' TP</span><span class="sl-hit">' + sl + ' SL</span><span style="color:var(--gold)">' + wr + '% Win</span></div></div>' +
    '<div style="overflow-x:auto"><table><tr><th>TID</th><th>DIR</th><th>ENTRY</th><th>SL</th><th>TP</th><th>UTFALL</th><th>CLOSE</th><th>PIPS</th></tr>' +
    history.map(s => {
      const dir = s.direction === 'buy' ? '<span style="color:var(--green)">▲ BUY</span>' : '<span style="color:var(--red)">▼ SELL</span>';
      const outcome = s.status === 'tp_hit' ? '<span class="tp-hit">✓ TP HIT</span>' : s.status === 'sl_hit' ? '<span class="sl-hit">✗ SL HIT</span>' : '<span class="open-badge">● OPEN</span>';
      const pipsClass = s.pips && s.pips.startsWith('+') ? 'pips-pos' : 'pips-neg';
      const time = new Date(s.createdAt).toLocaleString('no-NO', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
      return '<tr><td>' + time + '</td><td>' + dir + '</td><td>$' + s.entry + '</td><td style="color:var(--red)">$' + s.stopLoss + '</td><td style="color:var(--green)">$' + s.takeProfit + '</td><td>' + outcome + '</td><td>$' + (s.closedAt || '—') + '</td><td class="' + pipsClass + '">' + (s.pips || '—') + '</td></tr>';
    }).join('') + '</table></div></div>';
}

function renderCalc(sig) {
  return '<div class="calc-card"><div class="calc-header">RISIKOKALKULATOR</div><div class="calc-body">' +
    '<div class="calc-row">' +
    '<div><div class="calc-label">KONTOBALANSE ($)</div><input class="calc-input" type="number" id="calcBalance" value="10000" oninput="calcLot()"></div>' +
    '<div><div class="calc-label">RISIKO (%)</div><input class="calc-input" type="number" id="calcRisk" value="1" step="0.1" oninput="calcLot()"></div>' +
    '</div><div class="calc-row">' +
    '<div><div class="calc-label">STOP LOSS (pips)</div><input class="calc-input" type="number" id="calcSL" value="80" oninput="calcLot()"></div>' +
    '<div><div class="calc-label">PIP-VERDI (XAUUSD=$1)</div><input class="calc-input" type="number" id="calcPipVal" value="1" step="0.1" oninput="calcLot()"></div>' +
    '</div><div class="calc-result"><div style="font-size:11px;color:var(--gold-dim);font-family:monospace">ANBEFALT LOT-STØRRELSE</div>' +
    '<div class="calc-result-value" id="calcResult">0.13 lot</div></div></div></div>';
}

function calcLot(sig) {
  if (sig && sig.stopLoss && sig.entry) {
    const slPips = Math.abs(sig.entry - sig.stopLoss) * 10;
    const el = document.getElementById('calcSL');
    if (el) el.value = Math.round(slPips);
  }
  const balance = parseFloat(document.getElementById('calcBalance')?.value) || 10000;
  const risk = parseFloat(document.getElementById('calcRisk')?.value) || 1;
  const sl = parseFloat(document.getElementById('calcSL')?.value) || 80;
  const pipVal = parseFloat(document.getElementById('calcPipVal')?.value) || 1;
  const lot = sl > 0 ? (balance * risk / 100) / (sl * pipVal * 100) : 0;
  const el = document.getElementById('calcResult');
  if (el) el.textContent = lot.toFixed(2) + ' lot';
}

loadData();
</script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('XAU Signal Desk kjører på port ' + PORT));
