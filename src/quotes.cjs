// ./src/quotes.cjs
const { EventEmitter } = require('events');

const priceCache = {};                 // { SYM: lastPrice }
const bus = new EventEmitter();        // emits 'tick' {sym, ltp}
const USE_MOCK = String(process.env.USE_MOCK_QUOTES || '').toLowerCase() === 'true';

/**
 * Server-Sent Events handler for quotes
 */
function startQuotesSSE(req, res) {
  const origin = req.headers.origin;
  const allow =
    origin && (
      origin === process.env.FRONTEND_ORIGIN ||
      origin === 'https://cabcompare.in' ||
      origin === 'https://www.cabcompare.in' ||
      origin.startsWith('http://localhost:')
    )
      ? origin
      : '*';            // safe for EventSource (no credentials)

  // CORS + streaming headers
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  // Optional symbol filter: /sse/quotes?symbols=RELIANCE,TCS
  const want = (req.query.symbols || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  const wantSet = want.length ? new Set(want) : null;

  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Send initial snapshot
  const snapshot = {};
  for (const [sym, ltp] of Object.entries(priceCache)) {
    if (!wantSet || wantSet.has(sym)) snapshot[sym] = ltp;
  }
  if (Object.keys(snapshot).length) write({ type: 'ticks', updates: snapshot });

  // Heartbeat
  const ping = setInterval(() => write({ type: 'ping', ts: Date.now() }), 10000);

  // Live updates
  const onTick = ({ sym, ltp }) => {
    if (!wantSet || wantSet.has(sym)) write({ type: 'tick', symbol: sym, ltp, ts: Date.now() });
  };
  bus.on('tick', onTick);

  req.on('close', () => {
    clearInterval(ping);
    bus.off('tick', onTick);
  });
}

/**
 * Push a price into cache and notify SSE clients
 */
function upsertPrice(sym, ltp) {
  priceCache[sym] = ltp;
  bus.emit('tick', { sym, ltp });
}

/**
 * Tiny simulator (ONLY if USE_MOCK_QUOTES=true)
 */
function startMockIfEnabled() {
  if (!USE_MOCK) return;
  console.log('🧪 Using mock quotes');
  const seeds = { RELIANCE: 2500, TCS: 4050, HDFCBANK: 1530 };
  for (const [sym, base] of Object.entries(seeds)) priceCache[sym] = base;

  setInterval(() => {
    for (const sym of Object.keys(seeds)) {
      const last = priceCache[sym] || seeds[sym];
      const ltp = +(last * (1 + (Math.random() - 0.5) * 0.001)).toFixed(2);
      upsertPrice(sym, ltp);
    }
  }, 1000);
}

module.exports = {
  startQuotesSSE,
  startMockIfEnabled,
  priceCache,
  upsertPrice,
};
