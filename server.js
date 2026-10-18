// Gladiator Cup Pong - server: serves the game, matches players, keeps accounts, ranks, coins and leaderboards.
//
// Environment variables (all optional):
//   PORT              port to listen on (default 8080)
//   DATA_FILE         where player data is saved (default ./data/players.json). On free hosts the disk is wiped when the
//                     server redeploys, so for permanent ranks attach a persistent disk and point DATA_FILE at it.
//   GOOGLE_CLIENT_ID  your Google OAuth Web Client ID. When set, "Sign in with Google" tokens are verified here.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'players.json');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const INJECT = '<script>window.YANNI_WS=(location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws";window.YANNI_API=location.origin;</script>';

// ---------- ranks, glory, coins (the rules live here so players cannot edit them) ----------
const RANKS = [
  ['Ludus Trainee', '🪵', 0], ['Tiro', '🗡️', 60], ['Retiarius', '🔱', 150], ['Secutor', '🛡️', 270], ['Thraex', '🏹', 420],
  ['Murmillo', '⚔️', 600], ['Hoplomachus', '🔰', 820], ['Provocator', '🔥', 1080], ['Champion of the Arena', '🏆', 1380],
  ['Rudis Bearer (Freed)', '🕊️', 1720], ['Centurion', '🦅', 6000], ['Senator', '📜', 8400], ['Consul', '🏛️', 11200],
  ['Caesar', '🌿', 14400], ['Emperor of Rome', '👑', 19000]];
const EMPEROR = RANKS.length - 1;
const rankOf = (g) => { let i = 0; for (let k = 0; k < RANKS.length; k++) if (g >= RANKS[k][2]) i = k; return i; };
// Top ranks are capped: each of the top 5 classes (Centurion to Emperor) holds at most TOP_CAP players.
// The glory figures above are the minimums. Players are ranked by glory within each class, and anyone pushed
// past the cap drops to the next class down. This table is rebuilt from scratch on every save.
const TOP_CAP = 50, TOP_FROM = 10;
let rkMap = new Map();
function assignRanks() {
  const all = Object.values(players), m = new Map();
  for (const p of all) m.set(p.id, Math.min(rankOf(p.glory), TOP_FROM - 1));
  const taken = new Set();
  for (let k = EMPEROR; k >= TOP_FROM; k--) {
    const pool = all.filter((p) => !taken.has(p.id) && p.glory >= RANKS[k][2])
      .sort((a, b) => b.glory - a.glory || (a.id < b.id ? -1 : 1)).slice(0, TOP_CAP);
    for (const p of pool) { m.set(p.id, k); taken.add(p.id); }
  }
  rkMap = m;
}
const rk = (p) => (rkMap.has(p.id) ? rkMap.get(p.id) : Math.min(rankOf(p.glory), TOP_FROM - 1));
const START_COINS = 100;
const GLORY_WIN = { '1v1': 30, '2v2': 25, online: 40 }, GLORY_LOSS = { '1v1': 10, '2v2': 8, online: 12 };
const COINS_WIN = { '1v1': 10, '2v2': 8, online: 25 };
// An Emperor who beats a lower-ranked player collects a bounty from them: 10 coins, +5 for every rank they sit below the throne.
const bounty = (loserRank) => 10 + 5 * (EMPEROR - loserRank);
// Tribute: the ten lowest ranks (below Centurion) pay a small tribute to the Imperial Treasury after every game.
// Against an Emperor of Rome they also pay a larger tribute straight to that Emperor. The #1 gladiator
// receives a daily crown bonus minted by the game itself.
const TRIBUTE_SMALL = 5, TRIBUTE_EMPEROR = 15, CROWN_BONUS = 300;

