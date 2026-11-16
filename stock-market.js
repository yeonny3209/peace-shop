/* 피스 주식 — 서버와 브라우저에서 함께 쓰는 거래 규칙. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PeaceMarket = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_ORDER = 100;
  const MAX_SHARES = 10000;
  const MAX_BASE = 10000;
  const MAX_REALITY_EVENTS_PER_DAY = 2;
  const statuses = ['pending', 'approved', 'rejected', 'cancelled', 'expired'];
  const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
  const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
  const goodId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const clone = (s) => JSON.parse(JSON.stringify(s));
  const empty = () => ({ version: 1, companies: [], holdings: [], events: [], trades: [] });

  function ensure(state) {
    if (!state || typeof state !== 'object') fail('상점 데이터가 없어요.');
    if (state.market == null) state.market = empty();
    return state;
  }
  const market = (state) => state.market || empty();
  const company = (state, id) => market(state).companies.find((c) => c.id === id);
  function outstanding(state, companyId) {
    return market(state).holdings.filter((p) => p.companyId === companyId).reduce((n, p) => n + p.quantity, 0);
  }
  const originalLinks = ['바삭과자', '달콤초콜릿', '우리집베이커리', '달콤음료', '한밤라면', '초록텃밭', '반짝문구', '피스게임즈'];
  const expansion = {
    우리집베이커리: { id: 'linked-fruit-jam', name: '달콤잼', description: '빵에 발라 먹는 과일잼을 만들어요.', basePrice: 3 },
    달콤음료: { id: 'linked-fresh-juice', name: '상큼주스', description: '가족이 좋아하는 과일을 골라 주스를 만들어요.', basePrice: 3 },
    한밤라면: { id: 'linked-snack-bar', name: '든든분식', description: '라면과 함께 먹을 떡볶이와 주먹밥을 만들어요.', basePrice: 4 },
    초록텃밭: { id: 'linked-fruit-farm', name: '싱싱과일', description: '제철 과일을 키우고 수확해요.', basePrice: 3 },
    반짝문구: { id: 'linked-notebooks', name: '쓱쓱노트', description: '공부와 그림에 쓰는 노트를 만들어요.', basePrice: 2 },
    피스게임즈: { id: 'linked-board-games', name: '즐거운보드게임', description: '온 가족이 식탁에 모여 할 보드게임을 만들어요.', basePrice: 4 },
  };
  const nameKey = (name) => String(name).replace(/\s/g, '');
  const linkOrder = originalLinks.flatMap((name) => expansion[name] ? [name, nameKey(expansion[name].name)] : [name]);
  function linkedCompanies(state) {
    const companies = market(state).companies;
    const byName = new Map(companies.map((c) => [nameKey(c.name), c]));
    const ordered = linkOrder.map((name) => byName.get(name)).filter(Boolean);
    return [...ordered, ...companies.filter((c) => !ordered.includes(c))];
  }
  function neighbors(state, companyId) {
    const companies = linkedCompanies(state);
    const index = companies.findIndex((c) => c.id === companyId);
    if (index === -1 || companies.length < 2) return [];
    const left = companies[(index + companies.length - 1) % companies.length];
    const right = companies[(index + 1) % companies.length];
    return left === right ? [left] : [left, right];
  }
  function priceCurve(state, companyId) {
    const c = company(state, companyId);
    const companies = market(state).companies;
    if (companies.length < 2) return (shares) => c.basePrice + Math.floor(shares / 5);
    const nearby = neighbors(state, companyId).map((other) => outstanding(state, other.id));
    const marketShares = companies.reduce((sum, other) => sum + (other.id === companyId ? 0 : outstanding(state, other.id)), 0);
    // Each shared band uses the same total on both ends of a trade. Reversing a set of trades cannot mint pieces.
    return (shares) => c.basePrice + Math.floor(shares / 5) + Math.floor((marketShares + shares) / 5)
      + nearby.reduce((sum, count) => sum + Math.floor((count + shares) / 3), 0);
  }
  const priceAt = (state, companyId, shares) => priceCurve(state, companyId)(shares);
  const nextPrice = (state, companyId) => priceAt(state, companyId, outstanding(state, companyId));

  function reprice(state, origin, before, now) {
    for (const c of market(state).companies) {
      if (c.id === origin.id) continue;
      c.quoteVersion++;
      expire(state, c.id, now);
      const after = nextPrice(state, c.id);
      if (after === before.get(c.id)) continue;
      const events = market(state).events;
      events.push({ id: `linked-${now}-${events.length}`, companyId: c.id, companyName: c.name, kind: 'linked',
        title: `${origin.name}의 변화`, priceBefore: before.get(c.id), priceAfter: after, quoteVersion: c.quoteVersion, time: now });
    }
  }
  const marketPrices = (state) => new Map(market(state).companies.map((c) => [c.id, nextPrice(state, c.id)]));

  function upgradeLinks(input, now = Date.now()) {
    if (!input || !market(input).companies.length || market(input).linkedLaunch) return input;
    const state = clone(input);
    const mk = state.market;
    const names = new Set(mk.companies.map((c) => nameKey(c.name)));
    if (names.has('바삭과자') && names.has('우리집베이커리') && !names.has('달콤초콜릿') && !company(state, 'linked-chocolate')) {
      mk.companies.push({ id: 'linked-chocolate', name: '달콤초콜릿', description: '과자와 빵에 어울리는 초콜릿을 만드는 가족 회사예요.', basePrice: 3, quoteVersion: 1, createdAt: now });
    }
    for (const c of mk.companies) {
      const before = c.basePrice + Math.floor(outstanding(state, c.id) / 5);
      const after = nextPrice(state, c.id);
      c.quoteVersion++;
      if (before !== after) mk.events.push({ id: `link-launch-${mk.events.length}`, companyId: c.id, kind: 'linked', title: '종목 연동 시작', priceBefore: before, priceAfter: after, quoteVersion: c.quoteVersion, time: now });
      expire(state, c.id, now);
    }
    mk.linkedLaunch = true;
    return state;
  }

  function expandLinks(input, now = Date.now()) {
    if (!input || market(input).linkedExpansion) return input;
    const names = new Set(market(input).companies.map((c) => nameKey(c.name)));
    if (!originalLinks.every((name) => names.has(name))) return input;
    const state = clone(input);
    const mk = state.market;
    const before = marketPrices(state);
    for (const stock of Object.values(expansion)) {
      if (names.has(nameKey(stock.name))) continue;
      const id = company(state, stock.id) ? `${stock.id}-${now}` : stock.id;
      mk.companies.push({ ...stock, id, quoteVersion: 1, createdAt: now });
    }
    for (const c of mk.companies) {
      if (!before.has(c.id)) continue;
      c.quoteVersion++;
      expire(state, c.id, now);
      const after = nextPrice(state, c.id);
      if (before.get(c.id) === after) continue;
      mk.events.push({ id: `expanded-links-${now}-${mk.events.length}`, companyId: c.id, companyName: c.name, kind: 'linked',
        title: '새 종목 연결', priceBefore: before.get(c.id), priceAfter: after, quoteVersion: c.quoteVersion, time: now });
    }
    mk.linkedExpansion = true;
    return state;
  }
  function holding(state, memberId, companyId) {
    return market(state).holdings.find((p) => p.memberId === memberId && p.companyId === companyId)
      || { memberId, companyId, quantity: 0, costBasis: 0 };
  }
  function reservedPieces(state, memberId, excludeId) {
    return (state.requests || []).filter((r) => r.id !== excludeId && r.memberId === memberId && r.status === 'pending'
      && (r.type === 'purchase' || (r.type === 'stock' && r.side === 'buy')))
      .reduce((sum, r) => sum + r.price, 0);
  }
  function availableShares(state, memberId, companyId, excludeId) {
    const reserved = (state.requests || []).filter((r) => r.id !== excludeId && r.memberId === memberId && r.companyId === companyId
      && r.type === 'stock' && r.side === 'sell' && r.status === 'pending').reduce((sum, r) => sum + r.quantity, 0);
    return holding(state, memberId, companyId).quantity - reserved;
  }
  function quote(state, companyId, side, quantity) {
    const c = company(state, companyId);
    if (!c) fail('회사를 찾을 수 없어요.', 404);
    if (side !== 'buy' && side !== 'sell') fail('매수 또는 매도를 선택해 주세요.');
    if (!integer(quantity, 1, MAX_ORDER)) fail('한 번에 1~100주를 거래할 수 있어요.');
    const n = outstanding(state, companyId);
    if (!integer(c.basePrice, 1, MAX_BASE) || !integer(c.quoteVersion, 1, Number.MAX_SAFE_INTEGER)
      || !integer(n, 0, MAX_SHARES)) fail('회사 가격 또는 보유 수량을 확인해 주세요.');
    if (side === 'buy' && n + quantity > MAX_SHARES) fail('이 회사는 총 10,000주까지만 보유할 수 있어요.', 422);
    if (side === 'sell' && quantity > n) fail('매도할 수 있는 주식이 부족해요.', 422);
    const prices = [];
    const at = priceCurve(state, c.id);
    for (let i = 0; i < quantity; i++) prices.push(at(side === 'buy' ? n + i : n - i - 1));
    return {
      total: prices.reduce((sum, p) => sum + p, 0), average: prices.reduce((sum, p) => sum + p, 0) / quantity,
      first: prices[0], last: prices[prices.length - 1], quoteVersion: c.quoteVersion,
      nextPrice: at(side === 'buy' ? n + quantity : n - quantity),
    };
  }
  function expire(state, companyId, now) {
    state.requests.forEach((r) => {
      if (r.type === 'stock' && r.companyId === companyId && r.status === 'pending') {
        r.status = 'expired'; r.doneTime = now; r.doneReason = '주가가 바뀌었어요. 새 가격을 확인한 뒤 다시 요청해 주세요.';
      }
    });
  }
  function requireAdmin(options) {
    if (!options.isAdmin) fail('엄마 로그인이 필요해요.', 401);
  }
  const koreaDay = (time) => new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const validDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  function applyRealityEvent(state, payload, id, now) {
    const mk = state.market;
    const c = company(state, payload.companyId);
    if (!c) fail('회사를 찾을 수 없어요.', 404);
    const title = String(payload.title || '').trim();
    const factSummary = String(payload.factSummary || '').trim();
    const reasoning = String(payload.reasoning || '').trim();
    const sourceName = String(payload.sourceName || '').trim();
    const sourceUrl = String(payload.sourceUrl || '').trim();
    const region = String(payload.region || '').trim();
    const eventDate = String(payload.eventDate || '').trim();
    const publishedAt = String(payload.publishedAt || '').trim();
    if (!['weather', 'season', 'news'].includes(payload.category) || !title || title.length > 100
      || !factSummary || factSummary.length > 500 || !reasoning || reasoning.length > 300
      || !sourceName || sourceName.length > 80 || !region || region.length > 80 || sourceUrl.length > 1000
      || !validDay(eventDate) || !validDay(publishedAt)
      || typeof payload.isForecast !== 'boolean' || !integer(payload.delta, -2, 2) || payload.delta === 0) {
      fail('소식, 출처, 날짜, 영향 종목과 ±1~2피스 변화를 모두 확인해 주세요.');
    }
    let parsed;
    try { parsed = new URL(sourceUrl); } catch { fail('출처 링크는 https 주소로 입력해 주세요.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail('출처 링크는 https 주소로 입력해 주세요.');
    const day = koreaDay(now);
    const todayEvents = [...new Set(mk.events.filter((e) => e.kind === 'reality' && e.day === day).map((e) => e.realityEventId || e.id))];
    if (todayEvents.length >= MAX_REALITY_EVENTS_PER_DAY) fail('현실 소식은 하루에 최대 2건까지 반영할 수 있어요.', 429);
    const priorByCompany = new Map();
    mk.events.filter((e) => e.kind === 'reality' && e.day === day).forEach((e) => {
      priorByCompany.set(e.companyId, (priorByCompany.get(e.companyId) || 0) + Math.abs(e.delta || 0));
    });
    const affected = [{ c, delta: payload.delta }];
    if (Math.abs(payload.delta) === 2) {
      neighbors(state, c.id).forEach((other) => affected.push({ c: other, delta: Math.sign(payload.delta) }));
    }
    affected.forEach(({ c: target, delta }) => {
      if ((priorByCompany.get(target.id) || 0) + Math.abs(delta) > 2) fail(`${target.name}의 오늘 현실 소식 변화 한도(±2피스)에 도달했어요.`, 429);
      if (!integer(target.basePrice + delta, 1, MAX_BASE)) fail(`${target.name}의 기준가는 1~10,000피스 범위여야 해요.`);
    });
    const before = marketPrices(state);
    affected.forEach(({ c: target, delta }, index) => {
      target.basePrice += delta;
      target.quoteVersion++;
      expire(state, target.id, now);
      const after = nextPrice(state, target.id);
      mk.events.push({ id: index === 0 ? id : `${id}-r${index}`, realityEventId: id, companyId: target.id,
        companyName: target.name, kind: 'reality', category: payload.category, title,
        factSummary, reasoning, sourceName, sourceUrl, region, eventDate, publishedAt,
        isForecast: payload.isForecast, targetCompanyId: c.id, delta, day,
        baseBefore: target.basePrice - delta, baseAfter: target.basePrice,
        priceBefore: before.get(target.id), priceAfter: after, quoteVersion: target.quoteVersion, time: now });
    });
  }
  function validate(state) {
    if (!state || !['members', 'products', 'requests', 'history'].every((k) => Array.isArray(state[k]))) fail('올바른 상점 백업이 아니에요.');
    const memberIds = new Set();
    state.members.forEach((m) => {
      if (!m || !goodId(m.id) || memberIds.has(m.id) || !integer(m.balance, 0, Number.MAX_SAFE_INTEGER)) fail('가족 또는 잔액 데이터가 올바르지 않아요.');
      memberIds.add(m.id);
    });
    if (state.market == null) {
      if (state.requests.some((r) => r?.type === 'stock')) fail('주식 요청에 필요한 시장 데이터가 없어요.');
      return true;
    }
    const mk = state.market;
    if (mk.version !== 1 || !['companies', 'holdings', 'events', 'trades'].every((k) => Array.isArray(mk[k]))) fail('주식 백업 형식이 올바르지 않아요.');
    const companyIds = new Set();
    mk.companies.forEach((c) => {
      if (!c || !goodId(c.id) || companyIds.has(c.id) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 40
        || !integer(c.basePrice, 1, MAX_BASE) || !integer(c.quoteVersion, 1, Number.MAX_SAFE_INTEGER)) fail('회사 데이터가 올바르지 않아요.');
      companyIds.add(c.id);
    });
    const positions = new Set();
    mk.holdings.forEach((p) => {
      if (!p || !memberIds.has(p.memberId) || !companyIds.has(p.companyId) || !integer(p.quantity, 0, MAX_SHARES)
        || !Number.isFinite(p.costBasis) || p.costBasis < 0 || p.costBasis > p.quantity * (MAX_BASE + MAX_SHARES / 5)
        || (p.quantity === 0 && p.costBasis !== 0)) fail('주식 보유 데이터가 올바르지 않아요.');
      const key = `${p.memberId}:${p.companyId}`;
      if (positions.has(key)) fail('중복된 주식 보유 데이터가 있어요.');
      positions.add(key);
    });
    companyIds.forEach((id) => { if (outstanding(state, id) > MAX_SHARES) fail('회사의 최대 보유 수량을 넘었어요.'); });
    const requestIds = new Set();
    state.requests.forEach((r) => {
      if (!r || !goodId(r.id) || requestIds.has(r.id)) fail('요청 번호가 올바르지 않아요.');
      requestIds.add(r.id);
      if (r.type === 'stock') {
        if (!companyIds.has(r.companyId) || !['buy', 'sell'].includes(r.side) || !integer(r.quantity, 1, MAX_ORDER)
          || !integer(r.price, 1, Number.MAX_SAFE_INTEGER) || !integer(r.quoteVersion, 1, Number.MAX_SAFE_INTEGER)
          || !statuses.includes(r.status) || (r.status === 'pending' && !memberIds.has(r.memberId))) fail('주식 요청 데이터가 올바르지 않아요.');
        if (r.status === 'pending') {
          const q = quote(state, r.companyId, r.side, r.quantity);
          if (q.quoteVersion !== r.quoteVersion || q.total !== r.price) fail('현재 주가와 다른 대기 요청이 있어요.');
        }
      }
      if (r.status === 'pending' && r.type === 'purchase' && !integer(r.price, 0, Number.MAX_SAFE_INTEGER)) fail('구매 요청 금액이 올바르지 않아요.');
    });
    state.members.forEach((m) => {
      if (reservedPieces(state, m.id) > m.balance) fail('승인 대기 중인 피스를 제외하면 잔액이 부족해요.', 422);
      companyIds.forEach((id) => { if (availableShares(state, m.id, id) < 0) fail('승인 대기 중인 매도 수량이 보유 주식보다 많아요.', 422); });
    });
    for (const key of ['events', 'trades']) {
      const seen = new Set();
      mk[key].forEach((entry) => {
        if (!entry || !goodId(entry.id) || seen.has(entry.id) || !companyIds.has(entry.companyId) || !Number.isFinite(entry.time)) fail('주식 내역이 올바르지 않아요.');
        seen.add(entry.id);
      });
    }
    return true;
  }
  function apply(input, action, payload = {}, options = {}) {
    const state = ensure(clone(input));
    const mk = state.market;
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const id = payload.id || (typeof options.id === 'function' ? options.id() : options.id);
    const checkId = () => { if (!goodId(id)) fail('요청 번호가 올바르지 않아요. 새로고침 후 다시 해 주세요.'); };

    if (action === 'company-create') {
      requireAdmin(options); checkId();
      if (mk.companies.some((c) => c.id === id)) return state;
      const name = String(payload.name || '').trim();
      const description = String(payload.description || '').trim();
      if (!name || name.length > 40 || description.length > 240) fail('회사 이름은 1~40자, 소개는 240자 이내로 입력해 주세요.');
      if (!integer(payload.basePrice, 1, MAX_BASE)) fail('시작 기준가는 1~10,000피스의 정수로 입력해 주세요.');
      const before = marketPrices(state);
      const created = { id, name, description, basePrice: payload.basePrice, quoteVersion: 1, createdAt: now };
      mk.companies.push(created);
      mk.linkedLaunch = true;
      reprice(state, created, before, now);
    } else if (action === 'event') {
      requireAdmin(options); checkId();
      if (mk.events.some((e) => e.id === id)) return state;
      const c = company(state, payload.companyId);
      if (!c) fail('회사를 찾을 수 없어요.', 404);
      const title = String(payload.title || '').trim();
      if (!['performance', 'mission'].includes(payload.kind) || !title || title.length > 100) fail('실적 또는 미션을 선택하고, 이유를 100자 이내로 입력해 주세요.');
      if (!integer(payload.delta, -100, 100) || payload.delta === 0) fail('변경 폭은 -100~100피스 중 0이 아닌 정수로 입력해 주세요.');
      const after = c.basePrice + payload.delta;
      if (!integer(after, 1, MAX_BASE)) fail('변경 후 기준가는 1~10,000피스여야 해요.');
      const before = marketPrices(state);
      mk.events.push({ id, companyId: c.id, companyName: c.name, kind: payload.kind, title, delta: payload.delta,
        baseBefore: c.basePrice, baseAfter: after, priceBefore: before.get(c.id), priceAfter: before.get(c.id) + payload.delta, quoteVersion: c.quoteVersion + 1, time: now });
      c.basePrice = after; c.quoteVersion += 1;
      expire(state, c.id, now);
      const line = linkedCompanies(state);
      const start = line.findIndex((item) => item.id === c.id);
      line.forEach((other, index) => {
        const gap = Math.abs(index - start);
        const distance = Math.min(gap, line.length - gap);
        if (!distance) return;
        const ripple = Math.sign(payload.delta) * Math.max(1, Math.floor(Math.abs(payload.delta) / (distance + 1)));
        other.basePrice = Math.max(1, Math.min(MAX_BASE, other.basePrice + ripple));
      });
      reprice(state, c, before, now);
    } else if (action === 'reality-event') {
      requireAdmin(options); checkId();
      if (mk.events.some((e) => e.realityEventId === id || e.id === id)) return state;
      applyRealityEvent(state, payload, id, now);
    } else if (['request', 'buy', 'sell'].includes(action)) {
      const instant = action !== 'request';
      if (instant && payload.side !== action) fail('거래 종류를 다시 확인해 주세요.');
      checkId();
      const existing = state.requests.find((r) => r.id === id);
      if (existing) {
        if (instant && existing.status !== 'approved') fail('새 거래 화면에서 다시 시도해 주세요.', 409);
        if (existing.type !== 'stock' || existing.memberId !== payload.memberId || existing.companyId !== payload.companyId
          || existing.side !== payload.side || existing.quantity !== payload.quantity || existing.price !== payload.total
          || existing.quoteVersion !== payload.quoteVersion) fail('이미 사용한 요청 번호예요.');
        return state;
      }
      const m = state.members.find((m) => m.id === payload.memberId);
      if (!m) fail('가족을 먼저 선택해 주세요.', 404);
      if (!integer(m.balance, 0, Number.MAX_SAFE_INTEGER)) fail('가족 잔액을 확인해 주세요.');
      const q = quote(state, payload.companyId, payload.side, payload.quantity);
      if (payload.quoteVersion !== q.quoteVersion || payload.total !== q.total) fail('주가가 바뀌었어요. 새 가격을 확인한 뒤 다시 요청해 주세요.', 409);
      if (payload.side === 'buy' && m.balance - reservedPieces(state, m.id) < q.total) fail('사용 가능한 피스가 부족해요.', 422);
      if (payload.side === 'sell' && availableShares(state, m.id, payload.companyId) < payload.quantity) fail('매도 가능한 주식이 부족해요.', 422);
      const c = company(state, payload.companyId);
      state.requests.push({ id, type: 'stock', memberId: m.id, companyId: c.id, companyName: c.name, side: payload.side,
        quantity: payload.quantity, price: q.total, quoteVersion: q.quoteVersion, time: now, status: 'pending' });
      if (instant) {
        return apply(state, 'decide', { requestId: id, approve: true }, { isAdmin: true, now });
      }
    } else if (action === 'cancel' || action === 'decide') {
      if (action === 'decide') requireAdmin(options);
      const r = state.requests.find((r) => r.id === payload.requestId && r.type === 'stock');
      if (!r) fail('주식 요청을 찾을 수 없어요.', 404);
      if (action === 'cancel' && r.memberId !== payload.memberId) fail('이 가족의 요청이 아니에요.', 403);
      if (action === 'decide' && typeof payload.approve !== 'boolean') fail('승인 또는 거절을 선택해 주세요.');
      if (r.status !== 'pending') return state;
      if (action === 'cancel' || !payload.approve) {
        r.status = action === 'cancel' ? 'cancelled' : 'rejected'; r.doneTime = now;
        return state;
      }
      const c = company(state, r.companyId);
      const m = state.members.find((m) => m.id === r.memberId);
      if (!m || !c) fail('가족 또는 회사 정보가 없어요.', 404);
      if (!integer(m.balance, 0, Number.MAX_SAFE_INTEGER)) fail('가족 잔액을 확인해 주세요.');
      const q = quote(state, c.id, r.side, r.quantity);
      if (r.quoteVersion !== q.quoteVersion || r.price !== q.total) {
        r.status = 'expired'; r.doneTime = now; r.doneReason = '주가가 바뀌었어요. 새 가격으로 다시 요청해 주세요.';
        return state;
      }
      if (r.side === 'buy' && m.balance - reservedPieces(state, m.id, r.id) < r.price) fail('승인할 수 있는 피스가 부족해요.', 422);
      if (r.side === 'sell' && availableShares(state, m.id, c.id, r.id) < r.quantity) fail('승인할 수 있는 주식이 부족해요.', 422);
      const before = marketPrices(state);
      let p = mk.holdings.find((p) => p.memberId === m.id && p.companyId === c.id);
      if (!p) { p = { memberId: m.id, companyId: c.id, quantity: 0, costBasis: 0 }; mk.holdings.push(p); }
      if (!integer(p.quantity, 0, MAX_SHARES) || !Number.isFinite(p.costBasis) || p.costBasis < 0) fail('주식 보유 내역을 확인해 주세요.');
      let realizedProfit = null;
      if (r.side === 'buy') {
        p.quantity += r.quantity; p.costBasis += r.price; m.balance -= r.price;
      } else {
        const soldBasis = p.costBasis * r.quantity / p.quantity;
        realizedProfit = r.price - soldBasis;
        p.quantity -= r.quantity; p.costBasis = p.quantity === 0 ? 0 : Math.max(0, p.costBasis - soldBasis);
        m.balance += r.price;
      }
      if (!Number.isSafeInteger(m.balance)) fail('잔액이 너무 커서 거래할 수 없어요.', 422);
      r.status = 'approved'; r.doneTime = now;
      c.quoteVersion += 1;
      mk.trades.push({ id: r.id, requestId: r.id, memberId: m.id, companyId: c.id, companyName: c.name, side: r.side,
        quantity: r.quantity, total: r.price, average: r.price / r.quantity, realizedProfit,
        priceBefore: before.get(c.id), priceAfter: q.nextPrice, quoteVersion: c.quoteVersion, time: now });
      state.history.push({ id: `stock-${r.id}`, marketRequestId: r.id, time: now, memberId: m.id,
        delta: r.side === 'buy' ? -r.price : r.price, reason: `주식 ${r.side === 'buy' ? '매수' : '매도'}: ${c.name} ${r.quantity}주`, balanceAfter: m.balance });
      expire(state, c.id, now);
      reprice(state, c, before, now);
    } else {
      fail('알 수 없는 주식 작업이에요.');
    }
    return state;
  }
  function priceHistory(state, companyId) {
    const c = company(state, companyId);
    if (!c) return [];
    const mk = market(state);
    const changes = [...mk.events, ...mk.trades]
      .filter((entry) => entry.companyId === companyId && Number.isFinite(entry.priceAfter) && Number.isFinite(entry.time))
      .sort((a, b) => a.time - b.time || (a.quoteVersion || 0) - (b.quoteVersion || 0));
    const initialPrice = changes[0]?.priceBefore ?? nextPrice(state, c.id);
    return [{ time: c.createdAt, price: initialPrice }, ...changes.map((entry) => ({ time: entry.time, price: entry.priceAfter }))];
  }

  return { ensure, outstanding, holding, reservedPieces, availableShares, quote, apply, validate, priceHistory, priceAt, priceCurve, nextPrice, linkedCompanies, neighbors, upgradeLinks, expandLinks, MAX_ORDER, MAX_SHARES };
});
