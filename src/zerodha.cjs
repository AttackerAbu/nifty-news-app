// ./src/zerodha.cjs
const { upsertPrice } = require('./quotes.cjs');

function hasCreds() {
  return !!(process.env.ZERODHA_API_KEY && process.env.ZERODHA_API_SECRET && process.env.KITE_ACCESS_TOKEN);
}

async function startZerodhaTicker(mapping) {
  if (!hasCreds()) {
    console.log('Zerodha ticker disabled (missing env).');
    return;
  }
  const { KiteTicker } = await import('kiteconnect');

  const ticker = new KiteTicker({
    api_key: process.env.ZERODHA_API_KEY,
    access_token: process.env.KITE_ACCESS_TOKEN, // refresh daily
  });

  const tokens = Object.keys(mapping).map(k => Number(k)); // instrument_token -> symbol

  ticker.connect();

  ticker.on('connect', () => {
    console.log('✅ Kite ticker connected');
    if (tokens.length) {
      ticker.subscribe(tokens);
      ticker.setMode(ticker.modeLTP, tokens);
    }
  });

  ticker.on('ticks', (ticks) => {
    for (const t of ticks) {
      const sym = mapping[String(t.instrument_token)];
      if (sym && t.last_price) upsertPrice(sym, t.last_price);
    }
  });

  ticker.on('error', (err) => console.error('❌ Kite ticker error:', err));
  ticker.on('close', () => {
    console.log('⚠️ Kite ticker closed — reconnecting in 5s');
    setTimeout(() => startZerodhaTicker(mapping), 5000);
  });
}

module.exports = { startZerodhaTicker };