// ---------- storage ----------
let players = {};
try { players = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { players = {}; }
assignRanks();
const META_FILE = path.join(path.dirname(DATA_FILE), 'meta.json');
let meta = { treasury: 0, lastCrownDay: '' };
try { meta = Object.assign(meta, JSON.parse(fs.readFileSync(META_FILE, 'utf8'))); } catch (e) { /* first run */ }
function saveMeta() {
  try { fs.mkdirSync(path.dirname(META_FILE), { recursive: true }); fs.writeFileSync(META_FILE + '.tmp', JSON.stringify(meta)); fs.renameSync(META_FILE + '.tmp', META_FILE); }
  catch (e) { console.error('meta save failed', e.message); }
}
// Pays one game's tribute from a player in the bottom ten. Returns what was paid (to the treasury and to an Emperor).
function settleTribute(p, pr, oppRank, opp) {
  const out = { small: 0, emp: 0 };
  if (pr >= TOP_FROM) return out;
  out.small = Math.min(p.coins, TRIBUTE_SMALL); p.coins -= out.small; meta.treasury += out.small;
  if (opp && oppRank === EMPEROR) { out.emp = Math.min(p.coins, TRIBUTE_EMPEROR); p.coins -= out.emp; opp.coins += out.emp; }
  return out;
}
// Once per UTC day, the top-glory gladiator is crowned and receives the bonus.
function dailyCrown() {
  const day = new Date().toISOString().slice(0, 10);
  if (meta.lastCrownDay === day) return;
  const all = Object.values(players).filter((p) => p.glory > 0);
  if (!all.length) return;
  all.sort((a, b) => b.glory - a.glory || (a.id < b.id ? -1 : 1));
  const top = all[0];
  top.coins += CROWN_BONUS; meta.lastCrownDay = day; save(); saveMeta();
  console.log('crown bonus to', top.name, 'for', day);
}
setInterval(dailyCrown, 60 * 1000); setTimeout(dailyCrown, 3000);
let saveTimer = null;
function save() {
  assignRanks(); saveMeta();
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(players)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
    catch (e) { console.error('save failed', e.message); }
  }, 400);
}
const AV_PRICE = { recruit: 0, murmillo: 80, thraex: 160, retiarius: 260, centurion: 400, champion: 700 };
const ITEM_PRICE = { eagle: 500, wind: 750, aegis: 1000, phoenix: 1500 };
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clean = (n) => String(n || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const pub = (p) => ({ id: p.id, name: p.name, glory: p.glory, coins: p.coins, w: p.w, l: p.l, streak: p.streak, best: p.best, rank: rk(p), av: p.av || { own: ['recruit'], sel: 'recruit' }, inv: p.inv || { eagle: 0, aegis: 0, wind: 0, phoenix: 0 } });
const newPlayer = (id, name) => ({ id, name, glory: 0, coins: START_COINS, w: 0, l: 0, streak: 0, best: 0, created: Date.now(), last: 0 });

// CPU difficulty: 0 Easy, 1 Medium, 2 Hard, 3 Emperor. Bigger rewards for beating harder CPUs, bigger losses to them.
const DIFF_MUL = [{ w: 0.2, l: 0.2 }, { w: 0.4, l: 0.4 }, { w: 1.6, l: 2.5 }, { w: 2.5, l: 4 }];
const LOSS_COINS = { '1v1': 5, '2v2': 4 };
const dfix = (d) => Math.max(0, Math.min(3, Number(d) | 0));
function applyWin(p, mode, own, diff) {
  const m = DIFF_MUL[dfix(diff)].w;
  let g = GLORY_WIN[mode] + Math.max(0, Math.min(10, own | 0));
  p.w++; p.streak++; if (p.streak > p.best) p.best = p.streak; if (p.streak >= 3) g += 5;
  g = Math.round(g * m);
  const gl0 = p.glory, c0 = p.coins; p.glory += g; p.coins += Math.round(COINS_WIN[mode] * m);
  return { glory: p.glory - gl0, coins: p.coins - c0 };
}
function applyLoss(p, mode, diff) {
  const m = DIFF_MUL[dfix(diff)].l;
  const gl0 = p.glory, c0 = p.coins;
  p.l++; p.streak = 0;
  p.glory = Math.max(0, p.glory - Math.round(GLORY_LOSS[mode] * m));
  p.coins = Math.max(0, p.coins - Math.round((LOSS_COINS[mode] || 0) * m));
  return { glory: p.glory - gl0, coins: p.coins - c0 };
}

// ---------- http helpers ----------
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const json = (res, code, o) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, CORS)); res.end(JSON.stringify(o)); };
function body(req) {
  return new Promise((ok) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 8192) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ok({}); } }); req.on('error', () => ok({}));
  });
}
async function googleVerify(credential) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) return null;
  const t = await r.json();
  if (GOOGLE_CLIENT_ID && t.aud !== GOOGLE_CLIENT_ID) return null;
  if (!t.sub) return null;
  return { id: 'g:' + t.sub, name: clean(t.given_name || t.name) || 'Gladiator' };
}
function authed(id, secret) { const p = players[id]; return p && p.secret && secret && p.secret === hash(secret) ? p : null; }

