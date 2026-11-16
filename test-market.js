'use strict';

// Runs entirely against seeded local data. Never contacts the deployed shop or Redis.
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Market = require('./stock-market');

const copy = (value) => JSON.parse(JSON.stringify(value));
const admin = { isAdmin: true, now: 1700000000000 };
function legacyState(balance = 1000, productPrice = 6) {
  return {
    version: 1,
    members: [
      { id: 'm1', name: '테스트 가족 하나', balance, carry: { math: 0, other: 0 } },
      { id: 'm2', name: '테스트 가족 둘', balance: 1000, carry: { math: 0, other: 0 } },
    ],
    products: [{ id: 'snack', name: '테스트 간식', price: productPrice, emoji: '🍪' }],
    requests: [],
    history: [{ id: 'seed-history', time: 1700000000000, memberId: 'm1', delta: balance, reason: '테스트 시작', balanceAfter: balance }],
    settings: { leftover: 'carry', transfer: true, passwordHash: null },
  };
}
function companyState(balance = 1000) {
  return Market.apply(legacyState(balance), 'company-create', { id: 'company', name: '테스트 회사', basePrice: 5 }, admin);
}
function orderPayload(state, id, side, quantity, memberId = 'm1') {
  const quote = Market.quote(state, 'company', side, quantity);
  return { id, companyId: 'company', memberId, side, quantity, total: quote.total, quoteVersion: quote.quoteVersion };
}
function request(state, id, side, quantity, memberId = 'm1') {
  return Market.apply(state, 'request', orderPayload(state, id, side, quantity, memberId));
}
function approve(state, requestId) {
  return Market.apply(state, 'decide', { requestId, approve: true }, admin);
}
const errorStatus = (status) => (error) => error instanceof Error && error.status === status;

test('v1 migration preserves existing shop data and is idempotent', () => {
  const state = legacyState();
  const original = copy(state);
  Market.ensure(state);
  assert.deepEqual(state.market, { version: 1, companies: [], holdings: [], events: [], trades: [] });
  const { market, ...unchanged } = state;
  assert.deepEqual(unchanged, original);
  assert.equal(Market.ensure(state).market, market);
  assert.equal(Market.validate(state), true);
});

test('linked launch adds chocolate once and formation includes every company', () => {
  const state = legacyState();
  state.market = { version: 1, holdings: [], events: [], trades: [], companies: [
    { id: 'snacks', name: '바삭과자', basePrice: 2, quoteVersion: 1, createdAt: 1 },
    { id: 'bread', name: '우리집 베이커리', basePrice: 3, quoteVersion: 1, createdAt: 1 },
    { id: 'other', name: '기타', basePrice: 3, quoteVersion: 1, createdAt: 1 },
  ] };
  const upgraded = Market.upgradeLinks(state, 2);
  assert.equal(Market.upgradeLinks(upgraded, 3), upgraded);
  assert.deepEqual(Market.linkedCompanies(upgraded).map((c) => c.id), ['snacks', 'linked-chocolate', 'bread', 'other']);
  assert.deepEqual(Market.neighbors(upgraded, 'linked-chocolate').map((c) => c.id), ['snacks', 'bread']);
  assert.deepEqual(upgraded.members, state.members);
  assert.equal(Market.validate(upgraded), true);
  let next = upgraded;
  const trade = (id, companyId, side, quantity) => {
    const quote = Market.quote(next, companyId, side, quantity);
    next = Market.apply(next, side, { id, companyId, side, quantity, memberId: 'm1', quoteVersion: quote.quoteVersion, total: quote.total });
  };
  trade('link-buy-1', 'snacks', 'buy', 3);
  assert.equal(Market.nextPrice(next, 'linked-chocolate'), 4);
  assert.equal(Market.nextPrice(next, 'bread'), 3);
  trade('link-buy-2', 'linked-chocolate', 'buy', 2);
  assert.equal(Market.nextPrice(next, 'bread'), 4);
  assert.ok(next.market.events.some((e) => e.kind === 'linked' && e.companyId === 'bread'));
  trade('link-sell-1', 'snacks', 'sell', 3);
  trade('link-sell-2', 'linked-chocolate', 'sell', 2);
  assert.equal(next.members[0].balance, state.members[0].balance);
  assert.equal(Market.nextPrice(next, 'bread'), 3);
  const moved = Market.apply(next, 'event', { id: 'snack-result', companyId: 'snacks', kind: 'mission', title: '미션 달성', delta: 6 }, { isAdmin: true });
  assert.equal(Market.nextPrice(moved, 'snacks'), 8);
  assert.equal(Market.nextPrice(moved, 'linked-chocolate'), 6);
  assert.equal(Market.nextPrice(moved, 'bread'), 5);
  assert.equal(Market.priceHistory(moved, 'bread').at(-1).price, 5);
});

