#!/usr/bin/env node
/*
 * Buildlock server
 * - Serves the app from ./public
 * - Scrapes tracklock.gg (pro builds + statistical builds) on demand, with a disk cache
 * - No npm dependencies. Needs Node.js 18 or newer (for built-in fetch).
 *
 *   node server.js                 start the server (default port 8787)
 *   node server.js --warm          start and pre-fetch every hero in the background
 *   node server.js --scrape warden print one hero's parsed data and exit
 *   node server.js --snapshot      scrape every hero into data/tracklock-snapshot.json and exit
 *   node server.js --export _site  scrape every hero into _site/tracklock.json and exit (used by the GitHub Action)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const CACHE_FILE = path.join(DATA, 'tracklock-cache.json');
const SNAPSHOT_FILE = path.join(DATA, 'tracklock-snapshot.json');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_HOURS = Number(process.env.CACHE_HOURS) || 6;
const TTL = CACHE_HOURS * 3600 * 1000;
const REQUEST_GAP_MS = Number(process.env.REQUEST_GAP_MS) || 1500; // politeness delay between tracklock requests
const BASE = process.env.TRACKLOCK_BASE || 'https://tracklock.gg';
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; Buildlock/1.0; personal build planner)';

if (typeof fetch !== 'function') {
  console.error('This server needs Node.js 18 or newer (built-in fetch). You have ' + process.version);
  process.exit(1);
}

const LOOKUP = JSON.parse(fs.readFileSync(path.join(DATA, 'lookup.json'), 'utf8'));
const ITEM_BY_NAME = new Map(Object.entries(LOOKUP.items).map(([n, id]) => [norm(n), id]));
const HERO_IDS = Object.keys(LOOKUP.heroes);

function norm(s) {
  return String(s).toLowerCase().replace(/&amp;/g, '&').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ cache */
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { cache = {}; }
let saveTimer = null;
function flushCache() {
  clearTimeout(saveTimer);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); }
    catch (e) { console.warn('Could not write cache:', e.message); }
  }, 300);
}

/* ------------------------------------------------------------------ polite fetch queue */
let chain = Promise.resolve();
let lastRequest = 0;
function politeFetch(url) {
  const run = async () => {
    const wait = lastRequest + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequest = Date.now();
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
        if (!res.ok) { const e = new Error('HTTP ' + res.status); e.fatal = true; throw e; }
        return await res.text();
      } catch (e) {
        lastErr = e;
        if (e.fatal) break;
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1) ** 2));
      }
    }
    throw lastErr;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/* ------------------------------------------------------------------ HTML tokenizer + parsers */
function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;|&#160;/g, ' ').replace(/&#183;|&middot;/g, '·')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
}
/** Turn HTML into an ordered list of {t:'text'|'alt', v} tokens (scripts and styles removed). */
function tokenize(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const re = /<img\b[^>]*?\balt="([^"]*)"[^>]*>|<[^>]+>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) { const v = decode(m[1]).trim(); if (v) out.push({ t: 'alt', v }); }
    else if (m[2] !== undefined) { const v = decode(m[2]).replace(/\s+/g, ' ').trim(); if (v) out.push({ t: 'text', v }); }
  }
  return out;
}
const fullText = toks => toks.filter(t => t.t === 'text').map(t => t.v).join(' ');
function findText(toks, re, from = 0) {
  for (let i = from; i < toks.length; i++) if (toks[i].t === 'text' && re.test(toks[i].v)) return i;
  return -1;
}
function itemId(name) { return ITEM_BY_NAME.get(norm(name)) || null; }

/** Pro builds page: Early / Mid / Late lists of [itemId, pickPercent]. */
function parseProbuild(html) {
  const toks = tokenize(html);
  const text = fullText(toks);
  const wr = /Win Rate\s*([\d.]+)\s*%/i.exec(text);
  const games = /Games\s*([\d,]+)/i.exec(text);
  const marks = [
    ['Early', findText(toks, /^Early Game/i)],
    ['Mid', findText(toks, /^Mid Game/i)],
    ['Late', findText(toks, /^Late Game/i)],
  ];
  let end = findText(toks, /^Laned with|^Show more|^vs All Heroes/i, Math.max(0, marks[2][1]));
  if (end < 0) end = toks.length;
  const phases = {};
  const unknown = new Set();
  marks.forEach(([key, start], i) => {
    const stop = i < 2 ? marks[i + 1][1] : end;
    const list = [];
    if (start >= 0 && stop > start) {
      let pending = null;
      for (let k = start + 1; k < stop; k++) {
        const tk = toks[k];
        if (tk.t === 'alt') {
          const id = itemId(tk.v);
          if (id) pending = id; else unknown.add(tk.v);
        } else if (pending) {
          const pm = /(\d{1,3})\s*%\s*$/.exec(tk.v);
          if (pm) { if (!list.some(x => x[0] === pending)) list.push([pending, +pm[1]]); pending = null; }
        }
      }
      // Fallback: text-only pattern like "IILong Range90%"
      if (!list.length) {
        const seg = toks.slice(start + 1, stop).filter(t => t.t === 'text').map(t => t.v).join('');
        const re = /(IV|I{1,3})([A-Z][^%]*?)(\d{1,3})%/g; let mm;
        while ((mm = re.exec(seg))) { const id = itemId(mm[2]); if (id && !list.some(x => x[0] === id)) list.push([id, +mm[3]]); }
      }
    }
    phases[key] = list;
  });
  const count = phases.Early.length + phases.Mid.length + phases.Late.length;
  if (!count) throw new Error('Could not find the Early/Mid/Late item lists on the pro build page (tracklock may have changed its layout)');
  return { wr: wr ? +wr[1] : null, g: games ? +games[1].replace(/,/g, '') : null, p: phases, unknown: [...unknown].slice(0, 20) };
}

