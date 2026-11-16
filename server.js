/* 피스 상점 서버 — 의존성 없는 Node.js(18+) 서버. 정적 파일 + 공유 저장소 API.
 * 저장소: UPSTASH_REDIS_REST_URL/TOKEN이 있으면 Upstash Redis(Render 등 클라우드용),
 *         없으면 DATA_DIR(기본 ./data)의 JSON 파일.
 * 실행: node server.js  (포트: PORT 환경변수) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const webpush = require('web-push');
const Market = require('./stock-market');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DEFAULT_PASSWORD = '1234';
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/guide.html': 'guide.html',
  '/style.css': 'style.css', '/app.js': 'app.js', '/sw.js': 'sw.js', '/manifest.json': 'manifest.json',
  '/stock-market.js': 'stock-market.js',
  '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/apple-touch-icon.png': 'apple-touch-icon.png',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/manifest+json', '.png': 'image/png' };

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// ---------- 저장소 ----------
const store = REDIS_URL
  ? {
    label: 'Upstash Redis',
    async cmd(args) {
      const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`redis ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error('redis command failed');
      return data.result;
    },
    async get(key) { const v = await this.cmd(['GET', `peace-shop:${key}`]); return v ? JSON.parse(v) : null; },
    async set(key, val) { await this.cmd(['SET', `peace-shop:${key}`, JSON.stringify(val)]); },
  }
  : {
    label: DATA_DIR,
    async get(key) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${key}.json`), 'utf8')); } catch { return null; } },
    async set(key, val) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const file = path.join(DATA_DIR, `${key}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(val, null, 2));
      fs.renameSync(tmp, file);
    },
  };

let db = { rev: 0, state: null };
let auth = { passwordHash: null, secret: null, vapid: null };
let subs = []; // 알림을 받을 엄마 기기들(Web Push 구독)

// 로그인 토큰은 서버 재시작·잠들기 뒤에도 유지되도록 비밀값에서 계산한다(비밀번호를 바꾸면 무효가 됨).
const makeToken = () => crypto.createHmac('sha256', auth.secret).update(auth.passwordHash || 'default').digest('hex');
const passwordOk = (pw) => sha256(String(pw ?? '')) === (auth.passwordHash || sha256(DEFAULT_PASSWORD));

// SEED_MEMBERS="세윤:164,시연:163,소율:71" — 처음 만들어질 때 가족과 시작 피스를 넣는다.
function seed(state) {
  if (state.members.length || !process.env.SEED_MEMBERS) return state;
  const now = Date.now();
  for (const part of process.env.SEED_MEMBERS.split(',')) {
    const [name, bal] = part.split(':');
    const balance = Math.max(0, parseInt(bal, 10) || 0);
    if (!name?.trim()) continue;
    const id = uid();
    state.members.push({ id, name: name.trim(), balance, carry: { math: 0, other: 0 } });
    state.history.push({ id: `${id}h`, time: now, memberId: id, delta: balance, reason: '시작 잔액', balanceAfter: balance });
  }
  return state;
}

const publicState = (state) => state && { ...state, settings: { ...state.settings, passwordHash: null, passwordSet: !!auth.passwordHash } };
const view = () => ({ rev: db.rev, state: publicState(db.state) });
const clean = (state) => ({ ...state, settings: { ...state.settings, passwordHash: null, passwordSet: undefined } });

async function commit(state) {
  const next = { rev: db.rev + 1, state };
  await store.set('state', next);
  db = next;
}

// 쓰기 요청은 하나씩 차례로 처리한다.
let lock = Promise.resolve();
const locked = (fn) => { const run = lock.then(fn, fn); lock = run.catch(() => {}); return run; };

// 일반 가족은 기존 상점 요청만 수정한다. 주식 요청은 /api/market에서 검증한다.
function mergeFamily(cur, inc) {
  const out = JSON.parse(JSON.stringify(cur));
  const byId = new Map(out.requests.map((r) => [r.id, r]));
  const originalIds = new Set(byId.keys());
  for (const r of Array.isArray(inc.requests) ? inc.requests : []) {
    const old = byId.get(r?.id);
    if (old) {
      if (old.type !== 'stock' && old.memberId === r.memberId && old.status === 'pending' && r.status === 'cancelled') {
        old.status = 'cancelled'; old.doneTime = Date.now();
      }
      continue;
    }
    if (!r || r.status !== 'pending' || !cur.members.some((m) => m.id === r.memberId)) continue;
    const base = { id: String(r.id || uid()), memberId: r.memberId, time: Date.now(), status: 'pending' };
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(base.id)) continue;
    let request;
    if (r.type === 'purchase') {
      const p = cur.products.find((x) => x.id === r.productId);
      const m = cur.members.find((m) => m.id === r.memberId);
      if (p) {
        if (!Number.isSafeInteger(p.price) || p.price < 0 || m.balance - Market.reservedPieces(out, m.id) < p.price) {
          const e = new Error('승인 대기 중인 금액을 제외하면 피스가 부족해요.'); e.status = 422; throw e;
        }
        if (p.stock !== null && p.stock <= 0) { const e = new Error('품절된 상품이에요.'); e.status = 422; throw e; }
        request = { ...base, type: 'purchase', productId: p.id, productName: p.name, price: p.price };
      }
    } else if (r.type === 'bonus') {
      request = { ...base, type: 'bonus', title: String(r.title || '').slice(0, 40) };
    }
    if (request) { out.requests.push(request); byId.set(request.id, request); }
  }
  return { state: out, added: out.requests.filter((r) => !originalIds.has(r.id)) };
}

// 예전 화면의 전체 저장이나 위조된 필드가 주식 장부를 지우지 못하게 한다.
function mergeAdmin(cur, incoming) {
  const out = clean(JSON.parse(JSON.stringify(incoming)));
  const current = Market.ensure(JSON.parse(JSON.stringify(cur)));
  const stockIds = new Set(current.requests.filter((r) => r.type === 'stock').map((r) => r.id));
  for (const r of out.requests) {
    const old = current.requests.find((p) => p.id === r.id && p.type === 'stock');
    if (old && (r.type !== 'stock' || r.status !== old.status || r.price !== old.price || r.quantity !== old.quantity)) {
      const e = new Error('주식 요청은 새로고침한 화면의 주식 승인 기능으로 처리해 주세요.'); e.status = 409; throw e;
    }
  }
  const stockHistory = current.history.filter((r) => r.marketRequestId);
  const historyIds = new Set(stockHistory.map((r) => r.id));
  out.market = current.market;
  out.requests = out.requests.filter((r) => r.type !== 'stock' && !stockIds.has(r.id))
    .concat(current.requests.filter((r) => r.type === 'stock'));
  out.history = out.history.filter((r) => !r.marketRequestId && !historyIds.has(r.id)).concat(stockHistory)
    .sort((a, b) => a.time - b.time);
  for (const m of current.members) {
    if (out.members.some((n) => n.id === m.id)) continue;
    if (out.market.holdings.some((p) => p.memberId === m.id && p.quantity > 0)
      || out.requests.some((r) => r.type === 'stock' && r.memberId === m.id && r.status === 'pending')) {
      const e = new Error('보유 주식과 주식 대기 요청을 정리한 뒤 가족을 삭제해 주세요.'); e.status = 422; throw e;
    }
  }
  out.market.holdings = out.market.holdings.filter((p) => out.members.some((m) => m.id === p.memberId));
  Market.validate(out);
  return out;
}

// ---------- 알림 (Web Push) ----------
async function pushAll(payload) {
  const dead = new Set();
  await Promise.all(subs.map((s) => webpush.sendNotification(s, JSON.stringify(payload), { TTL: 86400 }).catch((e) => {
    if (e.statusCode === 404 || e.statusCode === 410) dead.add(s.endpoint);
    else console.error('push 실패', e.statusCode || e.message);
  })));
  if (dead.size) {
    subs = subs.filter((s) => !dead.has(s.endpoint));
    await store.set('push', subs);
  }
}

async function notify(added, state) {
  if (!subs.length) return;
  for (const r of added) {
    const name = state.members.find((m) => m.id === r.memberId)?.name || '가족';
    const body = r.type === 'stock'
      ? `${name}: ${r.companyName} ${r.quantity}주 ${r.side === 'buy' ? '매수' : '매도'} 요청 (${r.price}피스)`
      : r.type === 'purchase' ? `${name}: ${r.productName} 구매 요청 (${r.price}피스)` : `${name}: 📚 ${r.title} 완주 신고`;
    await pushAll({ title: '피스 상점 새 요청', body, url: '/#admin' });
  }
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

const validState = (s) => s && ['members', 'products', 'requests', 'history'].every((k) => Array.isArray(s[k]));

async function api(req, res, url) {
  const t = req.headers['x-token'];
  const isAdmin = !!t && t === makeToken();
  if (t && !isAdmin) return send(res, 401, { error: 'login required' });

  if (url === '/api/state' && req.method === 'GET') return send(res, 200, view());

  if (url === '/api/state' && req.method === 'PUT') {
    const { rev, state } = await body(req);
    if (!validState(state)) return send(res, 400, { error: 'bad state' });
    return locked(async () => {
      if (isAdmin) {
        if (rev !== db.rev) return send(res, 409, view());
        await commit(db.state ? mergeAdmin(db.state, state) : Market.ensure(clean(state)));
      } else if (db.state) {
        const { state: next, added } = mergeFamily(db.state, state);
        await commit(next);
        notify(added, next).catch((e) => console.error('push 실패', e.message));
      } else {
        return send(res, 403, { error: 'not initialised' });
      }
      return send(res, 200, view());
    });
  }

  // 백업 복원과 전체 초기화만 명시적으로 주식 장부까지 교체할 수 있다.
  if (url === '/api/state/replace' && req.method === 'POST') {
    if (!isAdmin) return send(res, 401, { error: '엄마 로그인이 필요해요.' });
    const { rev, state } = await body(req);
    if (!validState(state)) return send(res, 400, { error: '올바른 상점 백업이 아니에요.' });
    return locked(async () => {
      if (rev !== db.rev) return send(res, 409, { error: '다른 기기에서 바뀌었어요. 다시 확인해 주세요.', ...view() });
      const next = Market.ensure(clean(state));
      Market.validate(next);
      await commit(next);
      return send(res, 200, view());
    });
  }

  if (url === '/api/market' && req.method === 'POST') {
    const payload = await body(req);
    return locked(async () => {
      if (!db.state) return send(res, 403, { error: '상점을 먼저 열어 주세요.' });
      const before = new Set(db.state.requests.map((r) => r.id));
      const next = Market.apply(db.state, payload.action, payload, { isAdmin, id: uid });
      await commit(next);
      const added = next.requests.filter((r) => r.type === 'stock' && r.status === 'pending' && !before.has(r.id));
      if (added.length) notify(added, next).catch((e) => console.error('push 실패', e.message));
      return send(res, 200, view());
    });
  }

  if (url === '/api/init' && req.method === 'POST') {
    const { state } = await body(req);
    if (!validState(state)) return send(res, 400, { error: 'bad state' });
    return locked(async () => {
      if (!db.state) {
        const next = Market.ensure(seed(clean(state)));
        Market.validate(next);
        await commit(next);
      }
      return send(res, 200, view());
    });
  }

  if (url === '/api/push/key' && req.method === 'GET') return send(res, 200, { key: auth.vapid.publicKey });

  if (url === '/api/push/subscribe' && req.method === 'POST') {
    if (!isAdmin) return send(res, 401, { error: 'login required' });
    const { subscription: sub } = await body(req);
    if (!String(sub?.endpoint).startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) return send(res, 400, { error: 'bad subscription' });
    return locked(async () => {
      subs = [...subs.filter((s) => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }];
      await store.set('push', subs);
      return send(res, 200, { ok: true, devices: subs.length });
    });
  }

  if (url === '/api/push/unsubscribe' && req.method === 'POST') {
    if (!isAdmin) return send(res, 401, { error: 'login required' });
    const { endpoint } = await body(req);
    return locked(async () => {
      subs = subs.filter((s) => s.endpoint !== endpoint);
      await store.set('push', subs);
      return send(res, 200, { ok: true, devices: subs.length });
    });
  }

  if (url === '/api/push/test' && req.method === 'POST') {
    if (!isAdmin) return send(res, 401, { error: 'login required' });
    await pushAll({ title: '피스 상점', body: '알림이 잘 와요! 🎉', url: '/#admin' });
    return send(res, 200, { ok: true, devices: subs.length });
  }

  // 가족끼리 피스 양도: 엄마 승인 없이 바로 처리. 잔액 확인과 이체를 한 번에(잠금 안에서) 한다.
  if (url === '/api/transfer' && req.method === 'POST') {
    const { fromId, toId, amount } = await body(req);
    const n = Number(amount);
    return locked(async () => {
      const st = db.state;
      if (!st) return send(res, 403, { error: 'not initialised' });
      if (st.settings?.transfer === false) return send(res, 403, { error: 'disabled' });
      const from = st.members.find((m) => m.id === fromId);
      const to = st.members.find((m) => m.id === toId);
      if (!from || !to || from.id === to.id || !Number.isInteger(n) || n < 1) return send(res, 400, { error: 'bad transfer' });
      const pending = Market.reservedPieces(st, from.id);
      if (from.balance - pending < n) return send(res, 422, { error: 'not enough', available: from.balance - pending });
      if (!Number.isSafeInteger(to.balance + n)) return send(res, 422, { error: '받는 사람의 잔액이 너무 커요.' });
      const now = Date.now();
      await commit({
        ...st,
        members: st.members.map((m) => (m.id === from.id ? { ...m, balance: m.balance - n } : m.id === to.id ? { ...m, balance: m.balance + n } : m)),
        history: [...st.history,
          { id: uid(), time: now, memberId: from.id, delta: -n, reason: `양도: ${to.name}에게 보냄`, balanceAfter: from.balance - n },
          { id: uid(), time: now, memberId: to.id, delta: n, reason: `양도: ${from.name}에게서 받음`, balanceAfter: to.balance + n }],
      });
      pushAll({ title: '피스 양도', body: `${from.name} → ${to.name}: ${n}피스를 보냈어요`, url: '/#admin' }).catch(() => {});
      return send(res, 200, view());
    });
  }

  if (url === '/api/login' && req.method === 'POST') {
    const { pw } = await body(req);
    if (!passwordOk(pw)) return send(res, 403, { error: 'wrong password' });
    return send(res, 200, { token: makeToken() });
  }

  if (url === '/api/password' && req.method === 'POST') {
    if (!isAdmin) return send(res, 401, { error: 'login required' });
    const { current, next } = await body(req);
    if (!passwordOk(current)) return send(res, 403, { error: 'wrong password' });
    if (String(next ?? '').length < 4) return send(res, 400, { error: 'too short' });
    return locked(async () => {
      const updated = { ...auth, passwordHash: sha256(String(next)) };
      await store.set('auth', updated);
      auth = updated;
      return send(res, 200, { ok: true, token: makeToken() });
    });
  }

  return send(res, 404, { error: 'not found' });
}

async function main() {
  db = (await store.get('state')) || db;
  if (db.state) {
    db.state = Market.ensure(db.state);
    const linked = Market.expandLinks(Market.upgradeLinks(db.state));
    if (linked !== db.state) await commit(linked);
  }
  auth = { ...auth, ...(await store.get('auth')) };
  if (!auth.secret) {
    auth.secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
    await store.set('auth', auth);
  }
  if (!auth.vapid) {
    auth.vapid = webpush.generateVAPIDKeys();
    await store.set('auth', auth);
  }
  subs = (await store.get('push')) || [];
  webpush.setVapidDetails(process.env.RENDER_EXTERNAL_URL || 'https://peace-shop.onrender.com', auth.vapid.publicKey, auth.vapid.privateKey);
  if (!db.state && process.env.SEED_MEMBERS) console.log('처음 실행: 웹페이지가 처음 열릴 때 SEED_MEMBERS 가족이 만들어져요');

  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    try {
      if (url.startsWith('/api/')) return await api(req, res, url);
      const file = STATIC[url];
      if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-cache' });
      fs.createReadStream(path.join(ROOT, file)).pipe(res);
    } catch (e) {
      console.error(e.message);
      if (!res.headersSent) send(res, e.status || (e.message.startsWith('redis') ? 502 : 400), {
        error: e.status ? e.message : '요청을 처리하지 못했어요. 다시 시도해 주세요.', ...view(),
      });
    }
  }).listen(PORT, '0.0.0.0', () => {
    console.log(`피스 상점 서버가 켜졌어요 (저장소: ${store.label})`);
    console.log(`  이 컴퓨터:  http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  같은 와이파이의 가족 기기:  http://${i.address}:${PORT}`);
    }
  });
}

main().catch((e) => { console.error('서버를 시작하지 못했어요:', e.message); process.exit(1); });
