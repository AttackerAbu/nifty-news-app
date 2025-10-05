// server.js — unified ESM server (no duplicates)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Import CJS helpers from ./src
const { startQuotesSSE, startMockIfEnabled, priceCache } = require('./src/quotes.cjs');
const { getNewsFor, warmNewsCache, buildCallsFromNews }  = require('./src/newsScraper.cjs');

// ---- Config
const app               = express();
const PORT              = process.env.PORT || 8080;
const FRONTEND_ORIGIN   = process.env.FRONTEND_ORIGIN || 'https://cabcompare.in';
const DEFAULT_SYMBOLS   = (process.env.NIFTY_SYMBOLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const NEWS_WARM_MS      = Number(process.env.REFRESH_INTERVAL_MS || 120000);

app.use(cors({ origin: FRONTEND_ORIGIN }));

// ------------------------
// Health
// ------------------------
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, at: new Date().toISOString() })
);

// ------------------------
// News (Google News RSS → parsed)
// ------------------------
app.get('/api/news', async (req, res) => {
  try {
    const symbols = (req.query.symbols || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    await warmNewsCache();
    const out = await getNewsFor(symbols);
    res.json(out);
  } catch (e) {
    console.error('/api/news error:', e);
    res.status(500).json({ error: 'news_failed' });
  }
});

// ------------------------
// Calls (news → picks; uses latest prices if available)
// ------------------------
app.get('/api/calls', async (req, res) => {
  try {
    const symbolsParam = (req.query.symbols || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const symbols =
      symbolsParam.length ? symbolsParam
      : DEFAULT_SYMBOLS.length ? DEFAULT_SYMBOLS
      : ['RELIANCE', 'TCS', 'HDFCBANK'];

    await warmNewsCache();

    // latest known prices (SSE/WS writes into priceCache)
    const prices = {};
    symbols.forEach(sym => (prices[sym] = priceCache[sym]));

    const calls = await buildCallsFromNews(symbols, prices);
    res.json(calls);
  } catch (e) {
    console.error('/api/calls error:', e);
    res.status(500).json({ error: 'calls_failed' });
  }
});

// ------------------------
// SSE quotes stream
// ------------------------
app.get('/sse/quotes', (req, res) => startQuotesSSE(req, res));

// Warm news cache periodically
setInterval(() => warmNewsCache().catch(() => {}), NEWS_WARM_MS);

// Enable mock quotes if requested
startMockIfEnabled(); // set USE_MOCK_QUOTES=true to simulate prices

// ------------------------
// Optional: Zerodha login (only if env present)
// ------------------------
const API_KEY        = process.env.ZERODHA_API_KEY;
const API_SECRET     = process.env.ZERODHA_API_SECRET;
const PUBLIC_BASE_URL= (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const REDIRECT_URL   = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/auth/callback` : '';
const TOKEN_FILE     = path.join(__dirname, 'access_token.json');

function loadToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return j.access_token || null;
  } catch {
    return null;
  }
}
function saveToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: token }, null, 2));
  } catch {}
}

if (API_KEY && API_SECRET && PUBLIC_BASE_URL) {
  app.get('/auth/login', async (_req, res) => {
    try {
      const { KiteConnect } = await import('kiteconnect');
      const kc = new KiteConnect({ api_key: API_KEY });
      // Uses redirect configured in Kite dev console
      const url = kc.getLoginURL();
      res.redirect(url);
    } catch (e) {
      console.error('auth/login error:', e);
      res.status(500).send('KiteConnect not available or misconfigured.');
    }
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      const { request_token } = req.query;
      if (!request_token) return res.status(400).send('Missing request_token');

      const { KiteConnect } = await import('kiteconnect');
      const kc = new KiteConnect({ api_key: API_KEY });
      const session = await kc.generateSession(request_token, API_SECRET);
      saveToken(session.access_token);

      // NOTE: Wire your Kite Ticker to write LTPs into priceCache inside ./src/zerodha.js
      // so the SSE + /api/calls get live prices.

      res.send(`<html><body style="font-family:sans-serif">
        <h3>✅ Zerodha connected</h3>
        <p>Access token saved. You can close this tab.</p>
      </body></html>`);
    } catch (e) {
      console.error('auth/callback error:', e);
      res.status(500).send('Auth failed. See logs.');
    }
  });
} else {
  console.log('Zerodha auth endpoints disabled (missing env).');
}

// ------------------------
// Start server
// ------------------------
app.listen(PORT, () => {
  console.log(`HTTP :${PORT}`);
  console.log(`CORS  ${FRONTEND_ORIGIN}`);
});