test('market expansion keeps existing positions and inserts six related companies once', () => {
  let state = legacyState();
  const names = ['바삭과자', '달콤초콜릿', '우리집 베이커리', '달콤음료', '한밤라면', '초록텃밭', '반짝문구', '피스게임즈'];
  names.forEach((name, i) => {
    state = Market.apply(state, 'company-create', { id: `stock-${i}`, name, basePrice: 3 }, admin);
  });
  const { total, quoteVersion } = Market.quote(state, 'stock-2', 'buy', 3);
  state = Market.apply(state, 'buy', { id: 'bakery-before-expansion', companyId: 'stock-2', memberId: 'm1', side: 'buy', quantity: 3, total, quoteVersion }, admin);
  const expanded = Market.expandLinks(state, 1700000001000);
  assert.equal(expanded.market.companies.length, 14);
  assert.equal(Market.expandLinks(expanded), expanded);
  assert.deepEqual(expanded.market.holdings, state.market.holdings);
  assert.deepEqual(expanded.members, state.members);
  assert.deepEqual(expanded.market.trades, state.market.trades);
  assert.deepEqual(Market.neighbors(expanded, 'linked-fruit-jam').map((c) => c.name), ['우리집 베이커리', '달콤음료']);
  assert.equal(Market.nextPrice(expanded, 'linked-fruit-jam'), 4);
  assert.equal(Market.validate(expanded), true);
});

test('company creation, price events, and approval require admin authority', () => {
  assert.throws(() => Market.apply(legacyState(), 'company-create', { id: 'company', name: '회사', basePrice: 5 }), errorStatus(401));
  const state = companyState();
  assert.throws(() => Market.apply(state, 'event', { id: 'event', companyId: 'company', kind: 'mission', title: '미션', delta: 1 }), errorStatus(401));
  assert.throws(() => Market.apply(state, 'decide', { requestId: 'missing', approve: true }), errorStatus(401));
  assert.throws(() => Market.apply(state, 'company-create', { id: 'invalid', name: '회사', basePrice: 0 }, admin), errorStatus(400));
  assert.equal(state.market.companies.length, 1);
});

test('buy and sell quotes use the correct side of the 4/5 and 9/10 boundaries', () => {
  for (const [supply, buyPrice, sellPrice] of [[4, 5, 5], [5, 6, 5], [9, 6, 6], [10, 7, 6]]) {
    const state = companyState();
    state.market.holdings.push({ memberId: 'm2', companyId: 'company', quantity: supply, costBasis: supply * 5 });
    assert.equal(Market.quote(state, 'company', 'buy', 1).total, buyPrice, `buy with ${supply} outstanding`);
    assert.equal(Market.quote(state, 'company', 'sell', 1).total, sellPrice, `sell with ${supply} outstanding`);
  }
});

test('multi-share round trips crossing price bands cannot create free pieces', () => {
  for (const [supply, expectedTotal] of [[0, 76], [4, 86], [5, 89], [9, 99]]) {
    let state = companyState();
    if (supply) state.market.holdings.push({ memberId: 'm2', companyId: 'company', quantity: supply, costBasis: supply * 5 });
    assert.equal(Market.quote(state, 'company', 'buy', 13).total, expectedTotal);
    state = approve(request(state, 'buy-roundtrip', 'buy', 13), 'buy-roundtrip');
    assert.equal(state.members[0].balance, 1000 - expectedTotal);
    assert.equal(Market.quote(state, 'company', 'sell', 13).total, expectedTotal);
    state = approve(request(state, 'sell-roundtrip', 'sell', 13), 'sell-roundtrip');
    assert.equal(state.members[0].balance, 1000);
    assert.equal(Market.outstanding(state, 'company'), supply);
    assert.deepEqual(Market.holding(state, 'm1', 'company'), { memberId: 'm1', companyId: 'company', quantity: 0, costBasis: 0 });
    assert.equal(state.market.trades[1].realizedProfit, 0);
    assert.deepEqual(state.history.slice(1).map((entry) => entry.delta), [-expectedTotal, expectedTotal]);
    assert.equal(Market.validate(state), true);
  }
});