/** Statistical build page: core build in order, situational lists, ability unlock order. */
function parseBuild(html, heroId) {
  const toks = tokenize(html);
  const text = fullText(toks);
  const wr = /([\d.]+)\s*%\s*WR\s*\(\s*([\d,]+)\s*Matches\s*\)/i.exec(text);
  const sections = [
    ['core', /^Core Build/i], ['early', /^Early\b/i], ['late', /^Late\b/i],
    ['defensive', /^Defensives/i], ['counters', /^Counter Picks/i], ['actives', /^Actives/i],
  ];
  const coreStart = findText(toks, sections[0][1]);
  const idx = sections.map(([k, re]) => [k, coreStart >= 0 ? findText(toks, re, coreStart) : -1]).filter(x => x[1] >= 0).sort((a, b) => a[1] - b[1]);
  const out = {};
  idx.forEach(([k, start], i) => {
    const stop = i + 1 < idx.length ? idx[i + 1][1] : toks.length;
    // A listed item is its icon followed by tier and name text. The last section otherwise runs on into
    // unrelated icons further down the page, which carry no name, so those are skipped.
    const named = j => [toks[j + 1], toks[j + 2]].some(t => t && t.t === 'text' && norm(t.v) === norm(toks[j].v));
    const collect = strict => {
      const ids = [];
      for (let j = start + 1; j < stop; j++) {
        if (toks[j].t !== 'alt' || (strict && !named(j))) continue;
        const id = itemId(toks[j].v);
        if (id && !ids.includes(id)) ids.push(id);
      }
      return ids;
    };
    const strict = collect(true);
    out[k] = strict.length ? strict : collect(false);
  });
  // Ability unlock order: ability icons between "Unlock Order" and the next heading
  const abNames = (LOOKUP.heroes[heroId]?.abilities || []).map(norm);
  const uo = findText(toks, /^Unlock Order/i);
  const unlock = [];
  if (uo >= 0) {
    for (let j = uo + 1; j < toks.length && unlock.length < 4; j++) {
      if (toks[j].t === 'text' && /^(Skill Path|Core Build)/i.test(toks[j].v)) break;
      if (toks[j].t === 'alt') { const a = abNames.indexOf(norm(toks[j].v)); if (a >= 0 && !unlock.includes(a)) unlock.push(a); }
    }
  }
  if (!out.core || !out.core.length) throw new Error('Could not find the core build on the build page (tracklock may have changed its layout)');
  return { wr: wr ? +wr[1] : null, matches: wr ? +wr[2].replace(/,/g, '') : null, ...out, unlock };
}

/* ------------------------------------------------------------------ hero fetch with cache */
const inflight = new Map();
async function getHero(heroId, { force = false } = {}) {
  const h = LOOKUP.heroes[heroId];
  if (!h) { const e = new Error('Unknown hero ' + heroId); e.status = 404; throw e; }
  const c = cache[heroId];
  const fresh = c && Date.now() - c.fetchedAt < TTL;
  if (c && fresh && !force) return { ...c, cached: true };
  if (inflight.has(heroId)) return inflight.get(heroId);
  const job = (async () => {
    const errors = [];
    let pro = null, build = null;
    try { pro = parseProbuild(await politeFetch(`${BASE}/heroes/${h.slug}/probuild`)); }
    catch (e) { errors.push('Pro build: ' + e.message); }
    try { build = parseBuild(await politeFetch(`${BASE}/heroes/${h.slug}/build`), heroId); }
    catch (e) { errors.push('Stats build: ' + e.message); }
    if (!pro && !build) {
      if (c) return { ...c, cached: true, stale: true, errors };               // serve stale cache
      const e = new Error(errors.join('; ')); e.status = 502; throw e;
    }
    const entry = {
      hero: heroId, name: h.name, slug: h.slug, fetchedAt: Date.now(),
      pro: pro || c?.pro || null, build: build || c?.build || null, errors,
    };
    cache[heroId] = entry; saveCache();
    return { ...entry, cached: false };
  })();
  inflight.set(heroId, job);
  try { return await job; } finally { inflight.delete(heroId); }
}

