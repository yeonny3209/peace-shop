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

  let state = load();

  // ---------- 서버 공유 저장소 (api/state가 있으면 서버 모드, 없으면 이 기기 저장 모드) ----------
  const TOKEN_KEY = 'peace-shop-token';
  const server = { on: false, rev: 0, inflight: 0 };
  const token = () => safeGet(sessionStorage, TOKEN_KEY) || '';
  let chain = Promise.resolve();
  let ready = false;

  function adopt(j) {
    const base = defaultState();
    server.rev = j.rev;
    state = { ...base, ...j.state, settings: { ...base.settings, ...(j.state.settings || {}) } };
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
        else if (res.status === 409 && j) { adopt(j); toast('다른 기기에서 먼저 바뀌어 새로 불러왔어요. 다시 해 주세요'); }
        else if (res.status === 401) { safeDel(sessionStorage, TOKEN_KEY); safeDel(sessionStorage, AUTH_KEY); toast('다시 로그인해 주세요'); }
        else toast('서버에 저장하지 못했어요');
      } catch {
        toast('서버에 연결할 수 없어요');
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
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
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
    return state.requests
      .filter((r) => r.status === 'pending' && r.type === 'purchase' && r.memberId === memberId)
      .reduce((sum, r) => sum + r.price, 0);
  }

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
    form.addEventListener('submit', (e) => {
      const submitter = e.submitter;
      if (submitter && submitter.value === 'cancel') return;
      e.preventDefault();
      const ok = onSubmit(new FormData(form));
      if (ok !== false) modal.close();
    });
    modal.showModal();
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
      </div>`, () => { onConfirm(); });
  }

  // ---------- Routing ----------
  const ui = { shopCat: 'all', adminTab: 'approve', historyFilter: 'all' };
  const route = () => (location.hash.replace('#', '') === 'admin' ? 'admin' : 'shop');
  const isAuthed = () => safeGet(sessionStorage, AUTH_KEY) === '1';

  function render() {
    if (!ready) return;
    const r = route();
    document.querySelectorAll('.mainnav a').forEach((a) => a.classList.toggle('active', a.dataset.route === r));
    app.innerHTML = r === 'admin' ? (isAuthed() ? renderAdmin() : renderLogin()) : renderShop();
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
        <button class="btn" data-action="bonus-request">📚 문제집 완주 신고 (+${BONUS})</button>
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
              <div><div>${r.type === 'purchase' ? h(r.productName) : `📚 완주 신고 · ${h(r.title)}`}</div>
              <div class="meta">${fmtTime(r.time)}</div></div>
              <div class="row">${r.type === 'purchase' ? `<span class="delta minus">-${fmt(r.price)}피스</span>` : `<span class="delta plus">+${BONUS}피스</span>`}
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
      ['history', '🧾 내역'],
      ['settings', '⚙️ 설정'],
    ];
    const body = {
      approve: adminApprove, workbook: adminWorkbook, members: adminMembers,
      products: adminProducts, history: adminHistory, settings: adminSettings,
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
      if (isBuy && m && m.balance < r.price) warn = '<span class="badge red">잔액 부족</span>';
      if (isBuy && p && p.stock !== null && p.stock <= 0) warn += '<span class="badge red">품절</span>';
      if (isBuy && !p) warn += '<span class="badge red">삭제된 상품</span>';
      return `<li>
        <div><div><strong>${h(m?.name || '(삭제된 가족)')}</strong> · ${isBuy ? `${h(r.productName)} 구매` : `📚 완주 신고: ${h(r.title)}`} ${warn}</div>
        <div class="meta">${fmtTime(r.time)} · 현재 잔액 ${fmt(m?.balance ?? 0)}피스</div></div>
        <div class="row">${isBuy ? `<span class="delta minus">-${fmt(r.price)}</span>` : `<span class="delta plus">+${BONUS}</span>`}
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
        ${done.length ? `<ul class="list">${done.map((r) => `<li><div><div>${h(member(r.memberId)?.name || '(삭제된 가족)')} · ${r.type === 'purchase' ? h(r.productName) : `완주 신고: ${h(r.title)}`}</div>
          <div class="meta">${fmtTime(r.doneTime || r.time)}</div></div>
          <span class="badge ${r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : ''}">${{ approved: '승인', rejected: '거절', cancelled: '취소' }[r.status]}</span></li>`).join('')}</ul>`
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
        <p class="muted" style="margin:0;font-size:.85rem">가족, 상품, 내역, 비밀번호를 모두 지우고 처음 상태로 돌아갑니다.</p>
        <div><button class="btn danger" data-action="reset">모두 초기화</button></div>
      </section>
    </div>`;
  }

  // ---------- Actions ----------
  const actions = {
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

    'cancel-request': (id) => {
      const r = state.requests.find((x) => x.id === id);
      if (r) { r.status = 'cancelled'; r.doneTime = Date.now(); save(); toast('요청을 취소했어요'); }
    },

    approve: (id) => {
      const r = state.requests.find((x) => x.id === id);
      const m = member(r.memberId);
      if (!m) return toast('가족 정보가 없어요');
      if (r.type === 'purchase') {
        const p = product(r.productId);
        if (!p) return toast('삭제된 상품이에요');
        if (m.balance < r.price) return toast('잔액이 부족해서 승인할 수 없어요');
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
        if (m.balance + d < 0) { toast('잔액이 0보다 작아질 수 없어요'); return false; }
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
      confirmModal('가족 삭제', `<strong>${h(m.name)}</strong>을(를) 삭제할까요? 잔액 ${fmt(m.balance)}피스가 사라지고 대기 중인 요청도 취소돼요. 내역은 남아요.`, '삭제', () => {
        state.history.forEach((x) => { if (x.memberId === id) x.memberName = m.name; });
        state.requests.forEach((r) => { if (r.memberId === id && r.status === 'pending') { r.status = 'cancelled'; r.doneTime = Date.now(); } });
        state.members = state.members.filter((x) => x.id !== id);
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
      confirmModal('전체 초기화', '정말 모든 데이터를 지울까요? 되돌릴 수 없어요. 먼저 백업을 권해요.', '모두 지우기', () => {
        state = defaultState(); save(); safeDel(sessionStorage, AUTH_KEY); render(); toast('초기화했어요');
      }, true);
      return false;
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    if (fn(el.dataset.id, el) !== false) render();
  });

  // ---------- Forms ----------
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (form.closest('dialog')) return;
    e.preventDefault();
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
    if (e.target.closest('#workbook-form')) e.target.dispatchEvent(new Event('input', { bubbles: true }));
    if (e.target.id === 'import-file' && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!Array.isArray(data.members) || !Array.isArray(data.products)) throw new Error('형식 오류');
          const base = defaultState();
          state = { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } };
          save(); render(); toast('백업을 불러왔어요');
        } catch {
          toast('백업 파일을 읽을 수 없어요');
        }
      };
      reader.readAsText(e.target.files[0]);
    }
  });

  // 다른 탭에서 바뀐 데이터 반영
  window.addEventListener('storage', (e) => { if (!server.on && e.key === STORE_KEY) { state = load(); render(); } });
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
