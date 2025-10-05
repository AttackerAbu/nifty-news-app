// src/newsScraper.js — Google News RSS per symbol (no paid API)
const { XMLParser } = require('fast-xml-parser');

const SYMBOLS = (process.env.NIFTY_SYMBOLS || "").split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_SYMBOLS = SYMBOLS.length ? SYMBOLS : require('./symbols').NIFTY100;

const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 120000); // 2 min
const parser = new XMLParser({ ignoreAttributes: false });

let cache = new Map(); // symbol -> [{title,source,url,ts,impact}]
let cacheAt = 0;

function impactFromTitle(title = "") {
  const s = String(title).toLowerCase();
  const pos = ["surge","rises","soars","wins","approval","contract","profit","gains","record","beat","rebound","momentum","order"];
  const neg = ["falls","drops","loss","probe","penalty","ban","fraud","downgrade","resigns","default","strike","fire"];
  let n = 0; pos.forEach(w => s.includes(w) && n++); neg.forEach(w => s.includes(w) && n--);
  return n > 0 ? "positive" : n < 0 ? "negative" : "neutral";
}

async function fetchRSS(q) {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q);
  const r = await fetch(url);
  const text = await r.text();
  const xml = parser.parse(text);
  const items = (((xml||{}).rss||{}).channel||{}).item || [];
  return items.slice(0, 10).map(i => ({
    title: i.title,
    source: (i.source && i.source['#text']) || (i['dc:creator']) || "Google News",
    url: i.link,
    ts: i.pubDate,
    impact: impactFromTitle(i.title || ""),
  }));
}

async function refresh(symbols = DEFAULT_SYMBOLS) {
  const next = new Map();
  for (const sym of symbols) {
    const query = `${sym} India stock`;
    try {
      const items = await fetchRSS(query);
      next.set(sym, dedupe(items));
    } catch (e) {
      next.set(sym, []);
    }
    // small delay to be polite
    await new Promise(r => setTimeout(r, 150));
  }
  cache = next;
  cacheAt = Date.now();
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.title || "") + "|" + (it.source || "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out.slice(0, 10);
}

async function warmNewsCache() {
  if (Date.now() - cacheAt > REFRESH_INTERVAL_MS) {
    await refresh(DEFAULT_SYMBOLS);
  }
}

async function getNewsFor(symbols) {
  await warmNewsCache();
  const list = (symbols && symbols.length) ? symbols : DEFAULT_SYMBOLS;
  return list.map(sym => ({ symbol: sym, items: cache.get(sym) || [] }));
}

// Build calls from cached news + live prices (no dummy constants; use live px anchor)
function buildCallsFromNews(priceCache) {
  const now = Date.now();
  const τ = 90 * 60 * 1000; // 90m time decay
  const top = new Set(["Mint","The Economic Times","BloombergQuint","BusinessLine","Moneycontrol","NSE","BSE"]);
  const picks = [];

  for (const [sym, items] of cache.entries()) {
    const px = priceCache[sym];
    if (!px || !items?.length) continue;

    const score = items.reduce((acc, a) => {
      const imp = a.impact === "positive" ? 1 : a.impact === "negative" ? -1 : 0;
      const wSrc = top.has(a.source || "") ? 1.25 : 1.0;
      const age = Math.max(1, now - new Date(a.ts || now).getTime());
      const wTime = Math.exp(-age / τ);
      return acc + imp * wSrc * wTime;
    }, 0);
    const newsScore = Math.max(-1, Math.min(1, score / 3));
    if (newsScore <= 0) continue;

    // Levels around live price
    const buyFrom = +(px * 0.998).toFixed(2);
    const buyTo   = +(px * 1.002).toFixed(2);
    const trigger = +(px * 1.001).toFixed(2);
    const target  = +(px * 1.010).toFixed(2); // +1%
    const stop    = +(px * 0.995).toFixed(2); // -0.5%
    const confidence = Math.min(0.95, 0.55 + 0.3 * newsScore);

    picks.push({ symbol: sym, buyFrom, buyTo, trigger, target, stop, confidence,
                 status: "PENDING", createdAt: new Date().toISOString() });
  }

  return picks.sort((a,b)=>b.confidence - a.confidence).slice(0, 30);
}

module.exports = { getNewsFor, warmNewsCache, buildCallsFromNews };
