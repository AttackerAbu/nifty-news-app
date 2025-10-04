import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { KiteConnect, KiteTicker } from 'kiteconnect';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ZERODHA_API_KEY;
const API_SECRET = process.env.ZERODHA_API_SECRET;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g. https://your-app.onrender.com
const REDIRECT_URL = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/auth/callback`;

const TOKEN_FILE = path.join(process.cwd(), 'access_token.json');
const SYMBOLS = ["RELIANCE","TCS","HDFCBANK"];
// TODO: fill real instrument tokens from instruments dump
const TOKEN_MAP = { RELIANCE: 738561, TCS: 2953217, HDFCBANK: 341249 };

let ticker = null;
let accessToken = loadToken();

// ---------- Token storage ----------
function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: token }, null, 2));
  accessToken = token;
}
function loadToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return j.access_token || null;
  } catch { return null; }
}

// ---------- Zerodha Ticker ----------
function startTicker() {
  if (!API_KEY || !accessToken) return;
  if (ticker) try { ticker.disconnect(); } catch {}

  ticker = new KiteTicker({ api_key: API_KEY, access_token: accessToken });
  ticker.connect();

  ticker.on('connect', () => {
    const tokens = Object.values(TOKEN_MAP);
    ticker.subscribe(tokens);
    ticker.setMode(ticker.modeFull, tokens);
    console.log('✅ Ticker connected');
  });

  ticker.on('ticks', (ticks) => {
    const updates = {};
    for (const t of ticks) {
      const symbol = Object.entries(TOKEN_MAP).find(([, tok]) => tok === t.instrument_token)?.[0];
      if (symbol) updates[symbol] = t.last_price;
    }
    if (Object.keys(updates).length) broadcast({ type: 'quotes', at: Date.now(), updates });
  });

  ticker.on('error', (e) => {
    console.error('Ticker error:', e?.message || e);
    // If unauthorized, force re-login
    if (String(e?.message || '').toLowerCase().includes('token') || String(e).includes('403')) {
      console.log('⚠️ Access token likely expired. Please visit /auth/login.');
    }
  });
}

// ---------- SSE for quotes ----------
const clients = new Set();
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

app.get('/sse/quotes', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ---------- Health ----------
app.get('/api/health', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

// ---------- One-click login ----------
app.get('/auth/login', (_req, res) => {
  if (!API_KEY || !API_SECRET || !PUBLIC_BASE_URL) {
    return res.status(500).send('Missing env vars');
  }
  const kc = new KiteConnect({ api_key: API_KEY });
  const url = kc.getLoginURL({ redirect_params: { redirect_uri: REDIRECT_URL } });
  // Zerodha expects the redirect to match the app config. Ensure REDIRECT_URL is set there.
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { request_token } = req.query;
    if (!request_token) return res.status(400).send('Missing request_token');

    const kc = new KiteConnect({ api_key: API_KEY });
    const session = await kc.generateSession(request_token, API_SECRET);
    saveToken(session.access_token);
    startTicker();
    return res.send(`
      <html><body style="font-family:sans-serif">
        <h3>✅ Zerodha connected</h3>
        <p>Access token saved. You can close this tab.</p>
      </body></html>
    `);
  } catch (e) {
    console.error('Auth callback error:', e?.message || e);
    return res.status(500).send('Auth failed. See server logs.');
  }
});

// ---------- Startup ----------
if (accessToken) {
  console.log('Using existing access token from file');
  startTicker();
} else {
  console.log('No token yet. Visit /auth/login to connect Zerodha.');
}

app.listen(PORT, () => console.log(`HTTP on :${PORT}`));