function leaderboard() {
  const all = Object.values(players).map((p) => Object.assign(pub(p), { last: p.last || 0 }));
  const sorter = (a, b) => b.glory - a.glory || b.coins - a.coins || a.name.localeCompare(b.name);
  all.sort(sorter);
  const byRank = {};
  for (const p of all) (byRank[p.rank] = byRank[p.rank] || []).push(p);
  for (const k of Object.keys(byRank)) byRank[k] = byRank[k].slice(0, 10);
  return { overall: all.slice(0, 25), byRank, players: all.length, updated: Date.now() };
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function leaderboardPage() {
  const lb = leaderboard();
  const row = (p, i) => `<tr><td>${i + 1}</td><td>${RANKS[p.rank][1]} ${esc(p.name)}</td><td>${esc(RANKS[p.rank][0])}</td><td>${p.glory}</td><td>🪙 ${p.coins}</td><td>${p.w}-${p.l}</td></tr>`;
  let h = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Gladiator Cup Pong - Leaderboard</title><style>body{background:#1a0f08;color:#f0dcb0;font-family:Georgia,serif;max-width:760px;margin:auto;padding:14px}h1,h2{color:#f2d27a;font-variant:small-caps}table{width:100%;border-collapse:collapse;margin-bottom:18px}td,th{padding:6px 8px;border-bottom:1px solid #3a2a1b;text-align:left;font-size:14px}th{color:#c9a977}</style><h1>⚔ Gladiator Cup Pong - Leaderboard</h1>';
  h += `<p>${lb.players} gladiators</p><h2>Overall</h2><table><tr><th>#</th><th>Gladiator</th><th>Rank</th><th>Glory</th><th>Coins</th><th>W-L</th></tr>${lb.overall.map(row).join('')}</table>`;
  for (let k = EMPEROR; k >= 0; k--) if (lb.byRank[k]) h += `<h2>${RANKS[k][1]} ${esc(RANKS[k][0])}</h2><table><tr><th>#</th><th>Gladiator</th><th>Rank</th><th>Glory</th><th>Coins</th><th>W-L</th></tr>${lb.byRank[k].map(row).join('')}</table>`;
  return h;
}

// ---------- http server ----------
const lastCpu = {};
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (url === '/api/leaderboard') { json(res, 200, leaderboard()); return; }
  if (url === '/leaderboard') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(leaderboardPage()); return; }
  if (url === '/api/login' && req.method === 'POST') {
    const d = await body(req);
    if (d.kind === 'resume') { const rp = authed(String(d.id || ''), d.secret); if (!rp) { json(res, 401, { error: 'Please sign in again.' }); return; } rp.last = Date.now(); json(res, 200, { profile: pub(rp) }); return; }
    let id, name;
    if (d.kind === 'google') {
      const g = await googleVerify(String(d.credential || '')).catch(() => null);
      if (!g) { json(res, 401, { error: 'Google sign-in could not be verified.' }); return; }
      id = g.id; name = g.name;
    } else {
      name = clean(d.name);
      if (name.length < 2) { json(res, 400, { error: 'Pick a gladiator name (at least 2 letters).' }); return; }
      id = 'guest:' + name.toLowerCase();
    }
    let p = players[id];
    const secret = d.kind === 'google' ? crypto.randomBytes(18).toString('hex') : String(d.secret || '');
    if (!p) {
      p = players[id] = newPlayer(id, name);
      const s = secret || crypto.randomBytes(18).toString('hex');
      p.secret = hash(s); p.last = Date.now(); save();
      json(res, 200, { profile: pub(p), secret: s, created: true }); return;
    }
    if (d.kind === 'google') { p.secret = hash(secret); p.last = Date.now(); save(); json(res, 200, { profile: pub(p), secret }); return; }
    if (!authed(id, secret)) { json(res, 409, { error: 'That gladiator name is already taken. Choose another name.' }); return; }
    p.last = Date.now(); save(); json(res, 200, { profile: pub(p), secret });
    return;
  }
  if (url === '/api/avatar' && req.method === 'POST') {
    const d = await body(req), p = authed(d.id, d.secret);
    if (!p) { json(res, 401, { error: 'Not signed in.' }); return; }
    const item = String(d.item || '');
    if (!(item in AV_PRICE)) { json(res, 400, { error: 'Unknown armor.' }); return; }
    if (!p.av) p.av = { own: ['recruit'], sel: 'recruit' };
    if (d.action === 'buy') {
      if (p.av.own.includes(item)) { json(res, 200, { profile: pub(p) }); return; }
      if (p.coins < AV_PRICE[item]) { json(res, 400, { error: 'Not enough coins.', profile: pub(p) }); return; }
      p.coins -= AV_PRICE[item]; p.av.own.push(item); p.av.sel = item;
    } else if (p.av.own.includes(item)) p.av.sel = item;
    else { json(res, 400, { error: 'You do not own that yet.' }); return; }
    save(); json(res, 200, { profile: pub(p) }); return;
  }
  if (url === '/api/shop' && req.method === 'POST') {
    const d = await body(req), p = authed(d.id, d.secret);
    if (!p) { json(res, 401, { error: 'Not signed in.' }); return; }
    const item = String(d.item || '');
    if (!(item in ITEM_PRICE)) { json(res, 400, { error: 'Unknown item.' }); return; }
    if (!p.inv) p.inv = { eagle: 0, aegis: 0, wind: 0, phoenix: 0 };
    if (d.action === 'buy') {
      if ((p.inv[item] | 0) >= 9) { json(res, 400, { error: 'You carry the maximum.', profile: pub(p) }); return; }
      if (p.coins < ITEM_PRICE[item]) { json(res, 400, { error: 'Not enough coins.', profile: pub(p) }); return; }
      p.coins -= ITEM_PRICE[item]; p.inv[item] = (p.inv[item] | 0) + 1;
    } else if (d.action === 'use') {
      if ((p.inv[item] | 0) < 1) { json(res, 400, { error: 'You have none.', profile: pub(p) }); return; }
      p.inv[item]--;
    } else { json(res, 400, { error: 'Bad request.' }); return; }
    save(); json(res, 200, { profile: pub(p) }); return;
  }
  if (url === '/api/result' && req.method === 'POST') {
    // Results against the CPU. (Matches against other players are settled by the server itself over the WebSocket.)
    const d = await body(req), p = authed(d.id, d.secret);
    if (!p) { json(res, 401, { error: 'Not signed in.' }); return; }
    const mode = d.mode === '2v2' ? '2v2' : '1v1', now = Date.now();
    if (now - (lastCpu[p.id] || 0) < 15000) { json(res, 429, { error: 'Too fast.', profile: pub(p) }); return; }
    lastCpu[p.id] = now; p.last = now;
    const r0 = rk(p);
    const delta = d.win ? applyWin(p, mode, d.own, d.diff) : applyLoss(p, mode, d.diff);
    const t = settleTribute(p, r0, -1, null); delta.coins -= t.small + t.emp;
    save(); json(res, 200, { profile: pub(p), delta });
    return;
  }
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('<head>', '<head>' + INJECT);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
});

