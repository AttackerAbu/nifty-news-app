// src/quotes.js — SSE + price cache
const priceCache = {}; // { SYMBOL: lastPrice }

function startQuotesSSE(req, res) {
  const symbols = (req.query.symbols || "").split(',').map(s => s.trim()).filter(Boolean);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': process.env.FRONTEND_ORIGIN || '*',
  });

  const timer = setInterval(() => {
    if (!symbols.length) return;
    const updates = {};
    symbols.forEach(sym => {
      const p = priceCache[sym];
      if (p != null) updates[sym] = +p;
    });
    if (Object.keys(updates).length) {
      res.write(`data: ${JSON.stringify({ type: 'quotes', updates })}\n\n`);
    }
  }, 1000);

  req.on('close', () => clearInterval(timer));
}

// Optional mock (disabled by default)
function startMockIfEnabled() {
  if (String(process.env.USE_MOCK_QUOTES).toLowerCase() !== 'true') return;
  const base = { RELIANCE: 2650, TCS: 4060, HDFCBANK: 1530 };
  Object.assign(priceCache, base);
  setInterval(() => {
    for (const k of Object.keys(priceCache)) {
      const v = priceCache[k];
      priceCache[k] = +(Math.max(1, v + (Math.random()-0.5)*2).toFixed(2));
    }
  }, 800);
  console.log('Mock quotes running (USE_MOCK_QUOTES=true)');
}

module.exports = { startQuotesSSE, priceCache, startMockIfEnabled };
