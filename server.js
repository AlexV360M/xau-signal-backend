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

let activeSignal = null;
let signalHistory = [];

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (day === 6) return false;
  if (day === 0 && hour < 22) return false;
  if (day === 5 && hour >= 22) return false;
  return true;
}

function getSession() {
  const hour = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  if (hour >= 12 && hour < 16) return 'london-ny-overlap';
  if (hour >= 7 && hour < 16) return 'london';
  if (hour >= 16 && hour < 22) return 'new-york';
  return 'sydney';
}

function isLondonNYOverlap() {
  const hour = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  return hour >= 12 && hour < 16;
}

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(2));
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 5;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    ));
  }
  return parseFloat((trs.slice(-period).reduce((a,b) => a+b, 0) / period).toFixed(2));
}

function detectZones(candles, currentPrice) {
  const zones = [];
  const lookback = 4;
  for (let i = lookback; i < candles.length - lookback; i++) {
    const before = candles.slice(i - lookback, i);
    const after = candles.slice(i + 1, i + lookback + 1);
    if (before.every(c => c.high <= candles[i].high) && after.every(c => c.high <= candles[i].high))
      zones.push({ type: 'resistance', price: candles[i].high, touches: 1 });
    if (before.every(c => c.low >= candles[i].low) && after.every(c => c.low >= candles[i].low))
      zones.push({ type: 'support', price: candles[i].low, touches: 1 });
  }
  const merged = [];
  for (const z of zones) {
    const ex = merged.find(m => m.type === z.type && Math.abs(m.price - z.price) < 5.0);
    if (ex) { ex.touches++; ex.price = parseFloat(((ex.price + z.price) / 2).toFixed(2)); }
    else merged.push({ ...z });
  }
  return merged.sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice)).slice(0, 10);
}

function detectM5Pattern(candles) {
  if (candles.length < 3) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  if (range === 0) return null;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  if (lowerWick > body * 2 && lowerWick > range * 0.55 && last.close > last.open)
    return { pattern: 'bullish_pin_bar', direction: 'buy' };
  if (upperWick > body * 2 && upperWick > range * 0.55 && last.close < last.open)
    return { pattern: 'bearish_pin_bar', direction: 'sell' };
  const bullishEngulf = last.close > last.open && prev.close < prev.open &&
    last.open <= prev.close && last.close >= prev.open &&
    Math.abs(last.close - last.open) > Math.abs(prev.close - prev.open);
  const bearishEngulf = last.close < last.open && prev.close > prev.open &&
    last.open >= prev.close && last.close <= prev.open &&
    Math.abs(last.close - last.open) > Math.abs(prev.close - prev.open);
  if (bullishEngulf) return { pattern: 'bullish_engulfing', direction: 'buy' };
  if (bearishEngulf) return { pattern: 'bearish_engulfing', direction: 'sell' };
  return null;
}

function calcQuality({ zone, m5Pattern, rsi, overlap, h4Spread, signalType }) {
  let score = 0;
  score += Math.min(25, Math.round(h4Spread / 3));
  if (zone) score += Math.min(20, zone.touches * 5);
  if (m5Pattern) score += m5Pattern.pattern.includes('engulfing') ? 25 : 20;
  if (rsi !== null) score += rsi < 30 || rsi > 70 ? 15 : rsi < 40 || rsi > 60 ? 8 : 0;
  if (overlap) score += 10;
  if (signalType === 'breakout') score += 5;
  return Math.min(100, score);
}

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram:', e.message); }
}

async function fetchCandles(interval, outputsize = 150) {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVEDATA_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.values) throw new Error(`Twelve Data feil (${interval}): ${JSON.stringify(data).slice(0,100)}`);
  return data.values.reverse().map(c => ({
    datetime: c.datetime,
    open: parseFloat(c.open), high: parseFloat(c.high),
    low: parseFloat(c.low), close: parseFloat(c.close)
  }));
}

