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

async function
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