// ---------- matchmaking + relay + online results ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
// Matchmaking queue. Players are paired with someone of similar glory when one is waiting. If nobody similar
// is waiting, a player who has searched for SEARCH_WAIT ms is paired with the nearest-skill opponent available.
let queue = [];
const SEARCH_WAIT = 3000;
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const skillOf = (ws) => { const p = ws.pid && players[ws.pid]; return p ? p.glory : 0; };
const similar = (a, b) => Math.abs(skillOf(a) - skillOf(b)) <= Math.max(100, 0.15 * Math.max(skillOf(a), skillOf(b)));
function pairUp(a, b) {
  queue = queue.filter((x) => x !== a && x !== b);
  a.peer = b; b.peer = a;
  const match = { a, b, reports: {} }; a.match = match; b.match = match;
  // The shared seed lets both screens agree on who shoots first, game after game, without extra messages.
  const seed = Math.floor(Math.random() * 4294967296);
  send(a, { type: 'matched', role: 0, opp: lite(b), seed }); send(b, { type: 'matched', role: 1, opp: lite(a), seed });
}
function matchmake() {
  queue = queue.filter((w) => w.readyState === 1 && !w.peer);
  const now = Date.now();
  let progressed = true;
  while (progressed && queue.length > 1) {
    progressed = false;
    for (const w of queue) {
      let best = null, bd = Infinity;
      for (const c of queue) {
        if (c === w) continue;
        const d = Math.abs(skillOf(w) - skillOf(c));
        if (d < bd) { bd = d; best = c; }
      }
      if (!best) continue;
      if (similar(w, best) || now - (w.joined || now) >= SEARCH_WAIT) { pairUp(w, best); progressed = true; break; }
    }
  }
}
setInterval(matchmake, 500);
const lite = (ws) => { const p = ws.pid && players[ws.pid]; return p ? { id: p.id, name: p.name, rank: rk(p) } : null; };