async function analyzeMarket() {
  if (!isMarketOpen()) {
    return { marketClosed: true, signal: activeSignal, signalHistory: signalHistory.slice(0, 20), zones: [], updatedAt: new Date().toISOString() };
  }
  const [h4, m30, m5] = await Promise.all([
    fetchCandles('4h', 200), fetchCandles('30min', 150), fetchCandles('5min', 50)
  ]);
  const h4Closes = h4.map(c => c.close);
  const ema50 = calcEMA(h4Closes, 50);
  const ema200 = calcEMA(h4Closes, 200);
  const h4Bias = ema50 && ema200 ? (ema50 > ema200 ? 'bullish' : 'bearish') : 'range';
  const h4Spread = ema50 && ema200 ? Math.abs(ema50 - ema200) : 0;
  const lastM30 = m30[m30.length - 1];
  const currentPrice = lastM30.close;
  const zones = detectZones(m30, currentPrice);
  const atr = calcATR(m30, 14);
  const zoneBuffer = Math.max(5, atr * 0.5);
  const m5Closes = m5.map(c => c.close);
  const rsi = calcRSI(m5Closes, 14);
  const m5Pattern = detectM5Pattern(m5);
  const overlap = isLondonNYOverlap();
  const session = getSession();

  if (activeSignal) {
    const p = currentPrice;
    const isBuy = activeSignal.direction === 'buy';
    const tpHit = isBuy ? p >= activeSignal.takeProfit : p <= activeSignal.takeProfit;
    const slHit = isBuy ? p <= activeSignal.stopLoss : p >= activeSignal.stopLoss;
    if (tpHit) {
      const pips = parseFloat((Math.abs(activeSignal.takeProfit - activeSignal.entry) * 10).toFixed(1));
      activeSignal.outcome = 'tp_hit'; activeSignal.closedAt = activeSignal.takeProfit;
      activeSignal.pips = `+${pips}`; activeSignal.closedTime = new Date().toISOString();
      signalHistory.unshift({ ...activeSignal });
      await sendTelegram(`✅ <b>XAU — TP HIT</b>\n${isBuy?'▲ BUY':'▼ SELL'}\nEntry: $${activeSignal.entry}\nClose: $${activeSignal.takeProfit}\nPips: +${pips} 💰`);
      activeSignal = null;
    } else if (slHit) {
      const pips = parseFloat((Math.abs(activeSignal.stopLoss - activeSignal.entry) * 10).toFixed(1));
      activeSignal.outcome = 'sl_hit'; activeSignal.closedAt = activeSignal.stopLoss;
      activeSignal.pips = `-${pips}`; activeSignal.closedTime = new Date().toISOString();
      signalHistory.unshift({ ...activeSignal });
      await sendTelegram(`❌ <b>XAU — SL HIT</b>\n${isBuy?'▲ BUY':'▼ SELL'}\nEntry: $${activeSignal.entry}\nClose: $${activeSignal.stopLoss}\nPips: -${pips}`);
      activeSignal = null;
    } else {
      activeSignal.livePips = parseFloat(((isBuy ? currentPrice - activeSignal.entry : activeSignal.entry - currentPrice) * 10).toFixed(1));
    }
  }

  if (!activeSignal) {
    for (const zone of zones) {
      const dist = Math.abs(currentPrice - zone.price);
      if (dist > zoneBuffer) continue;
      let direction = null;
      if (zone.type === 'support' && h4Bias === 'bullish') direction = 'buy';
      if (zone.type === 'resistance' && h4Bias === 'bearish') direction = 'sell';
      if (!direction) continue;
      const m5Confirms = m5Pattern && m5Pattern.direction === direction;
      const status = m5Confirms ? 'confirmed' : 'armed';
      const aslDist = atr * 1.2;
      const sl = direction === 'buy'
        ? parseFloat((Math.min(zone.price, currentPrice) - aslDist).toFixed(2))
        : parseFloat((Math.max(zone.price, currentPrice) + aslDist).toFixed(2));
      const slDist = Math.abs(currentPrice - sl);
      const tp = direction === 'buy'
        ? parseFloat((currentPrice + slDist * 2).toFixed(2))
        : parseFloat((currentPrice - slDist * 2).toFixed(2));
      const quality = calcQuality({ zone, m5Pattern: m5Confirms ? m5Pattern : null, rsi, overlap, h4Spread, signalType: 'zone' });
      activeSignal = {
        id: Date.now(), createdAt: new Date().toISOString(),
        direction, status, signalType: 'zone',
        entry: parseFloat(currentPrice.toFixed(2)),
        stopLoss: sl, takeProfit: tp, riskReward: '1:2',
        zone: zone.price, zoneType: zone.type, zoneTouches: zone.touches,
        m5Pattern: m5Pattern ? m5Pattern.pattern : 'scanning',
        m5Rsi: rsi, overlap, session, quality, h4Bias, ema50, ema200, outcome: 'open',
        atr: parseFloat(atr.toFixed(2)),
        reasoning: `H4 ${h4Bias.toUpperCase()} · M30 ${zone.type==='support'?'støtte':'motstand'} $${zone.price} (${zone.touches} touches) · Avstand: $${dist.toFixed(1)} · M5: ${m5Pattern?m5Pattern.pattern:'venter'} · RSI: ${rsi}`
      };
      if (status === 'confirmed') {
        await sendTelegram(`🚨 <b>XAU SIGNAL CONFIRMED</b>\n\n${direction==='buy'?'▲ BUY':'▼ SELL'}\nEntry: <b>$${activeSignal.entry}</b>\nStop Loss: $${sl}\nTake Profit: $${tp}\nR:R 1:2\n\nH4: ${h4Bias.toUpperCase()}\nM30: $${zone.price} (${zone.touches} touches)\nM5: ${m5Pattern.pattern}\nRSI: ${rsi}\nQuality: ${quality}/100`);
      }
      break;
    }

    if (!activeSignal && zones.length > 0) {
      const allSupports = zones.filter(z => z.type === 'support');
      const allResistances = zones.filter(z => z.type === 'resistance');
      const lowestSupport = allSupports.length > 0 ? Math.min(...allSupports.map(z => z.price)) : null;
      const highestResistance = allResistances.length > 0 ? Math.max(...allResistances.map(z => z.price)) : null;
      if (lowestSupport && currentPrice < lowestSupport - 2 && h4Bias === 'bearish') {
        const m5Confirms = m5Pattern && m5Pattern.direction === 'sell';
        const status = m5Confirms ? 'confirmed' : 'armed';
        const sl = parseFloat((currentPrice + atr * 1.5).toFixed(2));
        const slDist = Math.abs(sl - currentPrice);
        const tp = parseFloat((currentPrice - slDist * 2).toFixed(2));
        const quality = calcQuality({ zone: null, m5Pattern: m5Confirms ? m5Pattern : null, rsi, overlap, h4Spread, signalType: 'breakout' });
        activeSignal = {
          id: Date.now(), createdAt: new Date().toISOString(),
          direction: 'sell', status, signalType: 'breakout',
          entry: parseFloat(currentPrice.toFixed(2)),
          stopLoss: sl, takeProfit: tp, riskReward: '1:2',
          zone: lowestSupport, zoneType: 'breakout_below', zoneTouches: 0,
          m5Pattern: m5Pattern ? m5Pattern.pattern : 'scanning',
          m5Rsi: rsi, overlap, session, quality, h4Bias, ema50, ema200, outcome: 'open',
          atr: parseFloat(atr.toFixed(2)),
          reasoning: `BEARISH BREAKOUT — Pris $${currentPrice.toFixed(2)} brøt under støtte $${lowestSupport} · H4 bearish · RSI: ${rsi}`
        };
        if (status === 'confirmed') {
          await sendTelegram(`🔴 <b>BEARISH BREAKOUT</b>\n\n▼ SELL\nEntry: <b>$${activeSignal.entry}</b>\nStop Loss: $${sl}\nTake Profit: $${tp}\nBrøt under: $${lowestSupport}\nRSI: ${rsi}\nQuality: ${quality}/100`);
        }
      }
      if (!activeSignal && highestResistance && currentPrice > highestResistance + 2 && h4Bias === 'bullish') {
        const m5Confirms = m5Pattern && m5Pattern.direction === 'buy';
        const status = m5Confirms ? 'confirmed' : 'armed';
        const sl = parseFloat((currentPrice - atr * 1.5).toFixed(2));
        const slDist = Math.abs(currentPrice - sl);
        const tp = parseFloat((currentPrice + slDist * 2).toFixed(2));
        const quality = calcQuality({ zone: null, m5Pattern: m5Confirms ? m5Pattern : null, rsi, overlap, h4Spread, signalType: 'breakout' });
        activeSignal = {
          id: Date.now(), createdAt: new Date().toISOString(),
          direction: 'buy', status, signalType: 'breakout',
          entry: parseFloat(currentPrice.toFixed(2)),
          stopLoss: sl, takeProfit: tp, riskReward: '1:2',
          zone: highestResistance, zoneType: 'breakout_above', zoneTouches: 0,
          m5Pattern: m5Pattern ? m5Pattern.pattern : 'scanning',
          m5Rsi: rsi, overlap, session, quality, h4Bias, ema50, ema200, outcome: 'open',
          atr: parseFloat(atr.toFixed(2)),
          reasoning: `BULLISH BREAKOUT — Pris $${currentPrice.toFixed(2)} brøt over motstand $${highestResistance} · H4 bullish · RSI: ${rsi}`
        };
        if (status === 'confirmed') {
          await sendTelegram(`🟢 <b>BULLISH BREAKOUT</b>\n\n▲ BUY\nEntry: <b>$${activeSignal.entry}</b>\nStop Loss: $${sl}\nTake Profit: $${tp}\nBrøt over: $${highestResistance}\nRSI: ${rsi}\nQuality: ${quality}/100`);
        }
      }
    }
  }

  return {
    symbol: 'XAUUSD', price: parseFloat(currentPrice.toFixed(2)),
    open: lastM30.open, high: lastM30.high, low: lastM30.low,
    ema50, ema200, rsi, bias: h4Bias,
    h4Spread: parseFloat(h4Spread.toFixed(2)),
    atr: parseFloat(atr.toFixed(2)),
    zoneBuffer: parseFloat(zoneBuffer.toFixed(2)),
    session, zones, signal: activeSignal,
    signalHistory: signalHistory.slice(0, 20),
    overlap, marketClosed: false,
    dataSource: 'Twelve Data · H4 + M30 + M5',
    updatedAt: new Date().toISOString()
  };
}