test('invalid quantities, insufficient pieces, and unowned shares are rejected without mutation', () => {
  const state = companyState(5);
  const original = copy(state);
  for (const quantity of [0, -1, 1.5, 101, '2', null, NaN]) {
    assert.throws(() => Market.quote(state, 'company', 'buy', quantity), errorStatus(400));
  }
  assert.throws(() => request(state, 'too-expensive', 'buy', 2), errorStatus(422));
  state.market.holdings.push({ memberId: 'm2', companyId: 'company', quantity: 2, costBasis: 10 });
  assert.throws(() => request(state, 'not-owned', 'sell', 1), errorStatus(422));
  state.market.holdings.pop();
  assert.deepEqual(state, original);
});

test('cancellation and rejection release reserved pieces without spending them', () => {
  let state = request(companyState(), 'cancel-buy', 'buy', 10);
  assert.equal(Market.reservedPieces(state, 'm1'), 55);
  assert.throws(() => Market.apply(state, 'cancel', { requestId: 'cancel-buy', memberId: 'm2' }), errorStatus(403));
  state = Market.apply(state, 'cancel', { requestId: 'cancel-buy', memberId: 'm1' });
  assert.equal(Market.reservedPieces(state, 'm1'), 0);
  state = request(state, 'reject-buy', 'buy', 10);
  state = Market.apply(state, 'decide', { requestId: 'reject-buy', approve: false }, admin);
  assert.equal(Market.reservedPieces(state, 'm1'), 0);
  assert.equal(state.members[0].balance, 1000);
  assert.equal(state.market.trades.length, 0);
});

test('request and approval retries are idempotent and reused IDs cannot change orders', () => {
  let state = companyState();
  const payload = orderPayload(state, 'retry', 'buy', 3);
  state = Market.apply(state, 'request', payload);
  assert.deepEqual(Market.apply(state, 'request', payload), state);
  assert.throws(() => Market.apply(state, 'request', { ...payload, quantity: 4 }), errorStatus(400));
  state = approve(state, 'retry');
  assert.deepEqual(approve(state, 'retry'), state);
  assert.deepEqual(Market.apply(state, 'request', payload), state);
  assert.equal(state.members[0].balance, 985);
  assert.equal(state.market.trades.length, 1);
  assert.equal(state.history.filter((entry) => entry.marketRequestId === 'retry').length, 1);
});

test('performance and mission price changes expire pending orders and release both reservations', () => {
  for (const kind of ['performance', 'mission']) {
    let state = companyState();
    state.market.holdings.push({ memberId: 'm1', companyId: 'company', quantity: 10, costBasis: 55 });
    state = request(state, 'pending-buy', 'buy', 2);
    state = request(state, 'pending-sell', 'sell', 2);
    assert.equal(Market.reservedPieces(state, 'm1'), 14);
    assert.equal(Market.availableShares(state, 'm1', 'company'), 8);
    const event = { id: 'price-event', companyId: 'company', kind, title: '테스트 미션 또는 실적', delta: 2 };
    state = Market.apply(state, 'event', event, admin);
    assert.deepEqual(state.requests.map((entry) => entry.status), ['expired', 'expired']);
    assert.equal(Market.reservedPieces(state, 'm1'), 0);
    assert.equal(Market.availableShares(state, 'm1', 'company'), 10);
    assert.equal(state.market.companies[0].basePrice, 7);
    assert.equal(state.members[0].balance, 1000);
    assert.deepEqual(Market.apply(state, 'event', event, admin), state);
    assert.throws(() => Market.apply(state, 'event', { ...event, id: 'below-minimum', delta: -7 }, admin), errorStatus(400));
    assert.equal(Market.validate(state), true);
  }
});

