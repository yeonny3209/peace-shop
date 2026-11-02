/* 피스 상점 서버 — 의존성 없는 Node.js 서버. 정적 파일 + 공유 저장소(JSON 파일) API.
 * 실행: node server.js  (포트 변경: PORT=8080 node server.js) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const DEFAULT_PASSWORD = '1234';
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/guide.html': 'guide.html',
  '/style.css': 'style.css', '/app.js': 'app.js',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

fs.mkdirSync(DATA_DIR, { recursive: true });
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
};

let db = readJson(STATE_FILE, { rev: 0, state: null });
let auth = readJson(AUTH_FILE, { passwordHash: null });
const tokens = new Set();

const publicState = (state) => state && { ...state, settings: { ...state.settings, passwordHash: null, passwordSet: !!auth.passwordHash } };
const view = () => ({ rev: db.rev, state: publicState(db.state) });
const commit = (state) => { db = { rev: db.rev + 1, state }; writeJson(STATE_FILE, db); };

// 일반 가족(비로그인)은 구매 요청 추가와 자기 요청 취소만 할 수 있다.
function mergeFamily(cur, inc) {
  const out = { ...cur, requests: [...cur.requests] };
  const byId = new Map(out.requests.map((r) => [r.id, r]));
  for (const r of Array.isArray(inc.requests) ? inc.requests : []) {
    const old = byId.get(r?.id);
    if (old) {
      if (old.status === 'pending' && r.status === 'cancelled') { old.status = 'cancelled'; old.doneTime = Date.now(); }
      continue;
    }
    if (!r || r.status !== 'pending' || !cur.members.some((m) => m.id === r.memberId)) continue;
    const base = { id: String(r.id || uid()), memberId: r.memberId, time: Date.now(), status: 'pending' };
    if (r.type === 'purchase') {
      const p = cur.products.find((x) => x.id === r.productId);
      if (p) out.requests.push({ ...base, type: 'purchase', productId: p.id, productName: p.name, price: p.price });
    } else if (r.type === 'bonus') {
      out.requests.push({ ...base, type: 'bonus', title: String(r.title || '').slice(0, 40) });
    }
  }
  return out;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function api(req, res, url) {
  const t = req.headers['x-token'];
  const isAdmin = !!t && tokens.has(t);
  if (t && !isAdmin) return send(res, 401, { error: 'login required' });

  if (url === '/api/state' && req.method === 'GET') return send(res, 200, view());

  if (url === '/api/state' && req.method === 'PUT') {
    const { rev, state } = await body(req);
    if (!state || !Array.isArray(state.members) || !Array.isArray(state.products) || !Array.isArray(state.requests) || !Array.isArray(state.history)) {
      return send(res, 400, { error: 'bad state' });
    }
    if (isAdmin) {
      if (rev !== db.rev) return send(res, 409, view());
      commit({ ...state, settings: { ...state.settings, passwordHash: null, passwordSet: undefined } });
    } else if (db.state) {
      commit(mergeFamily(db.state, state));
    } else {
      return send(res, 403, { error: 'not initialised' });
    }
    return send(res, 200, view());
  }

  if (url === '/api/init' && req.method === 'POST') {
    if (db.state) return send(res, 200, view());
    const { state } = await body(req);
    if (!state || !Array.isArray(state.members)) return send(res, 400, { error: 'bad state' });
    commit({ ...state, settings: { ...state.settings, passwordHash: null, passwordSet: undefined } });
    return send(res, 200, view());
  }

  if (url === '/api/login' && req.method === 'POST') {
    const { pw } = await body(req);
    if (sha256(String(pw ?? '')) !== (auth.passwordHash || sha256(DEFAULT_PASSWORD))) return send(res, 403, { error: 'wrong password' });
    const token = crypto.randomBytes(24).toString('hex');
    tokens.add(token);
    return send(res, 200, { token });
  }

  if (url === '/api/password' && req.method === 'POST') {
    if (!isAdmin) return send(res, 401, { error: 'login required' });
    const { current, next } = await body(req);
    if (sha256(String(current ?? '')) !== (auth.passwordHash || sha256(DEFAULT_PASSWORD))) return send(res, 403, { error: 'wrong password' });
    if (String(next ?? '').length < 4) return send(res, 400, { error: 'too short' });
    auth = { passwordHash: sha256(String(next)) };
    writeJson(AUTH_FILE, auth);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  try {
    if (url.startsWith('/api/')) return await api(req, res, url);
    const file = STATIC[url];
    if (!file || req.method !== 'GET') { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-cache' });
    fs.createReadStream(path.join(ROOT, file)).pipe(res);
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`피스 상점 서버가 켜졌어요 (데이터: ${STATE_FILE})`);
  console.log(`  이 컴퓨터:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  같은 와이파이의 가족 기기:  http://${i.address}:${PORT}`);
  }
});