app.get('/health', (req, res) => res.json({ status: 'ok', market: isMarketOpen() ? 'open' : 'closed' }));

app.get('/api/market', async (req, res) => {
  try {
    if (!TWELVEDATA_API_KEY) return res.status(500).json({ error: 'TWELVEDATA_API_KEY mangler' });
    const data = await analyzeMarket();
    res.json(data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    if (!NEWS_API_KEY) return res.json({ events: [], newsLocked: false });
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const r = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${tomorrow}&token=${NEWS_API_KEY}`);
    const data = await r.json();
    const events = (data.economicCalendar || [])
      .filter(e => ['USD','US'].includes(e.country) && ['high','medium'].includes((e.impact||'').toLowerCase()))
      .map(e => ({ time: e.time, event: e.event, country: e.country, impact: e.impact, minsUntil: Math.round((new Date(e.time) - Date.now()) / 60000) }))
      .sort((a, b) => a.minsUntil - b.minsUntil);
    res.json({ events: events.slice(0, 8), newsLocked: events.some(e => e.minsUntil >= -15 && e.minsUntil <= 60) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test-telegram', async (req, res) => {
  await sendTelegram('🔔 <b>XAU Signal Desk</b>\nTelegram fungerer! ✅');
  res.json({ sent: true });
});

app.get('/', (req, res) => res.send(`<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>XAU Signal Desk</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
:root{--gold:#D4AF37;--gold-dim:#8a7020;--gold-glow:rgba(212,175,55,0.15);--bg:#0a0a0b;--card:#111114;--card2:#16161a;--border:#222228;--text:#e8e8f0;--dim:#666675;--green:#00c896;--red:#ff4560;--yellow:#f5a623;--blue:#4a9eff;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:'Space Grotesk',sans-serif;}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);background:var(--card);position:sticky;top:0;z-index:99;}
.logo{display:flex;align-items:center;gap:9px;}
.logo-ico{width:30px;height:30px;background:var(--gold);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:15px;}
.logo-t{font-size:15px;font-weight:700;}
.logo-s{font-size:9px;color:var(--dim);font-family:'Space Mono',monospace;}
.hdr-r{display:flex;align-items:center;gap:7px;}
.live{display:flex;align-items:center;gap:5px;font-size:9px;color:var(--dim);font-family:'Space Mono',monospace;}
.ldot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:blink 2s infinite;}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
.rbtn{background:var(--card2);border:1px solid var(--border);color:var(--gold);padding:5px 9px;border-radius:5px;font-size:10px;cursor:pointer;}
.banner{display:none;align-items:center;gap:8px;padding:9px 14px;margin:10px 14px 0;border-radius:7px;font-size:11px;font-weight:500;}
.banner.show{display:flex;}
.b-closed{background:rgba(74,158,255,0.07);border:1px solid rgba(74,158,255,0.2);color:var(--blue);}
.b-news{background:rgba(255,69,96,0.07);border:1px solid rgba(255,69,96,0.2);color:var(--red);}
.b-overlap{background:rgba(245,166,35,0.07);border:1px solid rgba(245,166,35,0.2);color:var(--yellow);}
main{padding:12px;display:flex;flex-direction:column;gap:10px;}
.card{background:var(--card);border:1px solid var(--border);border-radius:11px;overflow:hidden;}
.ch{padding:11px 15px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;}
.ct{font-size:10px;font-family:'Space Mono',monospace;color:var(--dim);letter-spacing:1px;}
.cb{padding:14px;}
.price-row{display:flex;align-items:center;justify-content:space-between;padding:15px 17px;}
.pv{font-size:32px;font-weight:700;color:var(--gold);font-family:'Space Mono',monospace;}
.pm{font-size:10px;color:var(--dim);font-family:'Space Mono',monospace;margin-top:3px;}
.pl{font-size:9px;color:var(--dim);font-family:'Space Mono',monospace;margin-bottom:2px;}
.bp{padding:6px 13px;border-radius:6px;font-size:11px;font-weight:700;font-family:'Space Mono',monospace;}
.bp.bullish{background:rgba(0,200,150,0.1);color:var(--green);border:1px solid rgba(0,200,150,0.25);}
.bp.bearish{background:rgba(255,69,96,0.1);color:var(--red);border:1px solid rgba(255,69,96,0.25);}
.bp.range{background:var(--gold-glow);color:var(--gold);border:1px solid rgba(212,175,55,0.25);}
.sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;}
.sc{background:var(--card);border:1px solid var(--border);border-radius:9px;padding:9px 11px;text-align:center;}
.sl2{font-size:9px;color:var(--dim);font-family:'Space Mono',monospace;margin-bottom:2px;}
.sv{font-size:15px;font-weight:700;font-family:'Space Mono',monospace;color:var(--gold);}
.no-sig{text-align:center;padding:22px 0;color:var(--dim);font-size:12px;}
.sig-top{display:flex;align-items:center;gap:9px;margin-bottom:12px;flex-wrap:wrap;}
.db{padding:8px 18px;border-radius:6px;font-size:17px;font-weight:700;font-family:'Space Mono',monospace;}
.db.buy{background:rgba(0,200,150,0.1);color:var(--green);border:1px solid rgba(0,200,150,0.3);}
.db.sell{background:rgba(255,69,96,0.1);color:var(--red);border:1px solid rgba(255,69,96,0.3);}
.sb{padding:4px 9px;border-radius:4px;font-size:9px;font-weight:700;font-family:'Space Mono',monospace;}
.sb.confirmed{background:rgba(0,200,150,0.1);color:var(--green);border:1px solid rgba(0,200,150,0.25);animation:glow 1.5s infinite;}
.sb.armed{background:rgba(245,166,35,0.08);color:var(--yellow);border:1px solid rgba(245,166,35,0.25);}
.st-b{padding:3px 8px;border-radius:4px;font-size:9px;font-family:'Space Mono',monospace;background:rgba(74,158,255,0.1);color:var(--blue);border:1px solid rgba(74,158,255,0.2);}
@keyframes glow{0%,100%{box-shadow:0 0 0 0 rgba(0,200,150,0)}50%{box-shadow:0 0 8px 2px rgba(0,200,150,0.15)}}
.ig{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:9px;}
.ii{background:var(--card2);border-radius:6px;padding:8px 10px;}
.il{font-size:8px;color:var(--dim);font-family:'Space Mono',monospace;margin-bottom:2px;}
.iv{font-size:13px;font-weight:600;font-family:'Space Mono',monospace;}
.iv.slv{color:var(--red);}
.iv.tpv{color:var(--green);}
.iv.rrv{color:var(--gold);font-size:16px;}
.iv.pp{color:var(--green);}
.iv.pn{color:var(--red);}
.qb{background:var(--card2);border-radius:6px;padding:9px;margin-bottom:9px;}
.qt{display:flex;justify-content:space-between;font-size:9px;font-family:'Space Mono',monospace;color:var(--dim);margin-bottom:5px;}
.qbar{height:4px;background:var(--border);border-radius:2px;overflow:hidden;}
.qfill{height:100%;border-radius:2px;transition:width 0.5s;}
.rsn{background:var(--card2);border-radius:6px;padding:9px;font-size:10px;color:var(--dim);line-height:1.6;}
.zr{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--border);}
.zr:last-child{border-bottom:none;}
.zl{display:flex;align-items:center;gap:8px;}
.zdot{width:6px;height:6px;border-radius:50%;}
.zdot.support{background:var(--green);}
.zdot.resistance{background:var(--red);}
.zt3{font-size:8px;color:var(--dim);font-family:'Space Mono',monospace;text-transform:uppercase;}
.zp{font-size:13px;font-weight:600;font-family:'Space Mono',monospace;}
.zd{font-size:9px;color:var(--dim);font-family:'Space Mono',monospace;text-align:right;}
.atr-info{font-size:9px;color:var(--dim);font-family:'Space Mono',monospace;padding:6px 14px;border-top:1px solid var(--border);}
.hstats{display:flex;gap:10px;font-size:9px;font-family:'Space Mono',monospace;}
table{width:100%;border-collapse:collapse;font-size:10px;}
th{padding:6px 9px;text-align:left;color:var(--dim);font-family:'Space Mono',monospace;font-size:8px;border-bottom:1px solid var(--border);white-space:nowrap;}
td{padding:8px 9px;border-bottom:1px solid var(--border);font-family:'Space Mono',monospace;white-space:nowrap;}
.otp{color:var(--green);font-weight:600;}
.osl{color:var(--red);font-weight:600;}
.oop{color:var(--yellow);}
.pp2{color:var(--green);}
.pn2{color:var(--red);}
.cgrid{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:12px 14px;}
.clbl{font-size:8px;color:var(--dim);font-family:'Space Mono',monospace;margin-bottom:3px;}
.cinp{background:var(--card2);border:1px solid var(--border);border-radius:5px;padding:7px 9px;color:var(--text);font-family:'Space Mono',monospace;font-size:12px;width:100%;}
.cinp:focus{outline:none;border-color:var(--gold);}
.cres{margin:0 14px 12px;background:var(--gold-glow);border:1px solid rgba(212,175,55,0.15);border-radius:6px;padding:9px 11px;display:flex;justify-content:space-between;align-items:center;}
.crv{font-size:17px;font-weight:700;color:var(--gold);font-family:'Space Mono',monospace;}
.nr{display:flex;align-items:center;gap:9px;padding:9px 13px;border-bottom:1px solid var(--border);font-size:10px;}
.nr:last-child{border-bottom:none;}
.ni{padding:2px 5px;border-radius:3px;font-size:8px;font-weight:700;font-family:'Space Mono',monospace;min-width:34px;text-align:center;}
.ni.high{background:rgba(255,69,96,0.12);color:var(--red);}
.ni.medium{background:rgba(245,166,35,0.12);color:var(--yellow);}
.ne{flex:1;}
.nt4{color:var(--dim);font-family:'Space Mono',monospace;font-size:9px;}
.nonews{padding:12px 14px;font-size:11px;color:var(--dim);text-align:center;}
.foot{text-align:center;padding:0 0 14px;}
.ft{font-size:9px;color:var(--dim);font-family:'Space Mono',monospace;}
.fs{font-size:8px;color:var(--gold-dim);font-family:'Space Mono',monospace;margin-top:2px;}
.loader{text-align:center;padding:50px 20px;color:var(--dim);}
.spin{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 12px;}
@keyframes spin{to{transform:rotate(360deg)}}
.err{background:rgba(255,69,96,0.06);border:1px solid rgba(255,69,96,0.15);border-radius:9px;padding:12px;color:var(--red);font-size:11px;text-align:center;margin:8px;}
</style>
</head>
<body>
<header>
<div class="logo"><div class="logo-ico">⚡</div><div><div class="logo-t">XAU Signal Desk</div><div class="logo-s">H4 · M30 · M5 · LIVE</div></div></div>
<div class="hdr-r"><div class="live"><div class="ldot" id="ld"></div><span id="lt">LIVE</span></div><button class="rbtn" onclick="go()">↻</button></div>
</header>
<div id="bc" class="banner b-closed">🔒 Markedet stengt — Åpner søndag 22:00 UTC</div>
<div id="bn" class="banner b-news">🚫 <span id="nt2">NEWS LOCK</span></div>
<div id="bo" class="banner b-overlap">⚡ London–NY Overlapp aktiv</div>
<main id="main"><div class="loader"><div class="spin"></div>Kobler til...</div></main>
<script>
let timer=null,lastId=null;
function beep(){try{const c=new(window.AudioContext||window.webkitAudioContext)();[880,1100,880].forEach((f,i)=>{const o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.frequency.value=f;o.type='sine';g.gain.setValueAtTime(0.3,c.currentTime+i*.15);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+i*.15+.2);o.start(c.currentTime+i*.15);o.stop(c.currentTime+i*.15+.2)});}catch(e){}}
async function go(){clearTimeout(timer);try{const[mr,nr]=await Promise.all([fetch('/api/market'),fetch('/api/news')]);const m=await mr.json(),n=await nr.json().catch(()=>({events:[],newsLocked:false}));render(m,n);document.getElementById('ld').style.background='var(--green)';document.getElementById('lt').textContent='LIVE';}catch(e){document.getElementById('main').innerHTML='<div class="err">⚠️ '+e.message+'</div>';document.getElementById('ld').style.background='var(--red)';document.getElementById('lt').textContent='FRAKOBLET';}timer=setTimeout(go,60000);}
function render(m,n){document.getElementById('bc').className='banner b-closed'+(m.marketClosed?' show':'');document.getElementById('bn').className='banner b-news'+(n.newsLocked?' show':'');document.getElementById('bo').className='banner b-overlap'+(m.overlap?' show':'');if(n.newsLocked){const x=(n.events||[]).find(e=>e.minsUntil>=-15&&e.minsUntil<=60);if(x)document.getElementById('nt2').textContent='NEWS LOCK — '+x.event+' om '+x.minsUntil+' min';}const s=m.signal;if(s&&s.status==='confirmed'&&s.id!==lastId){beep();lastId=s.id;}document.getElementById('main').innerHTML=pc(m)+sr(m)+sigCard(s,n.newsLocked)+zc(m.zones||[],m.price,m.zoneBuffer,m.atr)+hc(m.signalHistory||[])+calc(s)+newsC(n.events||[])+foot(m);calcLot(s);}
function pc(m){const b=m.bias||'range',bl={bullish:'▲ BULLISH',bearish:'▼ BEARISH',range:'◆ RANGE'}[b]||b;return '<div class="card"><div class="price-row"><div><div class="pl">XAU/USD · H4 · LIVE</div><div class="pv">$'+(m.price||'—')+'</div><div class="pm">H '+(m.high?.toFixed(2)||'—')+' · L '+(m.low?.toFixed(2)||'—')+' · '+(m.session||'')+'</div></div><div class="bp '+b+'">'+bl+'</div></div></div>';}
function sr(m){const rc=m.rsi>70?'var(--red)':m.rsi<30?'var(--green)':'var(--gold)';return '<div class="sgrid"><div class="sc"><div class="sl2">H4 EMA 50</div><div class="sv">$'+(m.ema50||'—')+'</div></div><div class="sc"><div class="sl2">H4 EMA 200</div><div class="sv">$'+(m.ema200||'—')+'</div></div><div class="sc"><div class="sl2">M5 RSI 14</div><div class="sv" style="color:'+rc+'">'+(m.rsi||'—')+'</div></div></div>';}
function sigCard(s,locked){let body='';if(!s){body='<div class="no-sig">⏳ Ingen aktive signal<br><span style="font-size:9px;color:#333">H4 · M30 · M5 overvåkes</span></div>';}else{const q=s.quality||0,qc=q>=70?'var(--green)':q>=50?'var(--yellow)':'var(--red)';const lp=s.livePips||0,lpc=lp>=0?'pp':'pn';body='<div class="sig-top"><div class="db '+s.direction+'">'+s.direction.toUpperCase()+'</div><div class="sb '+s.status+'">'+s.status.toUpperCase()+'</div><div class="st-b">'+(s.signalType==='breakout'?'BREAKOUT':'ZONE')+'</div>'+(locked?'<span style="font-size:9px;color:var(--red)">🚫 NEWS</span>':'')+'</div><div class="ig"><div class="ii"><div class="il">ENTRY</div><div class="iv">$'+s.entry+'</div></div><div class="ii"><div class="il">LIVE PIPS</div><div class="iv '+lpc+'">'+(lp>=0?'+':'')+lp+'</div></div><div class="ii"><div class="il">STOP LOSS</div><div class="iv slv">$'+s.stopLoss+'</div></div><div class="ii"><div class="il">TAKE PROFIT</div><div class="iv tpv">$'+s.takeProfit+'</div></div><div class="ii"><div class="il">R:R</div><div class="iv rrv">'+s.riskReward+'</div></div><div class="ii"><div class="il">M5 MØNSTER</div><div class="iv" style="font-size:10px">'+(s.m5Pattern||'—')+'</div></div></div><div class="qb"><div class="qt"><span>SIGNAL QUALITY</span><span style="color:'+qc+'">'+q+'/100</span></div><div class="qbar"><div class="qfill" style="width:'+q+'%;background:'+qc+'"></div></div></div><div class="rsn">💡 '+(s.reasoning||'')+'</div>';}return '<div class="card"><div class="ch"><span class="ct">AKTIVT SIGNAL</span>'+(s?'<span style="font-size:9px;font-family:monospace;color:'+(s.direction==='buy'?'var(--green)':'var(--red)')+'">●XAUUSD</span>':'')+'</div><div class="cb">'+body+'</div></div>';}
function zc(zones,price,buf,atr){if(!zones.length)return'';const rows=zones.slice(0,8).map(z=>{const d=price?(price-z.price).toFixed(2):'—';const sg=d>0?'+':'';const inB=buf&&Math.abs(price-z.price)<=buf;return'<div class="zr" style="'+(inB?'background:rgba(212,175,55,0.05);':'')+'"><div class="zl"><div class="zdot '+z.type+'"></div><div><div class="zt3">'+(z.type==='support'?'STØTTE':'MOTSTAND')+'</div><div class="zp">$'+(z.price?.toFixed?z.price.toFixed(2):z.price)+'</div></div></div><div><div class="zd">'+sg+'$'+d+'</div><div class="zt3">'+(z.touches||0)+' touches</div></div></div>';}).join('');return'<div class="card"><div class="ch"><span class="ct">STØTTE & MOTSTAND · M30</span></div>'+rows+'<div class="atr-info">ATR: $'+(atr?.toFixed(2)||'—')+' · Buffer: ±$'+(buf?.toFixed(1)||'—')+'</div></div>';}
function hc(hist){if(!hist.length)return'';const tp=hist.filter(s=>s.outcome==='tp_hit').length,sl=hist.filter(s=>s.outcome==='sl_hit').length,wr=tp+sl>0?Math.round(tp/(tp+sl)*100):0;const rows=hist.map(s=>{const dir=s.direction==='buy'?'<span style="color:var(--green)">▲BUY</span>':'<span style="color:var(--red)">▼SELL</span>';const out=s.outcome==='tp_hit'?'<span class="otp">✓TP</span>':s.outcome==='sl_hit'?'<span class="osl">✗SL</span>':'<span class="oop">●OPEN</span>';const pc=s.pips&&s.pips.startsWith('+')?'pp2':'pn2';const t=new Date(s.createdAt).toLocaleString('no-NO',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});const st=s.signalType==='breakout'?'<span style="font-size:8px;color:var(--blue)">BRK</span>':'<span style="font-size:8px;color:var(--dim)">ZNE</span>';return'<tr><td>'+t+'</td><td>'+dir+'</td><td>$'+s.entry+'</td><td style="color:var(--red)">$'+s.stopLoss+'</td><td style="color:var(--green)">$'+s.takeProfit+'</td><td>'+out+'</td><td>$'+(s.closedAt||'—')+'</td><td class="'+pc+'">'+(s.pips||'—')+'</td><td>'+st+'</td></tr>';}).join('');return'<div class="card"><div class="ch"><span class="ct">SIGNAL HISTORIKK</span><div class="hstats"><span class="otp">'+tp+' TP</span><span class="osl">'+sl+' SL</span><span style="color:var(--gold)">'+wr+'% Win</span></div></div><div style="overflow-x:auto"><table><tr><th>TID</th><th>DIR</th><th>ENTRY</th><th>SL</th><th>TP</th><th>UTFALL</th><th>CLOSE</th><th>PIPS</th><th>TYPE</th></tr>'+rows+'</table></div></div>';}
function calc(s){return'<div class="card"><div class="ch"><span class="ct">RISIKOKALKULATOR</span></div><div class="cgrid"><div><div class="clbl">KONTO ($)</div><input class="cinp" id="cb" type="number" value="10000" oninput="calcLot()"></div><div><div class="clbl">RISIKO (%)</div><input class="cinp" id="cr" type="number" value="1" step="0.1" oninput="calcLot()"></div><div><div class="clbl">SL (pips)</div><input class="cinp" id="cs" type="number" value="80" oninput="calcLot()"></div><div><div class="clbl">PIP-VERDI ($)</div><input class="cinp" id="cp" type="number" value="1" step="0.1" oninput="calcLot()"></div></div><div class="cres"><span style="font-size:9px;color:var(--gold-dim);font-family:monospace">LOT</span><span class="crv" id="cv">0.13 lot</span></div></div>';}
function newsC(ev){if(!ev.length)return'<div class="card"><div class="ch"><span class="ct">NYHETER · USD</span></div><div class="nonews">Ingen high/medium-impact USD-nyheter i dag</div></div>';const rows=ev.map(e=>{const t=e.minsUntil>=0?'om '+e.minsUntil+' min':Math.abs(e.minsUntil)+' min siden';return'<div class="nr"><span class="ni '+(e.impact||'').toLowerCase()+'">'+(e.impact||'').toUpperCase()+'</span><span class="ne">'+e.event+'</span><span class="nt4">'+t+'</span></div>';}).join('');return'<div class="card"><div class="ch"><span class="ct">NYHETER · USD</span></div>'+rows+'</div>';}
function foot(m){return'<div class="foot"><div class="ft">Oppdatert: '+new Date().toLocaleTimeString('no-NO')+' · 60s refresh</div><div class="fs">'+(m.dataSource||'Twelve Data · H4+M30+M5')+'</div></div>';}
function calcLot(s){if(s&&s.stopLoss&&s.entry){const el=document.getElementById('cs');if(el)el.value=Math.round(Math.abs(s.entry-s.stopLoss)*10);}const b=parseFloat(document.getElementById('cb')?.value)||10000,r=parseFloat(document.getElementById('cr')?.value)||1,sl=parseFloat(document.getElementById('cs')?.value)||80,p=parseFloat(document.getElementById('cp')?.value)||1,lot=sl>0?(b*r/100)/(sl*p*100):0;const el=document.getElementById('cv');if(el)el.textContent=lot.toFixed(2)+' lot';}
go();
</script>
</body>
</html>`));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('XAU Signal Desk v3 · Port ' + PORT));