// A result is settled only when BOTH players report it and the reports agree (exactly one winner).
// A lone claim of victory is never accepted; a lone "I lost" is accepted once the other player has left.
function settle(match, game) {
  const r = match.reports[game]; if (!r || r.done) return;
  const a = r[match.a.pid], b = r[match.b.pid];
  let winner = null, loser = null, own = 0;
  if (a && b) {
    if (a.win === b.win) { r.done = true; return; }
    winner = a.win ? match.a.pid : match.b.pid; loser = winner === match.a.pid ? match.b.pid : match.a.pid; own = (a.win ? a : b).own;
  } else if ((a && !a.win) || (b && !b.win)) {
    if (match.a.readyState === 1 && match.b.readyState === 1) return;
    loser = a && !a.win ? match.a.pid : match.b.pid; winner = loser === match.a.pid ? match.b.pid : match.a.pid; own = 0;
  } else return;
  r.done = true;
  const W = players[winner], L = players[loser]; if (!W || !L || W.id === L.id) return;
  const wRank = rk(W), lRank = rk(L);
  const dw = applyWin(W, 'online', own), dl = applyLoss(L, 'online');
  let paid = 0;
  if (wRank === EMPEROR && lRank < EMPEROR) { paid = Math.min(L.coins, bounty(lRank)); L.coins -= paid; W.coins += paid; }
  dw.bounty = paid; dl.bounty = -paid; dw.coins += paid; dl.coins -= paid;
  const tW = settleTribute(W, wRank, lRank, L), tL = settleTribute(L, lRank, wRank, W);
  dw.coins += tL.emp - tW.small - tW.emp; dl.coins += tW.emp - tL.small - tL.emp;
  W.last = L.last = Date.now(); save();
  for (const s of [match.a, match.b]) {
    const me = s.pid === winner ? W : L, d = s.pid === winner ? dw : dl;
    send(s, { type: 'profile', profile: pub(me), delta: d, win: s.pid === winner, vs: s.pid === winner ? L.name : W.name });
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true; ws.peer = null; ws.pid = null; ws.match = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (d.type === 'find') {
      if (ws.peer) return;
      const p = authed(d.id, d.secret); ws.pid = p ? p.id : null;
      if (!queue.includes(ws)) { ws.joined = Date.now(); queue.push(ws); }
      matchmake();
      if (queue.includes(ws)) send(ws, { type: 'waiting' });
    } else if (d.type === 'ev' && ws.peer) {
      send(ws.peer, { type: 'ev', ev: d.ev });
    } else if (d.type === 'result' && ws.match && ws.pid) {
      const m = ws.match, g = String(d.game | 0);
      const r = (m.reports[g] = m.reports[g] || {});
      if (m.a.pid && m.b.pid && m.a.pid !== m.b.pid && !r[ws.pid]) { r[ws.pid] = { win: !!d.win, own: Math.max(0, Math.min(10, d.own | 0)) }; settle(m, g); }
    } else if (d.type === 'cancel') {
      queue = queue.filter((x) => x !== ws);
    }
  });
  ws.on('close', () => {
    queue = queue.filter((x) => x !== ws);
    if (ws.peer) {
      const p = ws.peer, m = ws.match; ws.peer = null; p.peer = null; send(p, { type: 'left' });
      // The player who stayed may have reported a loss already; settle it now that the other side is gone.
      if (m) for (const g of Object.keys(m.reports)) settle(m, g);
    }
  });
});

setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) { ws.terminate(); return; } ws.isAlive = false; ws.ping(); }), 25000);

server.listen(PORT, () => console.log('Gladiator Cup Pong server on port ' + PORT + ' (data: ' + DATA_FILE + ')'));