describe('local HTTP integration (isolated temporary file storage)', { concurrency: false, timeout: 60000 }, () => {
  let directory;
  let child;
  let origin;
  let token;
  let output = '';

  async function availablePort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    return port;
  }
  async function startServer() {
    const port = await availablePort();
    origin = `http://127.0.0.1:${port}`;
    output = '';
    const env = { ...process.env, PORT: String(port), DATA_DIR: directory, RENDER_EXTERNAL_URL: 'https://peace-shop.test' };
    delete env.UPSTASH_REDIS_REST_URL;
    delete env.UPSTASH_REDIS_REST_TOKEN;
    delete env.UPSTASH_REDIS_TOKEN;
    delete env.SEED_MEMBERS;
    delete env.SESSION_SECRET;
    child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { cwd: __dirname, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-5000); });
    let startupError;
    child.once('error', (error) => { startupError = error; });
    const deadline = Date.now() + 10000;
    let connectionError = '';
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Local test server exited: ${output}`);
      try {
        const response = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch (error) { connectionError = `${error.message}: ${error.cause?.code || ''}`; }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Local test server did not become reachable (${connectionError}): ${output}`);
  }
  async function stopServer() {
    if (!child || child.exitCode !== null) return;
    const exiting = once(child, 'exit');
    child.kill();
    await exiting;
    child = null;
  }
  async function api(route, method = 'GET', data, useAdmin = false) {
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(origin + route, {
      method,
      headers: { 'content-type': 'application/json', ...(useAdmin ? { 'x-token': token } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function current() {
    const response = await api('/api/state');
    assert.equal(response.status, 200);
    return response.body;
  }
  async function reset(balance = 1000) {
    const existing = await current();
    const state = legacyState(balance);
    const response = existing.state
      ? await api('/api/state/replace', 'POST', { rev: existing.rev, state }, true)
      : await api('/api/init', 'POST', { state });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function market(action, payload = {}, useAdmin = false) {
    return api('/api/market', 'POST', { action, ...payload }, useAdmin);
  }
  async function createCompany() {
    const result = await market('company-create', { id: 'company', name: '테스트 회사', basePrice: 5 }, true);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function place(id, side, quantity, memberId = 'm1') {
    const { state } = await current();
    return market('request', orderPayload(state, id, side, quantity, memberId));
  }

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'peace-shop-market-test-'));
    await startServer();
    const login = await api('/api/login', 'POST', { pw: '1234' });
    assert.equal(login.status, 200);
    token = login.body.token;
    assert.ok(token);
  });
  beforeEach(async () => { await reset(); });
  after(async () => {
    await stopServer();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  test('old v1 state gains an empty market without changing balances or history', async () => {
    const { state } = await current();
    assert.deepEqual(state.market, { version: 1, companies: [], holdings: [], events: [], trades: [] });
    assert.deepEqual(state.members, legacyState().members);
    assert.deepEqual(state.history, legacyState().history);
  });

  test('the same family PIN authorizes immediate buys and sells, each settled only once', async () => {
    const { state } = await createCompany();
    const buy = orderPayload(state, 'instant-buy', 'buy', 6);
    const pin = '012345';
    assert.equal((await market('set-buy-pin', { memberId: 'm1', pin })).status, 403);
    assert.equal((await market('buy', { ...buy, pin })).status, 403);
    const setup = await market('set-buy-pin', { memberId: 'm1', pin }, true);
    assert.equal(setup.status, 200);
    assert.doesNotMatch(JSON.stringify(setup.body), /012345|buyPins/);
    assert.equal((await market('buy', { ...buy, pin: '999999' })).status, 403);
    assert.equal((await market('buy', { ...buy, memberId: 'm2', pin })).status, 403);
    assert.equal((await current()).state.members[0].balance, 1000);
    const results = await Promise.all([market('buy', { ...buy, pin }), market('buy', { ...buy, pin })]);
    for (const response of results) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.state.members[0].balance, 1000 - buy.total);
      assert.equal(response.body.state.requests[0].status, 'approved');
      assert.equal(response.body.state.market.trades.length, 1);
      assert.equal(Market.holding(response.body.state, 'm1', 'company').quantity, 6);
    }
    assert.equal((await market('buy', { ...buy, id: 'stale-buy', pin })).status, 409);
    const sale = orderPayload((await current()).state, 'instant-sell', 'sell', 6);
    assert.equal((await market('sell', { ...sale, pin: '999999' })).status, 403);
    const sales = await Promise.all([market('sell', { ...sale, pin }), market('sell', { ...sale, pin })]);
    for (const response of sales) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.state.members[0].balance, 1000);
      assert.equal(response.body.state.requests.at(-1).status, 'approved');
      assert.equal(response.body.state.market.trades.length, 2);
      assert.equal(Market.holding(response.body.state, 'm1', 'company').quantity, 0);
      assert.deepEqual(Market.priceHistory(response.body.state, 'company').map((point) => point.price), [5, 6, 5]);
    }
  });

  test('company creation, event publication, and trading approval enforce admin authentication', async () => {
    const denied = await market('company-create', { id: 'company', name: '테스트 회사', basePrice: 5 });
    assert.equal(denied.status, 401);
    await createCompany();
    assert.equal((await place('auth-order', 'buy', 1)).status, 200);
    assert.equal((await market('decide', { requestId: 'auth-order', approve: true })).status, 401);
    assert.equal((await market('event', { id: 'event', companyId: 'company', kind: 'mission', title: '완료', delta: 1 })).status, 401);
    const { state } = await current();
    assert.equal(state.requests[0].status, 'pending');
    assert.equal(state.members[0].balance, 1000);
    assert.equal(state.market.events.length, 0);
  });

  test('cash reserved for stock blocks transfers and additional shop purchases, then cancellation releases it', async () => {
    await reset(20);
    await createCompany();
    assert.equal((await place('reserve-buy', 'buy', 3)).status, 200);
    const transfer = await api('/api/transfer', 'POST', { fromId: 'm1', toId: 'm2', amount: 6 });
    assert.equal(transfer.status, 422);
    const snapshot = await current();
    snapshot.state.requests.push({ id: 'blocked-purchase', type: 'purchase', memberId: 'm1', productId: 'snack', status: 'pending' });
    const purchase = await api('/api/state', 'PUT', snapshot);
    assert.ok([200, 422].includes(purchase.status), JSON.stringify(purchase.body));
    const blocked = (await current()).state;
    assert.ok(!blocked.requests.some((entry) => entry.id === 'blocked-purchase' && entry.status === 'pending'));
    assert.equal(blocked.members[0].balance, 20);
    assert.equal(Market.reservedPieces(blocked, 'm1'), 15);
    assert.equal((await market('cancel', { requestId: 'reserve-buy', memberId: 'm1' })).status, 200);
    assert.equal((await api('/api/transfer', 'POST', { fromId: 'm1', toId: 'm2', amount: 6 })).status, 200);
    assert.equal((await current()).state.members[0].balance, 14);
  });

  test('shares reserved for one sale cannot be sold a second time', async () => {
    await createCompany();
    assert.equal((await place('initial-buy', 'buy', 4)).status, 200);
    assert.equal((await market('decide', { requestId: 'initial-buy', approve: true }, true)).status, 200);
    assert.equal((await place('first-sale', 'sell', 3)).status, 200);
    assert.equal((await place('oversell', 'sell', 2)).status, 422);
    const { state } = await current();
    assert.equal(Market.availableShares(state, 'm1', 'company'), 1);
    assert.equal(state.requests.filter((entry) => entry.side === 'sell' && entry.status === 'pending').length, 1);
    assert.equal(state.members[0].balance, 980);
  });

  test('repeated HTTP requests and approvals debit pieces and append trade history only once', async () => {
    const { state } = await createCompany();
    const payload = orderPayload(state, 'http-retry', 'buy', 3);
    assert.equal((await market('request', payload)).status, 200);
    assert.equal((await market('request', payload)).status, 200);
    assert.equal((await market('decide', { requestId: 'http-retry', approve: true }, true)).status, 200);
    assert.equal((await market('decide', { requestId: 'http-retry', approve: true }, true)).status, 200);
    assert.equal((await market('request', payload)).status, 200);
    const result = (await current()).state;
    assert.equal(result.members[0].balance, 985);
    assert.equal(result.market.trades.length, 1);
    assert.equal(result.requests.length, 1);
    assert.equal(result.history.filter((entry) => entry.marketRequestId === 'http-retry').length, 1);
  });

  test('family PUT cannot forge market, stock requests, pieces, or ledger entries', async () => {
    const original = await createCompany();
    const forged = copy(original);
    forged.state.market.companies[0].basePrice = 9999;
    forged.state.market.holdings.push({ memberId: 'm1', companyId: 'company', quantity: 100, costBasis: 0 });
    forged.state.members[0].balance = 999999;
    forged.state.history.push({ id: 'forged-history', memberId: 'm1', delta: 999999 });
    forged.state.requests.push({ id: 'forged-stock', type: 'stock', memberId: 'm1', companyId: 'company', side: 'buy', quantity: 1, price: 1, quoteVersion: 1, status: 'pending' });
    const response = await api('/api/state', 'PUT', forged);
    assert.ok([200, 400, 403, 422].includes(response.status));
    const actual = (await current()).state;
    assert.deepEqual(actual.market, original.state.market);
    assert.deepEqual(actual.members, original.state.members);
    assert.deepEqual(actual.history, original.state.history);
    assert.deepEqual(actual.requests, original.state.requests);
  });

  test('stale or market-unaware admin PUT cannot discard the current market and stock ledger', async () => {
    const old = await current();
    delete old.state.market;
    await createCompany();
    assert.equal((await place('protected-buy', 'buy', 2)).status, 200);
    assert.equal((await market('decide', { requestId: 'protected-buy', approve: true }, true)).status, 200);
    const protectedSnapshot = await current();
    assert.equal((await api('/api/state', 'PUT', old, true)).status, 409);
    const oldClient = copy(protectedSnapshot);
    delete oldClient.state.market;
    oldClient.state.requests = [];
    oldClient.state.history = legacyState().history;
    oldClient.state.settings.leftover = 'discard';
    const response = await api('/api/state', 'PUT', oldClient, true);
    assert.ok([200, 400, 409, 422].includes(response.status), JSON.stringify(response.body));
    const actual = (await current()).state;
    assert.deepEqual(actual.market, protectedSnapshot.state.market);
    assert.deepEqual(actual.requests.filter((entry) => entry.type === 'stock'), protectedSnapshot.state.requests);
    assert.deepEqual(actual.history.filter((entry) => entry.marketRequestId), protectedSnapshot.state.history.filter((entry) => entry.marketRequestId));
    assert.equal(actual.members[0].balance, 990);
  });

  test('concurrent approvals serialize and expire a competing quote without double charging', async () => {
    await createCompany();
    assert.equal((await place('race-one', 'buy', 1)).status, 200);
    assert.equal((await place('race-two', 'buy', 1)).status, 200);
    const responses = await Promise.all([
      market('decide', { requestId: 'race-one', approve: true }, true),
      market('decide', { requestId: 'race-two', approve: true }, true),
    ]);
    responses.forEach((response) => assert.equal(response.status, 200, JSON.stringify(response.body)));
    const { state } = await current();
    assert.deepEqual(state.requests.map((entry) => entry.status).sort(), ['approved', 'expired']);
    assert.equal(state.members[0].balance, 995);
    assert.equal(Market.outstanding(state, 'company'), 1);
    assert.equal(Market.reservedPieces(state, 'm1'), 0);
    assert.equal(state.market.trades.length, 1);
    assert.equal(state.history.filter((entry) => entry.marketRequestId).length, 1);
    assert.equal(state.history.at(-1).balanceAfter, 995);
    assert.equal(Market.validate(state), true);
  });

  test('price events release reservations and market data survives a server restart', async () => {
    await reset(20);
    await createCompany();
    assert.equal((await place('before-event', 'buy', 3)).status, 200);
    const event = await market('event', { id: 'persist-event', companyId: 'company', kind: 'mission', title: '가족 미션 완료', delta: 2 }, true);
    assert.equal(event.status, 200);
    assert.equal(event.body.state.requests[0].status, 'expired');
    assert.equal(Market.reservedPieces(event.body.state, 'm1'), 0);
    assert.equal((await api('/api/transfer', 'POST', { fromId: 'm1', toId: 'm2', amount: 6 })).status, 200);
    const persisted = await current();
    await stopServer();
    await startServer();
    assert.deepEqual(await current(), persisted);
    const authorized = await market('company-create', { id: 'after-restart', name: '재시작 테스트', basePrice: 1 }, true);
    assert.equal(authorized.status, 200, 'existing admin token remains valid with persisted auth data');
  });
});
