// server.mjs (or server.js with "type":"module" in package.json)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KiteConnect, KiteTicker } from 'kiteconnect';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---- Config ----
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ZERODHA_API_KEY;
const API_SECRET = process.env.ZERODHA_API_SECRET;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://cabcompare.in';

const REDIRECT_URL = `${PUBLIC_BASE_URL}/auth/callback`; // must match Kite app redirect in console

// IMPORTANT: real instrument tokens needed
const SYMBOLS = ['RELIANCE','TCS','HDFCBANK'];
const TOKEN_MAP = { RELIANCE: 738561, TCS: 2953217, HDFCBANK: 341249 }; // replace with real

// ---- CORS ----
app.use(cors({ origin: FRONTEND_ORIGIN }));

// ---- Token storage (ephemeral on Render unless using a Disk) ----
const TOKEN_FILE = path.join(__dirname, 'access_token.json');
let accessToken = loadToken();

function saveToken(token) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: token }, null, 2)); } catch {}
  accessToken = token;
}
function loadToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).access_token || null; } catch { return null; }
}

// ---- SSE for quotes ----
const clients = new Set();
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

app.get('/sse/quotes', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  res.setHeader('X-Accel-Buffering', 'no'); // disable buffering on proxies

  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
  clients.add(res);

  // Heartbeat to keep Render connection alive
  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'ping', at: Date.now() })}\n\n`);
  }, 25000);

  req.on('close', () => { clearInterval(hb); clients.delete(res); });
});

// ---- Health ----
app.get('/api/health', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

// ---- Zerodha Auth Flow ----
app.get('/auth/login', (_req, res) => {
  if (!API_KEY || !API_SECRET || !PUBLIC_BASE_URL) return res.status(500).send('Missing env vars');
  const kc = new KiteConnect({ api_key: API_KEY });
  // getLoginURL uses the redirect configured in the Kite developer console
  const url = kc.getLoginURL();
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { request_token } = req.query;
    if (!request_token) return res.status(400).send('Missing request_token');

    const kc = new KiteConnect({ api_key: API_KEY });
    const session = await kc.generateSession(request_token, API_SECRET);
    saveToken(session.access_token);
    await startTicker(); // start WS now that we have token

    res.send(`<html><body style="font-family:sans-serif">
      <h3>✅ Zerodha connected</h3>
      <p>Access token saved. You can close this tab.</p>
    </body></html>`);
  } catch (e) {
    console.error('Auth callback error:', e?.message || e);
    res.status(500).send('Auth failed. See server logs.');
  }
});

// ---- Kite Ticker ----
let ticker = null;

async function startTicker() {
  if (!API_KEY || !accessToken) {
    console.log('startTicker: missing api_key or accessToken');
    return;
  }
  if (ticker) {
    try { ticker.disconnect(); } catch {}
    ticker = null;
  }

  ticker = new KiteTicker({ api_key: API_KEY, access_token: accessToken });

  ticker.on('connect', () => {
    const tokens = Object.values(TOKEN_MAP);
    ticker.subscribe(tokens);
    ticker.setMode(ticker.modeFull, tokens);
    console.log('✅ Ticker connected and subscribed', tokens);
  });

  ticker.on('ticks', (ticks) => {
    const updates = {};
    for (const t of ticks) {
      const sym = Object.keys(TOKEN_MAP).find(k => TOKEN_MAP[k] === t.instrument_token);
      if (sym && t.last_price != null) updates[sym] = t.last_price;
    }
    if (Object.keys(updates).length) broadcast({ type: 'quotes', at: Date.now(), updates });
  });

  ticker.on('error', (e) => {
    console.error('Ticker error:', e?.message || e);
    // Token expiry / auth errors
    if (String(e?.message || '').toLowerCase().includes('token') || String(e).includes('403')) {
      console.log('⚠️ Access token likely expired. Visit /auth/login again.');
    }
  });

  ticker.on('close', () => {
    console.log('⚠️ Ticker closed. Reconnecting in 3s…');
    setTimeout(startTicker, 3000);
  });

  ticker.connect();
}

// ---- Startup ----
if (accessToken) {
  console.log('Using existing access token from file');
  startTicker();
} else {
  console.log('No token yet. Visit /auth/login to connect Zerodha.');
}

app.listen(PORT, () => console.log(`HTTP on :${PORT}`));
