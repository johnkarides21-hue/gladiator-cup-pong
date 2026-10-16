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
  ['Rudis Bearer (Freed)', '🕊️', 1720], ['Centurion', '🦅', 2100], ['Senator', '📜', 2520], ['Consul', '🏛️', 3000],
  ['Caesar', '🌿', 3600], ['Emperor of Rome', '👑', 4400]];
const EMPEROR = RANKS.length - 1;
const rankOf = (g) => { let i = 0; for (let k = 0; k < RANKS.length; k++) if (g >= RANKS[k][2]) i = k; return i; };
const START_COINS = 100;
const GLORY_WIN = { '1v1': 30, '2v2': 25, online: 40 }, GLORY_LOSS = { '1v1': 10, '2v2': 8, online: 12 };
const COINS_WIN = { '1v1': 10, '2v2': 8, online: 25 };
// An Emperor who beats a lower-ranked player collects a bounty from them: 10 coins, +5 for every rank they sit below the throne.
const bounty = (loserRank) => 10 + 5 * (EMPEROR - loserRank);

// ---------- storage ----------
let players = {};
try { players = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { players = {}; }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(players)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
    catch (e) { console.error('save failed', e.message); }
  }, 400);
}
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clean = (n) => String(n || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const pub = (p) => ({ id: p.id, name: p.name, glory: p.glory, coins: p.coins, w: p.w, l: p.l, streak: p.streak, best: p.best, rank: rankOf(p.glory) });
const newPlayer = (id, name) => ({ id, name, glory: 0, coins: START_COINS, w: 0, l: 0, streak: 0, best: 0, created: Date.now(), last: 0 });

function applyWin(p, mode, own) {
  let g = GLORY_WIN[mode] + Math.max(0, Math.min(10, own | 0));
  p.w++; p.streak++; if (p.streak > p.best) p.best = p.streak; if (p.streak >= 3) g += 5;
  const gl0 = p.glory, c0 = p.coins; p.glory += g; p.coins += COINS_WIN[mode];
  return { glory: p.glory - gl0, coins: p.coins - c0 };
}
function applyLoss(p, mode) {
  const gl0 = p.glory; p.l++; p.streak = 0; p.glory = Math.max(0, p.glory - GLORY_LOSS[mode]);
  return { glory: p.glory - gl0, coins: 0 };
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
  if (url === '/api/result' && req.method === 'POST') {
    // Results against the CPU. (Matches against other players are settled by the server itself over the WebSocket.)
    const d = await body(req), p = authed(d.id, d.secret);
    if (!p) { json(res, 401, { error: 'Not signed in.' }); return; }
    const mode = d.mode === '2v2' ? '2v2' : '1v1', now = Date.now();
    if (now - (lastCpu[p.id] || 0) < 15000) { json(res, 429, { error: 'Too fast.', profile: pub(p) }); return; }
    lastCpu[p.id] = now; p.last = now;
    const delta = d.win ? applyWin(p, mode, d.own) : applyLoss(p, mode);
    save(); json(res, 200, { profile: pub(p), delta });
    return;
  }
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('<head>', '<head>' + INJECT);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
});

// ---------- matchmaking + relay + online results ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
let waiting = null;
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const lite = (ws) => { const p = ws.pid && players[ws.pid]; return p ? { id: p.id, name: p.name, rank: rankOf(p.glory) } : null; };

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
  const wRank = rankOf(W.glory), lRank = rankOf(L.glory);
  const dw = applyWin(W, 'online', own), dl = applyLoss(L, 'online');
  let paid = 0;
  if (wRank === EMPEROR && lRank < EMPEROR) { paid = Math.min(L.coins, bounty(lRank)); L.coins -= paid; W.coins += paid; }
  dw.bounty = paid; dl.bounty = -paid; dw.coins += paid; dl.coins -= paid;
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
      if (waiting && waiting !== ws && waiting.readyState === 1) {
        const a = waiting; waiting = null;
        a.peer = ws; ws.peer = a;
        const match = { a, b: ws, reports: {} }; a.match = match; ws.match = match;
        send(a, { type: 'matched', role: 0, opp: lite(ws) }); send(ws, { type: 'matched', role: 1, opp: lite(a) });
      } else { waiting = ws; send(ws, { type: 'waiting' }); }
    } else if (d.type === 'ev' && ws.peer) {
      send(ws.peer, { type: 'ev', ev: d.ev });
    } else if (d.type === 'result' && ws.match && ws.pid) {
      const m = ws.match, g = String(d.game | 0);
      const r = (m.reports[g] = m.reports[g] || {});
      if (m.a.pid && m.b.pid && m.a.pid !== m.b.pid && !r[ws.pid]) { r[ws.pid] = { win: !!d.win, own: Math.max(0, Math.min(10, d.own | 0)) }; settle(m, g); }
    } else if (d.type === 'cancel') {
      if (waiting === ws) waiting = null;
    }
  });
  ws.on('close', () => {
    if (waiting === ws) waiting = null;
    if (ws.peer) {
      const p = ws.peer, m = ws.match; ws.peer = null; p.peer = null; send(p, { type: 'left' });
      // The player who stayed may have reported a loss already; settle it now that the other side is gone.
      if (m) for (const g of Object.keys(m.reports)) settle(m, g);
    }
  });
});

setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) { ws.terminate(); return; } ws.isAlive = false; ws.ping(); }), 25000);

server.listen(PORT, () => console.log('Gladiator Cup Pong server on port ' + PORT + ' (data: ' + DATA_FILE + ')'));
