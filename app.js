/* 피스 상점 — 가족 공용화폐로 운영하는 가정용 상점 (데이터는 브라우저 localStorage에 저장) */
(() => {
  'use strict';

  const STORE_KEY = 'peace-shop-v1';
  const MEMBER_KEY = 'peace-shop-member';
  const AUTH_KEY = 'peace-shop-auth';
  const DEFAULT_PASSWORD = '1234';
  const WON_PER_PIECE = 1000;
  const MINUTES_PER_PIECE = 10;
  const BONUS = 20;
  const Market = window.PeaceMarket;
  const SUBJECTS = {
    math: { label: '수학', rate: 2 },
    other: { label: '그 외 과목', rate: 3 },
  };
  const CATEGORIES = [
    { id: 'game', label: '게임시간', emoji: '🎮' },
    { id: 'food', label: '먹을 것', emoji: '🍪' },
    { id: 'perk', label: '특권', emoji: '👑' },
    { id: 'item', label: '물건', emoji: '✏️' },
    { id: 'cash', label: '환전', emoji: '💵' },
  ];

  // ---------- Storage ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const safeGet = (store, key) => { try { return store.getItem(key); } catch { return null; } };
  const safeSet = (store, key, val) => { try { store.setItem(key, val); } catch { /* 저장 불가 환경 */ } };
  const safeDel = (store, key) => { try { store.removeItem(key); } catch { /* noop */ } };

  function defaultState() {
    const p = (name, category, price, stock = null) => ({ id: uid(), name, category, price, stock });
    return {
      version: 1,
      members: [],
      products: [
        p('게임시간 10분', 'game', 1),
        p('게임시간 30분', 'game', 3),
        p('과자 한 봉지', 'food', 2, 5),
        p('컵라면', 'food', 3, 4),
        p('음료수', 'food', 2, 6),
        p('배달 음식 주문권', 'food', 15, 1),
        p('설거지 면제권', 'perk', 3),
        p('청소 면제권', 'perk', 3),
        p('TV 채널 선택권', 'perk', 1),
        p('늦잠 허락권', 'perk', 4),
        p('문구류 1개', 'item', 3, 3),
      ],
      requests: [],
      history: [],
      settings: { leftover: 'carry', passwordHash: null },
    };
  }

  function load() {
    const raw = safeGet(localStorage, STORE_KEY);
    if (!raw) return defaultState();
    try {
      const data = JSON.parse(raw);
      const base = defaultState();
      return { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } };
    } catch {
      return defaultState();
    }
  }

  let state = Market.ensure(load());

  // ---------- 서버 공유 저장소 (api/state가 있으면 서버 모드, 없으면 이 기기 저장 모드) ----------
  const TOKEN_KEY = 'peace-shop-token';
  const server = { on: false, rev: 0, inflight: 0 };
  const token = () => safeGet(sessionStorage, TOKEN_KEY) || '';
  let chain = Promise.resolve();
  let ready = false;

  function adopt(j) {
    const base = defaultState();
    server.rev = j.rev;
    state = Market.ensure({ ...base, ...j.state, settings: { ...base.settings, ...(j.state.settings || {}) } });
  }

  function save() {
    if (!server.on) return safeSet(localStorage, STORE_KEY, JSON.stringify(state));
    server.inflight++;
    chain = chain.then(async () => {
      try {
        const res = await fetch('api/state', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-token': token() },
          body: JSON.stringify({ rev: server.rev, state }),
        });
        const j = await res.json().catch(() => null);
        if (res.ok && j) adopt(j);
        else if (res.status === 409) {
          if (j?.state) adopt(j); else await refreshState();
          toast(j?.error || '다른 기기에서 먼저 바뀌어 새로 불러왔어요. 다시 해 주세요');
        }
        else if (res.status === 401) { safeDel(sessionStorage, TOKEN_KEY); safeDel(sessionStorage, AUTH_KEY); toast('다시 로그인해 주세요'); }
        else { toast(j?.error || '서버에 저장하지 못했어요'); await refreshState(); }
      } catch {
        toast('서버에 연결할 수 없어요. 저장 여부를 다시 확인해 주세요');
        await refreshState();
      } finally {
        server.inflight--;
        if (!server.inflight) render();
      }
    });
  }

  async function poll() {
    if (document.hidden || server.inflight || modal.open) return;
    const a = document.activeElement;
    if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    try {
      const res = await fetch('api/state', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (j.rev !== server.rev && !server.inflight) {
        const before = pendingTotal();
        adopt(j);
        if (isAuthed() && pendingTotal() > before) toast('🔔 새 요청이 왔어요');
        render();
      }
    } catch { /* 일시적인 연결 끊김 */ }
  }

  // ---------- 알림 (Web Push) ----------
  const push = { supported: false, subscribed: false, denied: false };
  const keyBytes = (b64) => {
    const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  async function pushInit() {
    push.supported = server.on && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!push.supported) return;
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      push.subscribed = !!(await reg.pushManager.getSubscription());
      push.denied = Notification.permission === 'denied';
    } catch {
      push.supported = false;
    }
  }

  const pendingTotal = () => state.requests.filter((r) => r.status === 'pending').length;

  async function api(path, payload) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': token() },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  async function refreshState() {
    try {
      const res = await fetch('api/state', { cache: 'no-store' });
      if (res.ok) { const j = await res.json(); if (j.state) adopt(j); }
    } catch { /* 다음 동기화에서 다시 확인 */ }
  }

  // 기존 저장과 주식 처리를 직렬화해 같은 화면에서의 중복 사용도 막는다.
  function marketAction(action, payload, message) {
    const notice = () => {
      if (action === 'decide' && payload.approve) {
        const r = state.requests.find((request) => request.id === payload.requestId);
        if (r?.status !== 'approved') return r?.status === 'expired' ? '가격이 바뀌어 요청이 만료됐어요. 가족이 새 가격으로 다시 요청해 주세요' : '이미 처리된 요청이에요';
      }
      return message;
    };
    return stateAction('api/market', { action, ...payload }, () => Market.apply(state, action, payload, { isAdmin: isAuthed() }), notice);
  }

  function replaceState(next, message) {
    Market.validate(next);
    return stateAction('api/state/replace', null, () => next, message);
  }

  function stateAction(path, payload, localChange, message) {
    const task = async () => {
      try {
        if (server.on) {
          const body = payload || { rev: server.rev, state: localChange() };
          const result = await api(path, body);
          if (!result.ok) {
            if (result.status === 401) { safeDel(sessionStorage, TOKEN_KEY); safeDel(sessionStorage, AUTH_KEY); }
            if (result.data.state) adopt(result.data);
            else await refreshState();
            throw new Error(result.status === 401 ? '엄마 화면에 다시 로그인해 주세요' : result.data.error || '처리하지 못했어요. 새 상태를 확인하고 다시 시도해 주세요');
          }
          adopt(result.data);
        } else {
          state = Market.ensure(localChange());
          safeSet(localStorage, STORE_KEY, JSON.stringify(state));
        }
        if (message) toast(typeof message === 'function' ? message() : message);
        return true;
      } catch (error) {
        toast(error.message || '연결을 확인하고 다시 시도해 주세요');
        return false;
      } finally {
        server.inflight--;
        render();
      }
    };
    server.inflight++;
    const result = chain.then(task, task);
    chain = result.then(() => undefined);
    return result;
  }

  // ---------- Helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const modal = $('#modal');
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n).toLocaleString('ko-KR');
  const fmtTime = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const cat = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[3];
  const member = (id) => state.members.find((m) => m.id === id);
  const product = (id) => state.products.find((p) => p.id === id);
  const deltaHtml = (d) => `<span class="delta ${d >= 0 ? 'plus' : 'minus'}">${d >= 0 ? '+' : ''}${fmt(d)}피스</span>`;
  const coin = (sm = true) => `<span class="coin${sm ? ' sm' : ''}">P</span>`;

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function pendingOf(memberId) {
    return Market.reservedPieces(state, memberId);
  }

  const requestLabel = (r) => r.type === 'stock' ? `${r.companyName} · ${r.side === 'buy' ? '매수' : '매도'} ${fmt(r.quantity)}주` : r.type === 'purchase' ? `${r.productName} 구매` : `📚 완주 신고 · ${r.title}`;
  const requestDelta = (r) => r.type === 'stock' ? (r.side === 'buy' ? -r.price : r.price) : r.type === 'purchase' ? -r.price : BONUS;
  const requestStatus = (r) => ({ approved: r.type === 'stock' ? '체결' : '승인', rejected: '거절', cancelled: '취소', expired: '가격 변경 · 재요청 필요', pending: '승인 대기' }[r.status] || r.status);
  const company = (id) => state.market.companies.find((c) => c.id === id);
  const precise = (n) => Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 });

  function record(memberId, delta, reason) {
    const m = member(memberId);
    m.balance += delta;
    state.history.push({ id: uid(), time: Date.now(), memberId, delta, reason, balanceAfter: m.balance });
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function checkPassword(pw) {
    if (server.on) {
      const r = await api('api/login', { pw });
      if (r.ok) safeSet(sessionStorage, TOKEN_KEY, r.data.token);
      return r.ok;
    }
    const expected = state.settings.passwordHash || (await sha256(DEFAULT_PASSWORD));
    return (await sha256(pw)) === expected;
  }

  // ---------- Modal ----------
  function openModal(html, onSubmit) {
    modal.innerHTML = `<form method="dialog">${html}</form>`;
    const form = $('form', modal);
    form.addEventListener('submit', async (e) => {
      const submitter = e.submitter;
      if (submitter && submitter.value === 'cancel') return;
      e.preventDefault();
      if (form.dataset.busy) return;
      const fd = new FormData(form);
      form.dataset.busy = '1';
      const buttons = [...form.querySelectorAll('button')];
      buttons.forEach((button) => { button.disabled = true; });
      try {
        const ok = await onSubmit(fd);
        if (ok !== false && form.isConnected) modal.close();
      } catch (error) { toast(error.message || '다시 시도해 주세요'); }
      finally { delete form.dataset.busy; buttons.forEach((button) => { button.disabled = false; }); }
    });
    if (!modal.open) modal.showModal();
    const first = $('input, select', form);
    if (first) first.focus();
  }

  function confirmModal(title, message, confirmLabel, onConfirm, danger = false) {
    openModal(`
      <h3>${h(title)}</h3>
      <p class="muted" style="margin:0">${message}</p>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>취소</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${h(confirmLabel)}</button>
      </div>`, () => onConfirm());
  }

  // ---------- Routing ----------
  const ui = { shopCat: 'all', adminTab: 'approve', historyFilter: 'all', chartCompanyId: null };
  const route = () => (['admin', 'market'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'shop');
  const isAuthed = () => safeGet(sessionStorage, AUTH_KEY) === '1';

  function render() {
    if (!ready) return;
    const r = route();
    document.querySelectorAll('.mainnav a').forEach((a) => a.classList.toggle('active', a.dataset.route === r));
    app.innerHTML = r === 'admin' ? (isAuthed() ? renderAdmin() : renderLogin()) : r === 'market' ? renderMarket() : renderShop();
    if (r === 'market') drawPriceChart();
  }

  // ---------- Shop (가족용) ----------
  function currentMemberId() {
    const saved = safeGet(localStorage, MEMBER_KEY);
    if (saved && member(saved)) return saved;
    return state.members[0]?.id || null;
  }

  function renderShop() {
    if (!state.members.length) {
      return `<div class="card empty">
        <span class="big">👨‍👩‍👧‍👦</span>
        <h2 style="margin-bottom:6px">아직 등록된 가족이 없어요</h2>
        <p>엄마 화면에서 가족과 시작 잔액을 등록하면 상점이 열립니다.</p>
        <a class="btn primary" href="#admin">엄마 화면으로 가기</a>
      </div>`;
    }
    const mid = currentMemberId();
    const me = member(mid);
    const pending = pendingOf(mid);
    const available = me.balance - pending;
    const myRequests = state.requests.filter((r) => r.memberId === mid && r.status === 'pending');
    const myHistory = state.history.filter((x) => x.memberId === mid).slice(-8).reverse();
    const products = state.products.filter((p) => ui.shopCat === 'all' || p.category === ui.shopCat);
    const usedCats = CATEGORIES.filter((c) => state.products.some((p) => p.category === c.id));

    return `<div class="stack">
      <div class="spread">
        <div class="chips" role="tablist" aria-label="가족 선택">
          ${state.members.map((m) => `<button class="chip ${m.id === mid ? 'active' : ''}" data-action="pick-member" data-id="${m.id}">${h(m.name)}</button>`).join('')}
        </div>
      </div>

      <section class="card hero">
        <div>
          <div class="label">${h(me.name)}의 피스</div>
          <div class="amount num">${coin(false)} ${fmt(me.balance)} <small>피스</small></div>
          <div class="sub">게임 ${fmt(me.balance * MINUTES_PER_PIECE)}분 · ${fmt(me.balance * WON_PER_PIECE)}원 어치${pending ? ` · 승인 대기 ${fmt(pending)}피스 (사용 가능 ${fmt(available)}피스)` : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn" data-action="bonus-request">📚 문제집 완주 신고 (+${BONUS})</button>
          ${state.settings.transfer !== false && state.members.length > 1 ? '<button class="btn" data-action="transfer">💌 피스 보내기</button>' : ''}
        </div>
      </section>

      <section>
        <div class="section-title"><h2>상품</h2><span class="muted" style="font-size:.85rem">구매 요청 → 엄마 승인 후 차감</span></div>
        <div class="chips" style="margin-bottom:14px">
          <button class="chip ${ui.shopCat === 'all' ? 'active' : ''}" data-action="shop-cat" data-id="all">전체</button>
          ${usedCats.map((c) => `<button class="chip ${ui.shopCat === c.id ? 'active' : ''}" data-action="shop-cat" data-id="${c.id}">${c.emoji} ${c.label}</button>`).join('')}
        </div>
        ${products.length ? `<div class="products">${products.map((p) => productCard(p, available)).join('')}</div>`
          : '<div class="card empty">이 분류에는 상품이 없어요.</div>'}
      </section>

      <div class="grid-2">
        <section class="card">
          <div class="section-title"><h3>승인 대기 중인 요청</h3></div>
          ${myRequests.length ? `<ul class="list">${myRequests.map((r) => `<li>
              <div><div>${h(requestLabel(r))}</div>
              <div class="meta">${fmtTime(r.time)}</div></div>
              <div class="row">${deltaHtml(requestDelta(r))}
              <button class="btn sm" data-action="cancel-request" data-id="${r.id}">취소</button></div>
            </li>`).join('')}</ul>` : '<p class="muted" style="margin:0">대기 중인 요청이 없어요.</p>'}
        </section>
        <section class="card">
          <div class="section-title"><h3>최근 내역</h3></div>
          ${myHistory.length ? `<ul class="list">${myHistory.map((x) => `<li>
              <div><div>${h(x.reason)}</div><div class="meta">${fmtTime(x.time)} · 잔액 ${fmt(x.balanceAfter)}</div></div>
              ${deltaHtml(x.delta)}</li>`).join('')}</ul>` : '<p class="muted" style="margin:0">아직 내역이 없어요.</p>'}
        </section>
      </div>
    </div>`;
  }

  function productCard(p, available) {
    const c = cat(p.category);
    const soldout = p.stock !== null && p.stock <= 0;
    const short = available < p.price;
    let stockBadge = '<span class="badge green">재고 넉넉</span>';
    if (p.stock !== null) stockBadge = soldout ? '<span class="badge red">품절</span>' : `<span class="badge">남은 수량 ${fmt(p.stock)}</span>`;
    return `<article class="card product ${soldout ? 'soldout' : ''}">
      <div class="spread"><div class="emoji" aria-hidden="true">${c.emoji}</div>${stockBadge}</div>
      <div><div class="name">${h(p.name)}</div><div class="muted" style="font-size:.8rem">${c.label}</div></div>
      <div class="foot">
        <div class="price num">${coin()} ${fmt(p.price)} <small>피스 · ${fmt(p.price * WON_PER_PIECE)}원</small></div>
        <button class="btn primary block" data-action="buy" data-id="${p.id}" ${soldout || short ? 'disabled' : ''}>
          ${soldout ? '품절' : short ? `피스 부족 (${fmt(p.price - available)} 더 필요)` : '구매 요청'}
        </button>
      </div>
    </article>`;
  }

  // ---------- 우리 가족 주식 ----------
  function familyChips(mid) {
    return `<div class="chips" aria-label="가족 선택">${state.members.map((m) => `<button class="chip ${m.id === mid ? 'active' : ''}" data-action="pick-member" data-id="${h(m.id)}">${h(m.name)}</button>`).join('')}</div>`;
  }

  function marketPrice(c) { return c.basePrice + Math.floor(Market.outstanding(state, c.id) / 5); }

  const chartPieces = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
  const priceLabels = (won) => `<strong>${fmt(won)}원</strong><span>${chartPieces.format(Math.trunc(won / 10) / 100)}피스</span>`;

  function marketChart() {
    const companies = state.market.companies;
    if (!companies.length) return '';
    const selected = companies.find((c) => c.id === ui.chartCompanyId) || companies[0];
    return `<section class="card stock-chart" aria-labelledby="stock-chart-title">
      <div class="spread"><h2 id="stock-chart-title">주식 가격 그래프</h2>
      <label>종목 <select id="chart-company">${companies.map((c) => `<option value="${h(c.id)}"${c === selected ? ' selected' : ''}>${h(c.name)}</option>`).join('')}</select></label></div>
      <div id="stock-chart-body"></div>
    </section>`;
  }

  function drawPriceChart() {
    const choice = $('#chart-company');
    if (!choice) return;
    const points = Market.priceHistory(state, choice.value);
    if (!points.length) return;
    const prices = points.map((point) => Math.round(point.price * WON_PER_PIECE));
    let low = prices.reduce((a, b) => Math.min(a, b));
    let high = prices.reduce((a, b) => Math.max(a, b));
    if (low === high) { low = Math.max(0, low - 1000); high += 1000; }
    low = Math.floor(low / 10) * 10;
    const step = Math.max(10, Math.ceil((high - low) / 40) * 10);
    high = low + step * 4;
    const ticks = Array.from({ length: 5 }, (_, i) => high - step * i);
    const last = points.length - 1;
    $('#stock-chart-body').innerHTML = `<div class="stock-chart-readout"><div><span id="chart-point-label" class="muted"></span><div class="stock-chart-value" id="chart-point-price"></div></div><span class="meta">다음 1주 매수가 · 1피스 = 1,000원</span></div>
      <div class="stock-chart-grid"><div class="stock-chart-axis" aria-hidden="true">${ticks.map((won) => `<div>${priceLabels(won)}</div>`).join('')}</div>
      <div class="stock-chart-plot" aria-hidden="true"><canvas id="stock-price-line" width="900" height="224"></canvas></div></div>
      ${last ? `<label class="stock-chart-control">가격 기록 보기<input id="chart-point" type="range" min="0" max="${last}" value="${last}" step="1"></label>` : '<p class="muted stock-chart-empty">첫 가격이에요. 거래나 실적·미션이 반영되면 기록이 이어져요.</p>'}`;

    const ctx = $('#stock-price-line').getContext('2d');
    const input = $('#chart-point');
    const x = (i) => last ? 12 + i * 876 / last : 450;
    const y = (won) => 22.4 + (high - won) / (high - low) * 179.2;
    const update = () => {
      const index = input ? Number(input.value) : last;
      const label = index === 0 ? (last ? '시작 가격' : '현재 가격') : index === last ? '현재 가격' : fmtTime(points[index].time);
      $('#chart-point-label').textContent = label;
      $('#chart-point-price').innerHTML = priceLabels(prices[index]);
      input?.setAttribute('aria-valuetext', `${label}, ${fmt(prices[index])}원, ${chartPieces.format(Math.trunc(prices[index] / 10) / 100)}피스`);
      if (!ctx) return;
      const palette = getComputedStyle(document.documentElement);
      ctx.clearRect(0, 0, 900, 224);
      ctx.beginPath();
      for (const tick of ticks) { ctx.moveTo(0, y(tick)); ctx.lineTo(900, y(tick)); }
      ctx.strokeStyle = palette.getPropertyValue('--line').trim();
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x(0), y(prices[0]));
      prices.slice(1).forEach((won, i) => ctx.lineTo(x(i + 1), y(won)));
      const accent = palette.getPropertyValue('--accent').trim();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x(index), y(prices[index]), 6, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    };
    input?.addEventListener('input', update);
    update();
  }

  function liquidationValue(c, quantity) {
    const total = Market.outstanding(state, c.id);
    let value = 0;
    for (let k = 1; k <= quantity; k++) value += c.basePrice + Math.floor((total - k) / 5);
    return value;
  }

  function marketActivity() {
    const news = [
      ...state.market.events.map((e) => ({ ...e, activityType: 'event' })),
      ...state.market.trades.map((t) => ({ ...t, activityType: 'trade' })),
    ].sort((a, b) => (b.time || b.createdAt || 0) - (a.time || a.createdAt || 0)).slice(0, 12);
    if (!news.length) return '<p class="muted">아직 기록이 없어요. 회사 실적, 미션 결과와 승인된 거래가 여기에 남아요.</p>';
    return `<ul class="list market-news">${news.map((entry) => {
      const c = company(entry.companyId);
      const label = entry.activityType === 'trade' ? `${member(entry.memberId)?.name || '가족'} · ${entry.side === 'buy' ? '매수' : '매도'} ${fmt(entry.quantity)}주` : `${entry.kind === 'mission' ? '가족 미션' : entry.kind === 'performance' ? '회사 실적' : '회사 등록'} · ${entry.title || c?.name || ''}`;
      const delta = entry.delta;
      const detail = entry.activityType === 'trade' ? `총 ${fmt(entry.total ?? entry.price ?? 0)}피스` : Number.isFinite(delta) ? `기준가 ${delta >= 0 ? '+' : ''}${fmt(delta)}피스` : '거래 시작';
      const move = Number.isFinite(entry.priceBefore) && Number.isFinite(entry.priceAfter) ? `<div class="meta">다음 매수가 ${fmt(entry.priceBefore)} → ${fmt(entry.priceAfter)}피스</div>` : '';
      return `<li><div><span class="meta">${h(c?.name || entry.companyName || '회사')} · ${fmtTime(entry.time || entry.createdAt)}</span><div>${h(label)}</div>${move}</div><span class="badge ${entry.activityType === 'event' ? 'gold' : ''}">${h(detail)}</span></li>`;
    }).join('')}</ul>`;
  }

  function marketRules() {
    return `<details class="card market-rules"><summary>주가는 어떻게 움직이나요?</summary><div class="stack">
      <p><strong>기준가 + 수요</strong>로 정해져요. 가족 전체가 보유한 주식이 5주 늘 때마다 다음 매수 가격에 1피스가 붙고, 팔면 그만큼 내려가요.</p>
      <p>엄마가 <strong>회사 실적·가족 미션 결과</strong>를 기록하면 기준가도 바뀝니다. 여러 주를 한 번에 사고팔면 주마다 단가가 달라질 수 있어 총액을 먼저 보여드려요.</p>
      <p>매수와 매도는 내 거래 PIN을 입력하면 즉시 체결돼요. 가격이 바뀌면 새 총액을 확인해 주세요.</p>
      <p>매도대금은 가족 상점에서 지급해 기존 피스 잔액에 더합니다. 주가가 내려가면 산 가격보다 적게 돌려받을 수 있어요. 실제 회사 주식이나 현금 투자는 아닙니다.</p>
    </div></details>`;
  }

  function renderMarket() {
    if (!state.members.length) return `<div class="card empty"><span class="big">🌱</span><h2>우리 가족의 첫 주식</h2><p>엄마 화면에서 가족을 먼저 등록해 주세요.</p><a class="btn primary" href="#admin">엄마 화면으로</a></div>`;
    const mid = currentMemberId();
    const me = member(mid);
    const reserved = pendingOf(mid);
    const holdings = state.market.companies.map((c) => ({ c, held: Market.holding(state, mid, c.id) })).filter(({ held }) => held.quantity > 0);
    const value = holdings.reduce((sum, { c, held }) => sum + liquidationValue(c, held.quantity), 0);
    const cost = holdings.reduce((sum, { held }) => sum + held.costBasis, 0);
    const requests = state.requests.filter((r) => r.type === 'stock' && r.memberId === mid).slice(-10).reverse();
    const realized = state.market.trades.filter((t) => t.memberId === mid && t.side === 'sell').reduce((sum, t) => sum + (t.realizedProfit || 0), 0);
    return `<div class="stack market-page">
      <div class="spread"><div><p class="market-eyebrow">PEACE FAMILY MARKET</p><h1>우리 가족 주식</h1><p class="muted market-intro">공부로 모은 피스, 우리 가족 회사와 함께.</p></div><a class="btn" href="#shop">상점으로</a></div>
      ${familyChips(mid)}
      <section class="market-summary" aria-label="나의 주식 요약">
        <div class="card market-cash"><span class="muted">${h(me.name)}의 사용 가능 피스</span><strong>${fmt(me.balance - reserved)} <small>피스</small></strong><span class="meta">전체 ${fmt(me.balance)} · 예약 ${fmt(reserved)}</span></div>
        <div class="card"><span class="muted">보유 주식 매도 예상액</span><strong>${fmt(value)} <small>피스</small></strong><span class="meta">매입 원가 ${precise(cost)}피스</span></div>
        <div class="card"><span class="muted">보유 주식 평가 손익</span><strong class="${value - cost >= 0 ? 'market-positive' : 'market-negative'}">${value - cost >= 0 ? '+' : ''}${precise(value - cost)} <small>피스</small></strong><span class="meta">매도해 확정한 손익 ${realized >= 0 ? '+' : ''}${precise(realized)}피스</span></div>
      </section>
      ${marketChart()}
      <section><div class="section-title"><h2>우리 가족 회사</h2></div>
      ${state.market.companies.length ? `<div class="market-companies">${state.market.companies.map((c, i) => {
        const held = Market.holding(state, mid, c.id);
        const available = Market.availableShares(state, mid, c.id);
        const outstanding = Market.outstanding(state, c.id);
        const price = marketPrice(c);
        const sellPrice = outstanding > 0 ? c.basePrice + Math.floor((outstanding - 1) / 5) : null;
        return `<article class="card company-card"><div class="spread"><span class="company-symbol" aria-hidden="true">${['🌱', '🍪', '🚀', '🏡'][i % 4]}</span><span class="badge">가족 보유 ${fmt(outstanding)}주</span></div><div><h3>${h(c.name)}</h3><p class="muted company-description">${h(c.description || '함께 키워 가는 우리 가족 회사')}</p></div>
          <div class="company-price"><span class="muted">다음 1주 매수가</span><strong>${fmt(price)} <small>피스</small></strong><span class="meta">기준가 ${fmt(c.basePrice)} + 수요 ${fmt(price - c.basePrice)}${sellPrice !== null ? ` · 1주 매도가 ${fmt(sellPrice)}` : ''}</span></div>
          <div class="company-owned"><span>내 보유 <strong>${fmt(held.quantity)}주</strong></span><span class="meta">매도 가능 ${fmt(available)}주</span></div>
          <div class="market-trade-buttons"><button class="btn primary" data-action="market-buy" data-id="${h(c.id)}" ${me.balance - reserved < price || outstanding >= 10000 ? 'disabled' : ''}>바로 매수</button><button class="btn" data-action="market-sell" data-id="${h(c.id)}" ${available < 1 ? 'disabled' : ''}>바로 매도</button></div>
        </article>`;
      }).join('')}</div>` : '<div class="card empty"><span class="big">🌱</span><h3>첫 회사를 기다리고 있어요</h3><p>엄마 화면의 ‘주식 관리’에서 회사 이름과 시작 기준가를 정해 주세요.</p><a class="btn primary" href="#admin" data-action="market-admin">회사 만들기</a></div>'}</section>
      ${holdings.length ? `<section class="card"><div class="section-title"><h2>내 보유 주식</h2><span class="muted">현재 기준으로 전량 매도할 때의 예상액</span></div><div class="table-wrap"><table><thead><tr><th>회사</th><th class="right">보유</th><th class="right">평균 매입가</th><th class="right">매도 예상액</th><th class="right">평가 손익</th></tr></thead><tbody>${holdings.map(({ c, held }) => {
        const estimate = liquidationValue(c, held.quantity);
        const profit = estimate - held.costBasis;
        return `<tr><td>${h(c.name)}</td><td class="right">${fmt(held.quantity)}주</td><td class="right">${precise(held.costBasis / held.quantity)}</td><td class="right">${fmt(estimate)}피스</td><td class="right ${profit >= 0 ? 'market-positive' : 'market-negative'}">${profit >= 0 ? '+' : ''}${precise(profit)}</td></tr>`;
      }).join('')}</tbody></table></div><p class="meta">실제 체결 전까지 가격은 바뀔 수 있어요. 한 번에 최대 100주씩 요청할 수 있습니다.</p></section>` : ''}
      <div class="grid-2"><section class="card"><div class="section-title"><h2>내 주식 요청</h2><span class="meta">최근 10건</span></div>${requests.length ? `<ul class="list market-requests">${requests.map((r) => `<li><div><strong>${h(requestLabel(r))}</strong><div class="meta">${fmtTime(r.time)} · 총 ${fmt(r.price)}피스</div><span class="badge ${r.status === 'approved' ? 'green' : r.status === 'expired' ? 'gold' : ''}">${h(requestStatus(r))}</span></div>${r.status === 'pending' ? `<button class="btn sm" data-action="cancel-request" data-id="${h(r.id)}">취소</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">아직 주식 요청이 없어요.</p>'}</section>
      <section class="card"><div class="section-title"><h2>가격이 움직인 이야기</h2></div>${marketActivity()}</section></div>
      ${marketRules()}
    </div>`;
  }

  function adminMarket() {
    const pins = server.on && state.members.length ? `<section class="card"><h3>가족별 거래 PIN</h3><p class="muted">가족마다 다른 숫자 6자리 PIN을 정해 해당 가족에게만 알려 주세요. 이 PIN으로 주식을 바로 사고팔 수 있어요.</p><div class="row">${state.members.map((m) => `<button class="btn" data-action="market-pin" data-id="${h(m.id)}">${h(m.name)} PIN 설정</button>`).join('')}</div></section>` : '';
    return `<div class="stack"><section class="card"><div class="spread"><div><h2>우리 가족 회사 관리</h2><p class="muted">실적과 미션 결과를 남기고 회사의 기준가를 조정해요.</p></div><button class="btn primary" data-action="market-create">＋ 회사 추가</button></div><p class="meta">이전에 접수된 대기 요청은 ‘승인’ 탭에서 확인할 수 있어요.</p></section>
      ${state.market.companies.length ? `<div class="market-companies">${state.market.companies.map((c) => `<article class="card company-card"><h3>${h(c.name)}</h3><p class="muted">${h(c.description)}</p><div class="company-price"><span class="muted">다음 1주 매수가</span><strong>${fmt(marketPrice(c))} <small>피스</small></strong><span class="meta">기준가 ${fmt(c.basePrice)} · 가족 보유 ${fmt(Market.outstanding(state, c.id))}주</span></div><button class="btn primary" data-action="market-event" data-id="${h(c.id)}">실적·미션 결과 반영</button></article>`).join('')}</div>` : '<div class="card empty">등록된 회사가 없어요. 가족이 함께 정한 회사 이름으로 시작해 보세요.</div>'}
      ${pins}<section class="card"><h3>회사와 거래 기록</h3>${marketActivity()}</section>${marketRules()}</div>`;
  }

  function openBuyPin(memberId) {
    const m = member(memberId);
    if (!m) return false;
    openModal(`<h3>${h(m.name)} 거래 PIN 설정</h3>
      <label class="field">새 PIN<input type="password" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="new-password" required></label>
      <p class="meta">숫자 6자리로 설정해 주세요.</p>
      <div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary">PIN 저장</button></div>`, (fd) =>
      stateAction('api/market', { action: 'set-buy-pin', memberId, pin: fd.get('pin') }, () => state, '거래 PIN을 저장했어요'));
    return false;
  }

  function openTrade(companyId, side) {
    const c = company(companyId);
    const mid = currentMemberId();
    const me = member(mid);
    if (!c || !me) return false;
    const max = side === 'sell' ? Math.min(100, Market.availableShares(state, mid, c.id)) : Math.min(100, 10000 - Market.outstanding(state, c.id));
    if (max < 1) { toast(side === 'sell' ? '매도 가능한 주식이 없어요' : '이 회사의 발행 한도에 도달했어요'); return false; }
    const requestId = uid();
    let shownQuote = null;
    let shownQuantity = 0;
    const buy = side === 'buy';
    openModal(`<h3>${h(c.name)} ${buy ? '바로 매수' : '바로 매도'}</h3><p class="muted">${h(me.name)} · 사용 가능 ${fmt(me.balance - pendingOf(mid))}피스 · 매도 가능 ${fmt(Market.availableShares(state, mid, c.id))}주</p>
      <label class="field">주식 수량<input type="number" name="quantity" min="1" max="${max}" step="1" inputmode="numeric" value="1" required></label>
      <div class="preview trade-preview" id="trade-preview" aria-live="polite"></div>
      ${server.on ? '<label class="field">내 거래 PIN<input type="password" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required></label>' : ''}
      <p class="meta">${buy ? '총액을 확인하고 매수하면 피스가 차감되고 주식이 바로 들어와요.' : '총액을 확인하고 매도하면 주식이 줄고 피스가 바로 들어와요.'}</p>
      <div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary">${buy ? '매수 확정' : '매도 확정'}</button></div>`, async (fd) => {
      const quantity = Number(fd.get('quantity'));
      if (!shownQuote || quantity !== shownQuantity) { toast('수량과 거래 총액을 확인해 주세요'); return false; }
      return marketAction(side, { id: requestId, memberId: mid, companyId: c.id, side, quantity,
        quoteVersion: shownQuote.quoteVersion, total: shownQuote.total, ...(server.on ? { pin: fd.get('pin') } : {}) },
      buy ? '주식을 매수했어요' : '주식을 매도했어요');
    });
    const input = $('input[name="quantity"]', modal);
    const update = () => {
      const quantity = Number(input.value);
      const output = $('#trade-preview');
      try {
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > max) throw new Error(`1~${max}주 사이의 정수를 입력해 주세요`);
        shownQuote = Market.quote(state, c.id, side, quantity);
        shownQuantity = quantity;
        const insufficient = side === 'buy' && shownQuote.total > me.balance - pendingOf(mid);
        output.innerHTML = `<span>${side === 'buy' ? '총 결제' : '총 받을'} 피스</span><strong>${fmt(shownQuote.total)} <small>피스</small></strong><div class="meta">첫 주 ${fmt(shownQuote.first)} · 마지막 주 ${fmt(shownQuote.last)} · 평균 ${precise(shownQuote.average)}피스</div>${insufficient ? '<p class="market-negative">사용 가능한 피스가 부족해요. 수량을 줄여 주세요.</p>' : ''}`;
        if (insufficient) shownQuote = null;
      } catch (error) { shownQuote = null; output.textContent = error.message; }
    };
    input.addEventListener('input', update);
    update();
    return false;
  }

  function openCompanyCreate() {
    const id = uid();
    openModal(`<h3>우리 가족 회사 만들기</h3><label class="field">회사 이름<input name="name" required maxlength="30" placeholder="예: 우리집 간식회사"></label><label class="field">어떤 회사인가요?<textarea name="description" maxlength="160" rows="2" placeholder="회사가 하는 일과 목표를 적어 주세요"></textarea></label><label class="field">시작 기준가 (1주)<input name="basePrice" type="number" min="1" max="10000" step="1" value="5" required></label><p class="meta">처음에는 보유 주식이 0주라 기준가가 매수가예요. 가족이 5주 보유할 때마다 다음 매수가에 1피스가 붙습니다.</p><div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary">회사 만들기</button></div>`, (fd) => marketAction('company-create', { id, name: String(fd.get('name')).trim(), description: String(fd.get('description')).trim(), basePrice: Number(fd.get('basePrice')) }, '회사를 등록했어요'));
    return false;
  }

  function openMarketEvent(companyId) {
    const c = company(companyId);
    if (!c) return false;
    const id = uid();
    openModal(`<h3>${h(c.name)} 결과 반영</h3><label class="field">어떤 결과인가요?<select name="kind"><option value="performance">회사 실적</option><option value="mission">가족 미션</option></select></label><label class="field">결과와 이유<input name="title" required maxlength="100" placeholder="예: 이번 주 독서 미션 달성"></label><label class="field">기준가 변화 (피스)<input type="number" name="delta" min="-100" max="100" step="1" value="1" required></label><div class="preview" id="event-preview" aria-live="polite"></div><p class="meta">이미 가진 주식의 가치도 바뀌며, 이 회사의 대기 요청은 만료됩니다. 결과와 이유는 가족 모두가 볼 수 있어요.</p><div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary">결과 반영하기</button></div>`, (fd) => marketAction('event', { id, companyId, kind: fd.get('kind'), title: String(fd.get('title')).trim(), delta: Number(fd.get('delta')) }, '결과를 기록하고 기준가에 반영했어요'));
    const input = $('input[name="delta"]', modal);
    const update = () => {
      const delta = Number(input.value);
      const next = c.basePrice + delta;
      $('#event-preview').textContent = Number.isInteger(delta) && delta !== 0 && Math.abs(delta) <= 100 && next >= 1 && next <= 10000 ? `기준가 ${fmt(c.basePrice)} → ${fmt(next)}피스 · 다음 1주 매수가 ${fmt(marketPrice(c))} → ${fmt(marketPrice(c) + delta)}피스` : '변화는 −100~100 사이의 0이 아닌 정수, 변경 후 기준가는 1~10,000피스여야 해요.';
    };
    input.addEventListener('input', update);
    update();
    return false;
  }

  // ---------- Admin (엄마 전용) ----------
  function renderLogin() {
    return `<div class="card login">
      <span class="coin">P</span>
      <h2>엄마 전용 화면</h2>
      <p class="muted">비밀번호를 입력해 주세요.${state.settings.passwordHash || state.settings.passwordSet ? '' : ` (처음 비밀번호: ${DEFAULT_PASSWORD} — 설정에서 꼭 바꿔 주세요)`}</p>
      <form id="login-form" class="stack" style="gap:10px">
        <input type="password" name="pw" inputmode="numeric" autocomplete="current-password" placeholder="비밀번호" required>
        <button class="btn primary block">들어가기</button>
      </form>
    </div>`;
  }

  function renderAdmin() {
    const pendingCount = state.requests.filter((r) => r.status === 'pending').length;
    const tabs = [
      ['approve', '✅ 승인', pendingCount],
      ['workbook', '📚 문제집 적립'],
      ['members', '👨‍👩‍👧 가족·잔액'],
      ['products', '🛒 상품 관리'],
      ['market', '🌱 주식 관리'],
      ['history', '🧾 내역'],
      ['settings', '⚙️ 설정'],
    ];
    const body = {
      approve: adminApprove, workbook: adminWorkbook, members: adminMembers,
      products: adminProducts, market: adminMarket, history: adminHistory, settings: adminSettings,
    }[ui.adminTab]();
    return `<div class="spread" style="margin-bottom:12px"><h2>엄마 화면</h2><button class="btn sm" data-action="logout">로그아웃</button></div>
      <div class="admin-tabs">${tabs.map(([id, label, n]) => `<button class="chip ${ui.adminTab === id ? 'active' : ''}" data-action="admin-tab" data-id="${id}">${label}${n ? `<span class="count">${n}</span>` : ''}</button>`).join('')}</div>
      ${body}`;
  }

  function needMembers() {
    return `<div class="card empty"><span class="big">👨‍👩‍👧‍👦</span><p>먼저 가족을 등록해 주세요.</p>
      <button class="btn primary" data-action="admin-tab" data-id="members">가족 등록하러 가기</button></div>`;
  }

  function adminApprove() {
    const pend = state.requests.filter((r) => r.status === 'pending').sort((a, b) => a.time - b.time);
    const done = state.requests.filter((r) => r.status !== 'pending').slice(-10).reverse();
    const row = (r) => {
      const m = member(r.memberId);
      const isBuy = r.type === 'purchase';
      const p = isBuy ? product(r.productId) : null;
      let warn = '';
      if (isBuy && m && m.balance - Market.reservedPieces(state, m.id, r.id) < r.price) warn = '<span class="badge red">잔액 부족</span>';
      if (isBuy && p && p.stock !== null && p.stock <= 0) warn += '<span class="badge red">품절</span>';
      if (isBuy && !p) warn += '<span class="badge red">삭제된 상품</span>';
      if (r.type === 'stock' && company(r.companyId)?.quoteVersion !== r.quoteVersion) warn += '<span class="badge gold">가격 변경 · 재요청 필요</span>';
      return `<li>
        <div><div><strong>${h(m?.name || '(삭제된 가족)')}</strong> · ${h(requestLabel(r))} ${warn}</div>
        <div class="meta">${fmtTime(r.time)} · 현재 잔액 ${fmt(m?.balance ?? 0)}피스</div></div>
        <div class="row">${deltaHtml(requestDelta(r))}
          <button class="btn sm danger" data-action="reject" data-id="${r.id}">거절</button>
          <button class="btn sm primary" data-action="approve" data-id="${r.id}" ${warn ? 'disabled' : ''}>승인</button></div>
      </li>`;
    };
    return `<div class="stack">
      <section class="card">
        <div class="section-title"><h3>승인 대기 (${pend.length})</h3></div>
        ${pend.length ? `<ul class="list">${pend.map(row).join('')}</ul>` : '<p class="muted" style="margin:0">기다리는 요청이 없어요. 🎉</p>'}
      </section>
      <section class="card">
        <div class="section-title"><h3>최근 처리한 요청</h3></div>
        ${done.length ? `<ul class="list">${done.map((r) => `<li><div><div>${h(member(r.memberId)?.name || '(삭제된 가족)')} · ${h(requestLabel(r))}</div>
          <div class="meta">${fmtTime(r.doneTime || r.time)}</div></div>
          <span class="badge ${r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : ''}">${h(requestStatus(r))}</span></li>`).join('')}</ul>`
          : '<p class="muted" style="margin:0">아직 없어요.</p>'}
      </section>
    </div>`;
  }

  function adminWorkbook() {
    if (!state.members.length) return needMembers();
    const carry = state.settings.leftover === 'carry';
    return `<div class="grid-2">
      <section class="card">
        <h3 style="margin-bottom:12px">문제집 장수 입력</h3>
        <form id="workbook-form" class="stack" style="gap:12px">
          <label class="field">누가
            <select name="member">${state.members.map((m) => `<option value="${m.id}">${h(m.name)}</option>`).join('')}</select></label>
          <label class="field">과목
            <select name="subject">${Object.entries(SUBJECTS).map(([k, s]) => `<option value="${k}">${s.label} (${s.rate}장 = 1피스)</option>`).join('')}</select></label>
          <label class="field">푼 장수
            <input type="number" name="pages" min="1" step="1" placeholder="예: 7" required></label>
          <div class="preview" id="workbook-preview">장수를 입력하면 적립될 피스를 미리 보여드려요.</div>
          <button class="btn primary">적립하기</button>
        </form>
      </section>
      <section class="card">
        <h3 style="margin-bottom:6px">남은 장수 (${carry ? '다음 입력에 이월' : '버림'})</h3>
        <p class="muted" style="margin:0 0 8px;font-size:.85rem">설정에서 이월/버림을 바꿀 수 있어요.</p>
        <ul class="list">${state.members.map((m) => `<li><span>${h(m.name)}</span>
          <span class="muted">수학 ${m.carry?.math || 0}장 · 그 외 ${m.carry?.other || 0}장</span></li>`).join('')}</ul>
        <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
        <h3 style="margin-bottom:8px">완주 보너스 바로 지급</h3>
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">한 권을 끝까지 풀고 오답까지 끝낸 것을 확인했다면 +${BONUS}피스.</p>
        <form id="bonus-form" class="form-grid">
          <label class="field">누가<select name="member">${state.members.map((m) => `<option value="${m.id}">${h(m.name)}</option>`).join('')}</select></label>
          <label class="field">문제집 이름<input name="title" placeholder="예: 수학 4-1" required></label>
          <button class="btn primary">+${BONUS} 지급</button>
        </form>
      </section>
    </div>`;
  }

  function workbookCalc(m, subject, pages) {
    const rate = SUBJECTS[subject].rate;
    const prev = state.settings.leftover === 'carry' ? (m.carry?.[subject] || 0) : 0;
    const total = prev + pages;
    return { rate, prev, total, earned: Math.floor(total / rate), left: total % rate };
  }

  function adminMembers() {
    return `<div class="stack">
      <section class="card">
        <h3 style="margin-bottom:10px">가족 추가</h3>
        <form id="member-form" class="form-grid">
          <label class="field">이름<input name="name" placeholder="예: 첫째" required maxlength="20"></label>
          <label class="field">시작 잔액(피스)<input type="number" name="balance" min="0" step="1" value="0" required></label>
          <button class="btn primary">추가</button>
        </form>
      </section>
      ${state.members.length ? `<div class="member-grid">${state.members.map((m) => `<article class="card member-card stack" style="gap:8px">
          <div class="spread"><strong>${h(m.name)}</strong><span class="badge gold">대기 ${fmt(pendingOf(m.id))}</span></div>
          <div class="bal num">${coin()} ${fmt(m.balance)}<small class="muted" style="font-size:.85rem;font-weight:500">피스</small></div>
          <div class="muted" style="font-size:.8rem">게임 ${fmt(m.balance * MINUTES_PER_PIECE)}분 · ${fmt(m.balance * WON_PER_PIECE)}원</div>
          <div class="row">
            <button class="btn sm primary" data-action="adjust" data-id="${m.id}">잔액 조정</button>
            <button class="btn sm" data-action="rename-member" data-id="${m.id}">이름 변경</button>
            <button class="btn sm danger" data-action="delete-member" data-id="${m.id}">삭제</button>
          </div>
        </article>`).join('')}</div>` : '<div class="card empty">아직 등록된 가족이 없어요.</div>'}
    </div>`;
  }

  function productFields(p = {}) {
    return `
      <label class="field">상품 이름<input name="name" value="${h(p.name || '')}" required maxlength="30"></label>
      <div class="form-grid">
        <label class="field">분류<select name="category">${CATEGORIES.map((c) => `<option value="${c.id}" ${p.category === c.id ? 'selected' : ''}>${c.emoji} ${c.label}</option>`).join('')}</select></label>
        <label class="field">가격(피스)<input type="number" name="price" min="1" step="1" value="${p.price ?? ''}" required></label>
        <label class="field">재고 (비우면 무제한)<input type="number" name="stock" min="0" step="1" value="${p.stock ?? ''}" placeholder="무제한"></label>
      </div>`;
  }

  function readProduct(fd) {
    const stockRaw = String(fd.get('stock') || '').trim();
    return {
      name: String(fd.get('name')).trim(),
      category: fd.get('category'),
      price: Math.max(1, parseInt(fd.get('price'), 10) || 1),
      stock: stockRaw === '' ? null : Math.max(0, parseInt(stockRaw, 10) || 0),
    };
  }

  function adminProducts() {
    return `<div class="stack">
      <section class="card">
        <h3 style="margin-bottom:10px">상품 추가</h3>
        <form id="product-form" class="stack" style="gap:10px">${productFields({ category: 'food' })}
          <div><button class="btn primary">상품 추가</button></div></form>
      </section>
      <section class="card">
        <div class="section-title"><h3>상품 목록 (${state.products.length})</h3><span class="muted" style="font-size:.8rem">가격·종류는 가족 회의 후 바꿔 주세요</span></div>
        ${state.products.length ? `<div class="table-wrap"><table>
          <thead><tr><th>상품</th><th>분류</th><th class="right">가격</th><th class="right">재고</th><th class="right">관리</th></tr></thead>
          <tbody>${state.products.map((p) => `<tr>
            <td><strong>${h(p.name)}</strong></td>
            <td>${cat(p.category).emoji} ${cat(p.category).label}</td>
            <td class="right num">${fmt(p.price)}피스</td>
            <td class="right num">${p.stock === null ? '무제한' : p.stock <= 0 ? '<span class="badge red">품절</span>' : `
              <span class="row" style="justify-content:flex-end;gap:4px">
                <button class="btn sm" data-action="stock" data-id="${p.id}" data-d="-1" aria-label="재고 1 줄이기">−</button>${fmt(p.stock)}
                <button class="btn sm" data-action="stock" data-id="${p.id}" data-d="1" aria-label="재고 1 늘리기">+</button></span>`}
              ${p.stock !== null && p.stock <= 0 ? `<button class="btn sm" data-action="stock" data-id="${p.id}" data-d="1">+1</button>` : ''}</td>
            <td class="right"><span class="row" style="justify-content:flex-end;gap:6px;flex-wrap:nowrap">
              <button class="btn sm" data-action="edit-product" data-id="${p.id}">수정</button>
              <button class="btn sm danger" data-action="delete-product" data-id="${p.id}">삭제</button></span></td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">상품이 없어요.</p>'}
      </section>
    </div>`;
  }

  function adminHistory() {
    const list = state.history.filter((x) => ui.historyFilter === 'all' || x.memberId === ui.historyFilter).slice().reverse();
    const earned = list.filter((x) => x.delta > 0).reduce((s, x) => s + x.delta, 0);
    const spent = list.filter((x) => x.delta < 0).reduce((s, x) => s - x.delta, 0);
    return `<section class="card">
      <div class="spread" style="margin-bottom:12px">
        <div class="chips">
          <button class="chip ${ui.historyFilter === 'all' ? 'active' : ''}" data-action="history-filter" data-id="all">전체</button>
          ${state.members.map((m) => `<button class="chip ${ui.historyFilter === m.id ? 'active' : ''}" data-action="history-filter" data-id="${m.id}">${h(m.name)}</button>`).join('')}
        </div>
        <div class="row"><span class="badge green">번 피스 +${fmt(earned)}</span><span class="badge red">쓴 피스 -${fmt(spent)}</span></div>
      </div>
      ${list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>언제</th><th>누가</th><th>내용</th><th class="right">변동</th><th class="right">잔액</th></tr></thead>
        <tbody>${list.map((x) => `<tr><td class="num" style="white-space:nowrap">${fmtTime(x.time)}</td>
          <td style="white-space:nowrap">${h(member(x.memberId)?.name || x.memberName || '(삭제됨)')}</td>
          <td>${h(x.reason)}</td><td class="right">${deltaHtml(x.delta)}</td><td class="right num">${fmt(x.balanceAfter)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted" style="margin:0">내역이 없어요.</p>'}
    </section>`;
  }

  function pushCard() {
    let inner;
    if (!server.on) {
      inner = '<p class="muted" style="margin:0;font-size:.85rem">서버 주소(onrender.com)로 열었을 때만 알림을 쓸 수 있어요.</p>';
    } else if (!push.supported) {
      inner = '<p class="muted" style="margin:0;font-size:.85rem">이 브라우저에서는 알림을 쓸 수 없어요. 아이폰은 사파리에서 공유 › <strong>홈 화면에 추가</strong>를 한 뒤, 홈 화면의 아이콘으로 열어 주세요. (iOS 16.4 이상)</p>';
    } else if (push.denied) {
      inner = '<p class="muted" style="margin:0;font-size:.85rem">알림이 차단되어 있어요. 브라우저의 사이트 설정에서 알림을 <strong>허용</strong>으로 바꾼 뒤 다시 눌러 주세요.</p>'
        + '<div><button class="btn primary" data-action="push-on">알림 다시 켜기</button></div>';
    } else if (push.subscribed) {
      inner = '<p style="margin:0"><span class="badge green">이 기기에서 알림 받는 중</span></p>'
        + '<div class="row"><button class="btn" data-action="push-test">테스트 알림 보내기</button><button class="btn danger" data-action="push-off">알림 끄기</button></div>';
    } else {
      inner = '<p class="muted" style="margin:0;font-size:.85rem">가족이 구매 요청이나 완주 신고를 하면 이 기기로 알림이 와요. 엄마 폰에서 켜 주세요.</p>'
        + '<div><button class="btn primary" data-action="push-on">🔔 이 기기에서 알림 받기</button></div>';
    }
    return `<section class="card stack" style="gap:12px"><h3>새 요청 알림</h3>${inner}</section>`;
  }

  function adminSettings() {
    const carry = state.settings.leftover === 'carry';
    return `<div class="grid-2">
      ${pushCard()}
      <section class="card stack" style="gap:12px">
        <h3>비밀번호 변경</h3>
        <form id="password-form" class="stack" style="gap:10px">
          <input type="password" name="current" placeholder="현재 비밀번호" required autocomplete="current-password">
          <input type="password" name="next" placeholder="새 비밀번호 (4자 이상)" minlength="4" required autocomplete="new-password">
          <div><button class="btn primary">변경</button></div>
        </form>
        <p class="muted" style="margin:0;font-size:.8rem">가족용 잠금 장치예요. 서버 없이 이 페이지 안에서만 확인하므로 은행 수준 보안은 아니에요.</p>
      </section>
      <section class="card stack" style="gap:12px">
        <h3>피스 양도 (가족끼리 보내기)</h3>
        <p class="muted" style="margin:0;font-size:.85rem">허용하면 가족이 엄마 승인 없이 서로 피스를 보낼 수 있어요. 모든 양도는 내역에 남고, 알림을 켰다면 엄마에게도 알림이 가요.</p>
        <div class="chips">
          <button class="chip ${state.settings.transfer !== false ? 'active' : ''}" data-action="transfer-toggle" data-id="on">허용</button>
          <button class="chip ${state.settings.transfer === false ? 'active' : ''}" data-action="transfer-toggle" data-id="off">막기</button>
        </div>
      </section>
      <section class="card stack" style="gap:12px">
        <h3>남는 장수 처리</h3>
        <p class="muted" style="margin:0;font-size:.85rem">수학 1장, 그 외 1~2장처럼 피스로 바뀌지 않고 남는 장수를 어떻게 할까요?</p>
        <div class="chips">
          <button class="chip ${carry ? 'active' : ''}" data-action="leftover" data-id="carry">다음 입력에 이월 (권장)</button>
          <button class="chip ${!carry ? 'active' : ''}" data-action="leftover" data-id="drop">버림</button>
        </div>
      </section>
      <section class="card stack" style="gap:12px">
        <h3>백업 · 다른 기기로 옮기기</h3>
        <p class="muted" style="margin:0;font-size:.85rem">데이터는 이 기기의 브라우저에만 저장돼요. 백업 파일로 저장하거나 다른 기기에서 불러올 수 있어요.</p>
        <div class="row">
          <button class="btn" data-action="export">백업 파일 저장</button>
          <label class="btn" style="display:inline-block">백업 불러오기<input type="file" id="import-file" accept="application/json,.json" hidden></label>
        </div>
      </section>
      <section class="card stack" style="gap:12px">
        <h3>전체 초기화</h3>
        <p class="muted" style="margin:0;font-size:.85rem">가족 잔액, 상품, 회사, 보유 주식과 모든 내역을 지우고 처음 상태로 돌아갑니다.</p>
        <div><button class="btn danger" data-action="reset">모두 초기화</button></div>
      </section>
    </div>`;
  }

  async function doTransfer(fromId, toId, n) {
    const from = member(fromId);
    const to = member(toId);
    if (server.on) {
      try {
        const r = await api('api/transfer', { fromId, toId, amount: n });
        if (r.ok) { adopt(r.data); toast(`${to.name}에게 ${fmt(n)}피스를 보냈어요 💌`); }
        else toast({ 'not enough': '피스가 모자라요', disabled: '지금은 양도가 막혀 있어요' }[r.data.error] || '보내지 못했어요');
      } catch {
        toast('서버에 연결할 수 없어요');
      }
    } else {
      if (state.settings.transfer === false) toast('지금은 양도가 막혀 있어요');
      else if (from.balance - pendingOf(fromId) < n) toast('피스가 모자라요');
      else {
        record(fromId, -n, `양도: ${to.name}에게 보냄`);
        record(toId, n, `양도: ${from.name}에게서 받음`);
        save();
        toast(`${to.name}에게 ${fmt(n)}피스를 보냈어요 💌`);
      }
    }
    render();
  }

  // ---------- Actions ----------
  const actions = {
    'market-buy': (id) => openTrade(id, 'buy'),
    'market-pin': (id) => openBuyPin(id),
    'market-sell': (id) => openTrade(id, 'sell'),
    'market-create': () => openCompanyCreate(),
    'market-event': (id) => openMarketEvent(id),
    'market-admin': () => { ui.adminTab = 'market'; location.hash = 'admin'; },
    'pick-member': (id) => safeSet(localStorage, MEMBER_KEY, id),
    'shop-cat': (id) => { ui.shopCat = id; },
    'admin-tab': (id) => { ui.adminTab = id; },
    'history-filter': (id) => { ui.historyFilter = id; },
    logout: () => { safeDel(sessionStorage, AUTH_KEY); safeDel(sessionStorage, TOKEN_KEY); toast('로그아웃했어요'); },
    leftover: (id) => { state.settings.leftover = id; save(); toast(id === 'carry' ? '남는 장수를 다음에 이월해요' : '남는 장수를 버려요'); },

    buy: (id) => {
      const p = product(id);
      const mid = currentMemberId();
      const me = member(mid);
      confirmModal('구매 요청', `<strong>${h(p.name)}</strong>을(를) <strong>${fmt(p.price)}피스</strong>에 살까요?<br>엄마가 승인하면 잔액에서 빠져요.`, '요청하기', () => {
        if (me.balance - pendingOf(mid) < p.price) return toast('피스가 부족해요');
        state.requests.push({ id: uid(), type: 'purchase', memberId: mid, productId: p.id, productName: p.name, price: p.price, time: Date.now(), status: 'pending' });
        save(); render(); toast('구매 요청을 보냈어요. 엄마 승인을 기다려 주세요!');
      });
      return false;
    },

    'bonus-request': () => {
      const mid = currentMemberId();
      openModal(`
        <h3>📚 문제집 완주 신고</h3>
        <p class="muted" style="margin:0;font-size:.88rem">한 권을 끝까지 풀고 오답까지 끝냈나요? 엄마가 확인하면 +${BONUS}피스!</p>
        <label class="field">문제집 이름<input name="title" placeholder="예: 국어 3-2" required maxlength="40"></label>
        <div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary">신고하기</button></div>`, (fd) => {
        state.requests.push({ id: uid(), type: 'bonus', memberId: mid, title: String(fd.get('title')).trim(), time: Date.now(), status: 'pending' });
        save(); render(); toast('완주 신고를 보냈어요!');
      });
      return false;
    },

    transfer: () => {
      const mid = currentMemberId();
      const me = member(mid);
      const others = state.members.filter((m) => m.id !== mid);
      const avail = me.balance - pendingOf(mid);
      if (!others.length) { toast('보낼 가족이 없어요'); return false; }
      if (avail < 1) { toast('보낼 수 있는 피스가 없어요'); return false; }
      openModal(`
        <h3>💌 피스 보내기</h3>
        <p class="muted" style="margin:0;font-size:.88rem">${h(me.name)}이(가) 보낼 수 있는 피스: <strong>${fmt(avail)}</strong>피스. 엄마 승인 없이 바로 전달돼요.</p>
        <div class="form-grid">
          <label class="field">받는 사람<select name="to">${others.map((m) => `<option value="${m.id}">${h(m.name)}</option>`).join('')}</select></label>
          <label class="field">보낼 피스<input type="number" name="amount" min="1" max="${avail}" step="1" inputmode="numeric" placeholder="예: 5" required></label>
        </div>
        <div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary">다음</button></div>`, (fd) => {
        const to = member(fd.get('to'));
        const n = parseInt(fd.get('amount'), 10);
        if (!to || !(n >= 1) || n > avail) { toast(`1~${fmt(avail)}피스 사이로 입력해 주세요`); return false; }
        confirmModal('정말 보낼까요?', `<strong>${h(me.name)}</strong> → <strong>${h(to.name)}</strong><br><strong>${fmt(n)}피스</strong>(${fmt(n * MINUTES_PER_PIECE)}분 · ${fmt(n * WON_PER_PIECE)}원 어치)를 바로 보내요.<br>보낸 뒤에는 <u>되돌릴 수 없어요</u>. 엄마가 내역에서 볼 수 있어요.`, '보내기', () => doTransfer(mid, to.id, n));
        return false;
      });
      return false;
    },

    'transfer-toggle': (id) => {
      state.settings.transfer = id === 'on';
      save();
      toast(id === 'on' ? '피스 양도를 허용해요' : '피스 양도를 막았어요');
    },

    'cancel-request': (id) => {
      const r = state.requests.find((x) => x.id === id);
      if (r?.type === 'stock') return marketAction('cancel', { requestId: id, memberId: currentMemberId() }, '주식 요청을 취소했어요');
      if (r) { r.status = 'cancelled'; r.doneTime = Date.now(); save(); toast('요청을 취소했어요'); }
    },

    approve: (id) => {
      const r = state.requests.find((x) => x.id === id);
      if (!r || r.status !== 'pending') return;
      if (r.type === 'stock') return marketAction('decide', { requestId: id, approve: true }, '주식 거래를 승인했어요');
      const m = member(r.memberId);
      if (!m) return toast('가족 정보가 없어요');
      if (r.type === 'purchase') {
        const p = product(r.productId);
        if (!p) return toast('삭제된 상품이에요');
        if (m.balance - Market.reservedPieces(state, m.id, r.id) < r.price) return toast('다른 요청의 예약분을 제외하면 잔액이 부족해요');
        if (p.stock !== null && p.stock <= 0) return toast('품절이라 승인할 수 없어요');
        if (p.stock !== null) p.stock -= 1;
        record(m.id, -r.price, `구매: ${r.productName}`);
      } else {
        record(m.id, BONUS, `완주 보너스: ${r.title}`);
      }
      r.status = 'approved'; r.doneTime = Date.now();
      save(); toast(`${m.name} 요청을 승인했어요`);
    },

    reject: (id) => {
      const r = state.requests.find((x) => x.id === id);
      if (!r || r.status !== 'pending') return;
      if (r.type === 'stock') return marketAction('decide', { requestId: id, approve: false }, '주식 요청을 거절했어요');
      r.status = 'rejected'; r.doneTime = Date.now();
      save(); toast('요청을 거절했어요');
    },

    adjust: (id) => {
      const m = member(id);
      openModal(`
        <h3>${h(m.name)} 잔액 조정</h3>
        <p class="muted" style="margin:0">현재 ${fmt(m.balance)}피스</p>
        <div class="form-grid">
          <label class="field">더할까요, 뺄까요?
            <select name="sign"><option value="1">＋ 더하기</option><option value="-1">－ 빼기</option></select></label>
          <label class="field">피스 수<input type="number" name="amount" min="1" step="1" inputmode="numeric" placeholder="예: 3" required></label>
        </div>
        <label class="field">사유<input name="reason" placeholder="예: 심부름 보상" required maxlength="40"></label>
        <div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary">적용</button></div>`, (fd) => {
        const d = (parseInt(fd.get('amount'), 10) || 0) * parseInt(fd.get('sign'), 10);
        if (!d) { toast('1 이상의 숫자를 입력해 주세요'); return false; }
        if (m.balance + d < pendingOf(m.id)) { toast('승인 대기 중인 피스를 남겨 두어야 해요. 먼저 요청을 처리해 주세요'); return false; }
        record(m.id, d, `직접 조정: ${String(fd.get('reason')).trim()}`);
        save(); render(); toast('잔액을 조정했어요');
      });
      return false;
    },

    'rename-member': (id) => {
      const m = member(id);
      openModal(`<h3>이름 변경</h3><label class="field">이름<input name="name" value="${h(m.name)}" required maxlength="20"></label>
        <div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary">저장</button></div>`, (fd) => {
        m.name = String(fd.get('name')).trim(); save(); render();
      });
      return false;
    },

    'delete-member': (id) => {
      const m = member(id);
      if (state.market.holdings.some((held) => held.memberId === id && held.quantity > 0) || state.requests.some((r) => r.type === 'stock' && r.memberId === id && r.status === 'pending')) { toast('보유 주식을 매도하고 대기 중인 주식 요청을 처리한 뒤 삭제해 주세요'); return false; }
      confirmModal('가족 삭제', `<strong>${h(m.name)}</strong>을(를) 삭제할까요? 잔액 ${fmt(m.balance)}피스가 사라지고 대기 중인 요청도 취소돼요. 내역은 남아요.`, '삭제', () => {
        state.history.forEach((x) => { if (x.memberId === id) x.memberName = m.name; });
        state.requests.forEach((r) => { if (r.memberId === id && r.status === 'pending') { r.status = 'cancelled'; r.doneTime = Date.now(); } });
        state.members = state.members.filter((x) => x.id !== id);
        state.market.holdings = state.market.holdings.filter((x) => x.memberId !== id);
        save(); render(); toast('삭제했어요');
      }, true);
      return false;
    },

    'edit-product': (id) => {
      const p = product(id);
      openModal(`<h3>상품 수정</h3>${productFields(p)}
        <div class="actions"><button class="btn" value="cancel" formnovalidate>취소</button><button class="btn primary">저장</button></div>`, (fd) => {
        Object.assign(p, readProduct(fd)); save(); render(); toast('상품을 수정했어요');
      });
      return false;
    },

    'delete-product': (id) => {
      const p = product(id);
      confirmModal('상품 삭제', `<strong>${h(p.name)}</strong>을(를) 삭제할까요? 이 상품의 대기 중인 구매 요청은 취소돼요.`, '삭제', () => {
        state.requests.forEach((r) => { if (r.productId === id && r.status === 'pending') { r.status = 'cancelled'; r.doneTime = Date.now(); } });
        state.products = state.products.filter((x) => x.id !== id);
        save(); render(); toast('상품을 삭제했어요');
      }, true);
      return false;
    },

    stock: (id, el) => {
      const p = product(id);
      p.stock = Math.max(0, p.stock + Number(el.dataset.d));
      save();
    },

    'push-on': async () => {
      try {
        const perm = await Notification.requestPermission();
        push.denied = perm === 'denied';
        if (perm !== 'granted') { toast('알림을 허용해 주세요'); render(); return false; }
        const reg = await navigator.serviceWorker.ready;
        const { key } = await (await fetch('api/push/key')).json();
        const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
        const r = await api('api/push/subscribe', { subscription: sub.toJSON() });
        if (!r.ok) throw new Error('subscribe');
        push.subscribed = true;
        toast('이 기기로 알림을 받아요 🔔');
      } catch {
        toast('알림을 켜지 못했어요');
      }
      render();
      return false;
    },

    'push-off': async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api('api/push/unsubscribe', { endpoint: sub.endpoint });
          await sub.unsubscribe();
        }
        push.subscribed = false;
        toast('알림을 껐어요');
      } catch {
        toast('알림을 끄지 못했어요');
      }
      render();
      return false;
    },

    'push-test': async () => {
      const r = await api('api/push/test', {});
      toast(r.ok ? '테스트 알림을 보냈어요' : '보내지 못했어요');
      return false;
    },

    export: () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `피스상점-백업-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return false;
    },

    reset: () => {
      confirmModal('전체 초기화', '정말 모든 데이터를 지울까요? 가족 잔액, 회사, 보유 주식과 모든 기록도 사라져요. 먼저 백업을 권해요.', '모두 지우기', async () => {
        const success = await replaceState(Market.ensure(defaultState()), '초기화했어요');
        if (success) { safeDel(sessionStorage, AUTH_KEY); render(); }
        return success;
      }, true);
      return false;
    },
  };

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    if (server.inflight) { toast('저장 중이에요. 잠시 후 다시 해 주세요'); return; }
    el.disabled = true;
    try { if (await fn(el.dataset.id, el) !== false) render(); }
    catch (error) { toast(error.message || '처리하지 못했어요'); }
    finally { el.disabled = false; }
  });

  // ---------- Forms ----------
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (form.closest('dialog')) return;
    e.preventDefault();
    if (server.inflight) { toast('저장 중이에요. 잠시 후 다시 해 주세요'); return; }
    const fd = new FormData(form);

    switch (form.id) {
      case 'login-form': {
        if (await checkPassword(String(fd.get('pw')))) {
          safeSet(sessionStorage, AUTH_KEY, '1');
          render(); toast('어서 오세요!');
        } else {
          toast('비밀번호가 달라요');
          form.reset();
        }
        return;
      }
      case 'member-form': {
        const name = String(fd.get('name')).trim();
        const start = Math.max(0, parseInt(fd.get('balance'), 10) || 0);
        const m = { id: uid(), name, balance: 0, carry: { math: 0, other: 0 } };
        state.members.push(m);
        record(m.id, start, '시작 잔액');
        save(); render(); toast(`${name}을(를) 추가했어요`);
        return;
      }
      case 'workbook-form': {
        const m = member(fd.get('member'));
        const subject = fd.get('subject');
        const pages = parseInt(fd.get('pages'), 10);
        if (!m || !(pages > 0)) return;
        const c = workbookCalc(m, subject, pages);
        m.carry = m.carry || { math: 0, other: 0 };
        m.carry[subject] = state.settings.leftover === 'carry' ? c.left : 0;
        const label = SUBJECTS[subject].label;
        const note = c.left ? (state.settings.leftover === 'carry' ? ` (남은 ${c.left}장 이월)` : ` (남은 ${c.left}장 버림)`) : '';
        if (c.earned > 0) {
          record(m.id, c.earned, `${label} 문제집 ${pages}장${c.prev ? ` + 이월 ${c.prev}장` : ''}${note}`);
          toast(`${m.name} +${c.earned}피스 적립!`);
        } else {
          toast(`${pages}장은 아직 1피스가 안 돼요${state.settings.leftover === 'carry' ? ' — 다음에 합산해요' : ''}`);
        }
        save(); render();
        return;
      }
      case 'bonus-form': {
        const m = member(fd.get('member'));
        record(m.id, BONUS, `완주 보너스: ${String(fd.get('title')).trim()}`);
        save(); render(); toast(`${m.name} 완주 보너스 +${BONUS}피스!`);
        return;
      }
      case 'product-form': {
        state.products.push({ id: uid(), ...readProduct(fd) });
        save(); render(); toast('상품을 추가했어요');
        return;
      }
      case 'password-form': {
        if (!(await checkPassword(String(fd.get('current'))))) { toast('현재 비밀번호가 달라요'); return; }
        if (server.on) {
          const r = await api('api/password', { current: String(fd.get('current')), next: String(fd.get('next')) });
          if (!r.ok) { toast('비밀번호를 바꾸지 못했어요'); return; }
          safeSet(sessionStorage, TOKEN_KEY, r.data.token);
        } else {
          state.settings.passwordHash = await sha256(String(fd.get('next')));
          save();
        }
        form.reset(); toast('비밀번호를 바꿨어요');
        return;
      }
    }
  });

  // 문제집 적립 미리보기
  document.addEventListener('input', (e) => {
    const form = e.target.closest('#workbook-form');
    if (!form) return;
    const fd = new FormData(form);
    const m = member(fd.get('member'));
    const pages = parseInt(fd.get('pages'), 10);
    const out = $('#workbook-preview');
    if (!m || !(pages > 0)) { out.textContent = '장수를 입력하면 적립될 피스를 미리 보여드려요.'; return; }
    const c = workbookCalc(m, fd.get('subject'), pages);
    out.innerHTML = `${pages}장${c.prev ? ` + 이월 ${c.prev}장` : ''} = ${c.total}장 → <strong>+${c.earned}피스</strong>`
      + (c.left ? ` · 남는 ${c.left}장은 ${state.settings.leftover === 'carry' ? '다음에 이월' : '버림'}` : '');
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'chart-company') { ui.chartCompanyId = e.target.value; drawPriceChart(); }
    if (e.target.closest('#workbook-form')) e.target.dispatchEvent(new Event('input', { bubbles: true }));
    if (e.target.id === 'import-file' && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = JSON.parse(reader.result);
          if (!Array.isArray(data.members) || !Array.isArray(data.products)) throw new Error('형식 오류');
          const base = defaultState();
          const next = Market.ensure({ ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } });
          Market.validate(next);
          confirmModal('백업 불러오기', '현재 가족 잔액, 회사와 보유 주식을 이 백업의 내용으로 바꿉니다. 계속할까요?', '백업 불러오기', () => replaceState(next, '백업을 불러왔어요'));
        } catch {
          toast('백업 파일을 읽을 수 없어요');
        }
      };
      reader.readAsText(e.target.files[0]);
    }
  });

  // 다른 탭에서 바뀐 데이터 반영
  window.addEventListener('storage', (e) => { if (!server.on && e.key === STORE_KEY) { state = Market.ensure(load()); render(); } });
  window.addEventListener('hashchange', render);

  async function init() {
    app.innerHTML = '<div class="card empty">불러오는 중…</div>';
    try {
      const res = await fetch('api/state', { cache: 'no-store' });
      const j = res.ok ? await res.json() : null;
      if (j && 'rev' in j) {
        server.on = true;
        if (!j.state) {
          const r = await fetch('api/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: defaultState() }) });
          Object.assign(j, await r.json());
        }
        adopt(j);
        const note = $('#footer-note');
        if (note) note.textContent = '데이터는 서버에 저장돼요. 같은 주소로 접속한 모든 기기에서 같은 잔액을 볼 수 있어요.';
        setInterval(poll, 4000);
        await pushInit();
      }
    } catch { /* 서버 없음: 이 기기 저장 모드 */ }
    ready = true;
    render();
  }
  init();
})();