/* ------------------------------------------------------------------ static files + API */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const cacheHdr = /\.(png|svg|ico)$/.test(file) ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheHdr });
    res.end(buf);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' });
  try {
    if (p === '/api/health') {
      const entries = Object.values(cache);
      return send(res, 200, { ok: true, node: process.version, cacheHours: CACHE_HOURS, cachedHeroes: entries.length,
        oldest: entries.length ? Math.min(...entries.map(e => e.fetchedAt)) : null,
        lastErrors: entries.filter(e => e.errors && e.errors.length).map(e => ({ hero: e.name, errors: e.errors })) });
    }
    if (p === '/api/tracklock') {
      return send(res, 200, Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, { fetchedAt: v.fetchedAt, pro: !!v.pro, build: !!v.build }])));
    }
    const m = /^\/api\/tracklock\/([a-z0-9_]+)$/.exec(p);
    if (m) {
      const data = await getHero(m[1], { force: url.searchParams.get('refresh') === '1' });
      return send(res, 200, data);
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
    return serveStatic(req, res, p);
  } catch (e) {
    return send(res, e.status || 500, { error: e.message });
  }
});

/* ------------------------------------------------------------------ CLI */
async function warmAll() {
  for (const id of HERO_IDS) {
    try { const r = await getHero(id); console.log(`  ${r.cached ? 'cached ' : 'fetched'}  ${r.name}${r.errors?.length ? '  (' + r.errors.join('; ') + ')' : ''}`); }
    catch (e) { console.log(`  failed   ${LOOKUP.heroes[id].name}: ${e.message}`); }
  }
}
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
}
const args = process.argv.slice(2);
if (require.main !== module) { /* imported by tests */ }
else if (args[0] === '--scrape') {
  const q = norm(args[1] || 'warden');
  const id = HERO_IDS.find(k => k === q || LOOKUP.heroes[k].slug === q || norm(LOOKUP.heroes[k].name) === q);
  if (!id) { console.error('Unknown hero: ' + args[1]); process.exit(1); }
  getHero(id, { force: true }).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }, e => { console.error(e.message); process.exit(1); });
} else if (args[0] === '--export') {
  // Static export for GitHub Pages: refresh every hero, keep the last good data for any that fail.
  (async () => {
    const dir = path.resolve(args[1] || '_site');
    const heroes = {}; let fresh = 0, stale = 0, failed = 0, streak = 0;
    for (const id of HERO_IDS) {
      // Circuit breaker: if tracklock.gg keeps failing, stop hammering it and reuse the last good data.
      if (streak >= 4 && cache[id]) {
        const c = cache[id]; stale++;
        heroes[id] = { name: c.name, slug: c.slug, fetchedAt: c.fetchedAt, stale: true, pro: c.pro, build: c.build, errors: ['Skipped: tracklock.gg was failing this run'] };
        console.log(`  kept old  ${c.name}  (skipped, tracklock.gg was failing)`); continue;
      }
      try {
        const r = await getHero(id, { force: true });
        heroes[id] = { name: r.name, slug: r.slug, fetchedAt: r.fetchedAt, stale: !!r.stale, pro: r.pro, build: r.build, errors: r.errors || [] };
        if (r.stale) { stale++; streak++; } else { fresh++; streak = 0; }
        console.log(`  ${r.stale ? 'kept old' : 'updated '}  ${r.name}${r.errors && r.errors.length ? '  (' + r.errors.join('; ') + ')' : ''}`);
      } catch (e) { failed++; streak++; console.log(`  failed    ${LOOKUP.heroes[id].name}: ${e.message}`); }
    }
    flushCache();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tracklock.json'), JSON.stringify({ generatedAt: Date.now(), heroes }));
    console.log(`\nTracklock export: ${fresh} updated, ${stale} kept from the last run, ${failed} with no data. Wrote ${path.join(dir, 'tracklock.json')}`);
    if (fresh === 0) console.log('::warning::No hero could be refreshed from tracklock.gg this run. The site keeps the last good data. Check the log above for the reason.');
    process.exit(0);
  })();
} else if (args[0] === '--snapshot') {
  (async () => {
    await warmAll();
    const snap = {};
    for (const [id, v] of Object.entries(cache)) if (v.pro) snap[id] = { wr: v.pro.wr, g: v.pro.g, slug: v.slug, p: v.pro.p };
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap));
    console.log(`Wrote ${Object.keys(snap).length} heroes to ${path.relative(ROOT, SNAPSHOT_FILE)}. Run "python3 tools/build.py" to embed it in the app.`);
    process.exit(0);
  })();
} else {
  server.listen(PORT, HOST, () => {
    console.log(`\nBuildlock is running.`);
    console.log(`  On this computer:   http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  On your phone/LAN:  http://${ip}:${PORT}`);
    console.log(`  Tracklock data is cached for ${CACHE_HOURS}h in data/tracklock-cache.json. Press Ctrl+C to stop.\n`);
    if (args.includes('--warm') || process.env.WARM === '1') { console.log('Warming cache for all heroes...'); warmAll(); }
  });
}

module.exports = { parseProbuild, parseBuild, tokenize };
