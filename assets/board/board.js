// Pin board: theme and motion toggles, filter chips and search over the board's sections,
// the pin detail view ("closeup"), and lazy video playback.
const root = document.documentElement;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
// OS-level reduced motion, or the visitor's "pause animations" toggle
const reduceMotion = () => motionQuery.matches || root.getAttribute('data-motion') === 'off';
const bus = new EventTarget();
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const play = (v) => { const p = v.play(); if (p && p.catch) p.catch(() => {}); };
const ARROW = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 16 16 8M9.5 8H16v6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ---------- theme + motion toggles ---------- */
function setupTheme() {
  const btn = $('[data-theme-toggle]');
  const meta = $('meta[name="theme-color"]');
  const apply = (theme) => {
    root.setAttribute('data-theme', theme);
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0e100f' : '#ffffff');
    if (btn) btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  };
  apply(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem('hk-theme', next); } catch (e) { /* private mode */ }
    });
  }
  // follow the system setting until the visitor picks a theme themselves
  const sys = window.matchMedia('(prefers-color-scheme: dark)');
  const onSys = (e) => {
    let saved = null;
    try { saved = localStorage.getItem('hk-theme'); } catch (err) { /* private mode */ }
    if (saved !== 'dark' && saved !== 'light') apply(e.matches ? 'dark' : 'light');
  };
  if (sys.addEventListener) sys.addEventListener('change', onSys);
}

function setupMotionToggle() {
  const btn = $('[data-motion-toggle]');
  const sync = () => {
    if (!btn) return;
    const off = root.getAttribute('data-motion') === 'off';
    btn.setAttribute('aria-pressed', String(off));
    btn.title = off ? 'Resume animations' : 'Pause animations';
  };
  if (btn) {
    btn.addEventListener('click', () => {
      const off = root.getAttribute('data-motion') !== 'off';
      if (off) root.setAttribute('data-motion', 'off'); else root.removeAttribute('data-motion');
      try { localStorage.setItem('hk-motion', off ? 'off' : 'on'); } catch (e) { /* private mode */ }
      sync();
      bus.dispatchEvent(new Event('motion'));
    });
  }
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', () => bus.dispatchEvent(new Event('motion')));
  sync();
}

/* ---------- top bar shadow, back-to-top button ---------- */
function setupScrollUi() {
  const bar = $('[data-topbar]');
  const toTop = $('[data-to-top]');
  let queued = false;
  const update = () => {
    queued = false;
    const y = window.scrollY;
    if (bar) bar.classList.toggle('is-scrolled', y > 4);
    if (toTop) toTop.classList.toggle('is-on', y > 900);
  };
  window.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  update();
  if (toTop) {
    toTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
      const brand = $('.brand');
      if (brand) brand.focus({ preventScroll: true });
    });
  }
}

/* ---------- videos: fetch near the viewport, play only while visible ---------- */
function setupMedia() {
  // each video ships with preload="none", so nothing is fetched until it nears the viewport
  const videos = $$('.board video[data-lazy]');
  const visible = new Set();
  const hovering = new Set();
  const focused = new Set();
  const load = (v) => {
    if (v.hkLoaded) return;
    v.hkLoaded = true;
    v.preload = 'auto';
    if (v.readyState === 0) v.load();
  };
  const shouldPlay = (v) => !document.hidden && !root.classList.contains('has-modal')
    && (reduceMotion() ? (hovering.has(v) || focused.has(v)) : visible.has(v));
  const sync = (v) => {
    if (shouldPlay(v)) { load(v); play(v); } else if (!v.paused) v.pause();
  };
  const syncAll = () => videos.forEach(sync);

  for (const v of videos) {
    // with reduced motion, a video plays only while its pin is hovered or has keyboard focus
    const pin = v.closest('.pin');
    if (!pin) continue;
    pin.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') { hovering.add(v); sync(v); } });
    pin.addEventListener('pointerleave', () => { hovering.delete(v); sync(v); });
    pin.addEventListener('focusin', (e) => {
      // focus put back by script after a mouse click is not keyboard focus
      if (e.target.matches && e.target.matches(':focus-visible')) { focused.add(v); sync(v); }
    });
    pin.addEventListener('focusout', (e) => { if (!pin.contains(e.relatedTarget)) { focused.delete(v); sync(v); } });
  }

  if ('IntersectionObserver' in window) {
    const loader = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { load(e.target); loader.unobserve(e.target); }
    }, { rootMargin: '400px 0px' });
    const player = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio >= 0.25) visible.add(e.target); else visible.delete(e.target);
        sync(e.target);
      }
    }, { threshold: [0, 0.25] });
    videos.forEach((v) => { loader.observe(v); player.observe(v); });
  } else {
    videos.forEach((v) => { visible.add(v); load(v); sync(v); });
  }
  document.addEventListener('visibilitychange', syncAll);
  bus.addEventListener('motion', syncAll);
  bus.addEventListener('modal', syncAll);
}

/* ---------- board: filter chips + search ---------- */
const HASH_KIND = new Map([['about', 'all'], ['publications', 'publications'], ['experience', 'experience'], ['education', 'education'], ['service', 'service'], ['awards', 'awards']]);
// the hash without "#", tolerating malformed escapes such as "#100%"
const readHash = () => {
  const raw = location.hash.slice(1);
  try { return decodeURIComponent(raw); } catch (e) { return raw; }
};
// Safari throws once a page calls replaceState too often; the address then simply lags behind
const setUrl = (url, state = history.state) => {
  try { history.replaceState(state, '', url); } catch (e) { /* rate limited */ }
};

function setupBoard() {
  const board = $('[data-board]');
  if (!board) return null;
  const pins = $$('.pin', board);
  for (const p of pins) p.hkHay = fold(`${p.textContent} ${(p.dataset.tags || '').replace(/\|/g, ' ')}`);
  // sections (and the topic groups inside Publications) disappear when none of their pins are left
  const sections = $$('[data-sec]', board).map((el) => ({ el, kind: el.dataset.sec, n: $('[data-sec-n]', el), pins: $$('.pin', el) }));
  const groups = $$('[data-group]', board).map((el) => ({ el, n: $('[data-group-n]', el), pins: $$('.pin', el) }));
  const rows = $$('[data-sec-row]', board);
  const about = sections.find((x) => x.kind === 'about');
  const chips = $$('[data-filter]');
  const counts = new Map($$('[data-count]').map((el) => [el.dataset.count, el]));
  const empty = $('[data-empty]');
  const legend = $('[data-legend]');
  const status = $('[data-board-status]');
  const form = $('[data-search-form]');
  const input = $('[data-search]');
  const clear = $('[data-search-clear]');
  const sentinel = $('[data-chips-sentinel]');
  const bar = $('[data-chips-bar]');
  const topbar = $('[data-topbar]');
  const kinds = new Set(chips.map((c) => c.dataset.filter));
  const state = { kind: 'all', q: '', tokens: [] };

  // a short entrance for the first screenful of pins
  if (!reduceMotion()) {
    const card = about && $('.about-card', about.el);
    [card, ...pins].filter(Boolean).forEach((p, i) => p.style.setProperty('--d', `${Math.min(i, 12) * 45}ms`));
    board.classList.add('is-intro');
    setTimeout(() => board.classList.remove('is-intro'), 1400);
  }
  let ready = false;

  const topbarH = () => (topbar ? topbar.offsetHeight : 0);
  const kindHash = () => (state.kind === 'all' ? '' : `#${state.kind}`);
  // the address without its hash, with ?q= kept in step with the search box
  const baseUrl = () => {
    const params = new URLSearchParams(location.search);
    const q = state.q.trim();
    if (q) params.set('q', q); else params.delete('q');
    const qs = params.toString();
    return `${location.pathname}${qs ? `?${qs}` : ''}`;
  };
  let urlTimer = 0;
  const syncUrl = (delay = 0) => {
    clearTimeout(urlTimer);
    // while a pin is open the address belongs to it (#pin-<id>)
    const write = () => { if (!root.classList.contains('has-modal')) setUrl(`${baseUrl()}${kindHash()}`); };
    if (delay) urlTimer = setTimeout(write, delay); else write();
  };
  const emptyMsg = $('[data-empty-msg]');
  const reset = $('[data-empty-reset]');
  const chipName = (k) => {
    const c = chips.find((x) => x.dataset.filter === k);
    return c && c.firstChild ? c.firstChild.textContent.trim() : k;
  };

  function apply({ animate = true } = {}) {
    const motion = animate && !reduceMotion() && ready;
    const entering = [];
    const perKind = new Map();
    let shown = 0;
    let total = 0;
    for (const p of pins) {
      const hit = state.tokens.every((t) => p.hkHay.includes(t));
      if (hit) { total += 1; perKind.set(p.dataset.kind, (perKind.get(p.dataset.kind) || 0) + 1); }
      const show = hit && (state.kind === 'all' || p.dataset.kind === state.kind);
      if (show) shown += 1;
      if (show && p.hidden) {
        p.hidden = false;
        if (motion) { p.classList.add('is-entering'); entering.push(p); }
      } else if (!show && !p.hidden) {
        p.hidden = true;
      }
    }
    const count = (list) => list.reduce((n, p) => n + (p.hidden ? 0 : 1), 0);
    for (const g of groups) {
      const n = count(g.pins);
      g.el.hidden = n === 0;
      if (g.n) g.n.textContent = String(n);
    }
    for (const sec of sections) {
      // the About text is not a pin: it shows on the plain "All" board only
      const show = sec === about ? state.kind === 'all' && state.tokens.length === 0 : count(sec.pins) > 0;
      if (show && sec.el.hidden && sec === about && motion) { sec.el.classList.add('is-entering'); entering.push(sec.el); }
      sec.el.hidden = !show;
      if (sec.n) sec.n.textContent = String(count(sec.pins));
    }
    for (const r of rows) r.hidden = !$$(':scope > [data-sec]', r).some((x) => !x.hidden);
    if (entering.length) {
      requestAnimationFrame(() => requestAnimationFrame(() => entering.forEach((p) => p.classList.remove('is-entering'))));
    }
    for (const c of chips) {
      const k = c.dataset.filter;
      const n = k === 'all' ? total : (perKind.get(k) || 0);
      const el = counts.get(k);
      if (el) el.textContent = String(n);
      c.setAttribute('aria-current', String(k === state.kind));
      c.classList.toggle('is-empty', n === 0);
    }
    if (legend) legend.hidden = !pins.some((p) => !p.hidden && p.querySelector('.pin-authors sup'));
    if (empty) {
      empty.hidden = shown > 0;
      const q = state.q.trim();
      // say whether the chip or the query is what leaves the board empty
      const elsewhere = total > 0 && state.kind !== 'all';
      if (emptyMsg) {
        emptyMsg.textContent = elsewhere ? `No ${chipName(state.kind)} pins match “${q}”.` : `No pins match “${q}”.`;
      }
      if (reset) {
        reset.textContent = elsewhere ? 'Search all pins' : 'Clear search';
        reset.dataset.mode = elsewhere ? 'kind' : 'all';
      }
    }
    if (status) status.textContent = (state.tokens.length || state.kind !== 'all') ? `${shown} ${shown === 1 ? 'pin' : 'pins'} shown` : '';
  }

  // where the page should sit so the chip bar rests right under the top bar
  const anchorY = () => (sentinel ? Math.max(0, Math.round(sentinel.getBoundingClientRect().bottom + window.scrollY - topbarH())) : 0);
  function reveal({ force = false, instant = false } = {}) {
    const y = anchorY();
    const boardTop = board.getBoundingClientRect().top;
    if (force || window.scrollY > y + 1 || boardTop > window.innerHeight * 0.72) {
      window.scrollTo({ top: y, behavior: instant || reduceMotion() ? 'auto' : 'smooth' });
    }
  }

  function setKind(kind, { scroll = true, updateUrl = true } = {}) {
    state.kind = kinds.has(kind) ? kind : 'all';
    if (updateUrl) syncUrl();
    apply();
    if (scroll) reveal();
  }

  let searching = false;
  function setQuery(q, { scroll = true } = {}) {
    state.q = q;
    state.tokens = fold(q).split(/[\s,]+/).filter(Boolean);
    if (form) form.classList.toggle('has-q', q.length > 0);
    if (clear) clear.hidden = q.length === 0;
    apply();
    syncUrl(300);
    if (scroll && state.tokens.length && !searching) reveal();
    searching = state.tokens.length > 0;
  }

  for (const c of chips) {
    c.addEventListener('click', (e) => { e.preventDefault(); setKind(c.dataset.filter); });
  }
  if (input) {
    // the long placeholder does not fit the phone-width search field
    const narrow = window.matchMedia('(max-width: 640px)');
    const full = input.placeholder;
    const fitPlaceholder = () => { input.placeholder = narrow.matches ? (input.dataset.placeholderShort || full) : full; };
    fitPlaceholder();
    if (narrow.addEventListener) narrow.addEventListener('change', fitPlaceholder);
    input.addEventListener('input', () => setQuery(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (input.value) { e.preventDefault(); input.value = ''; setQuery(''); } else input.blur();
    });
  }
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); reveal({ force: true }); if (input) input.blur(); });
  if (clear) clear.addEventListener('click', () => { if (input) { input.value = ''; input.focus(); } setQuery(''); });
  if (reset) {
    reset.addEventListener('click', () => {
      if (reset.dataset.mode === 'kind') { setKind('all'); return; }
      if (input) input.value = '';
      state.kind = 'all';
      setQuery('');
      syncUrl();
    });
  }
  // "/" focuses the search field
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || !input) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    if (root.classList.contains('has-modal')) return;
    e.preventDefault();
    input.focus();
    input.select();
  });

  if (sentinel && bar && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(([e]) => {
      bar.classList.toggle('is-stuck', !e.isIntersecting && e.boundingClientRect.top < topbarH() + 2);
    }, { rootMargin: `-${topbarH() + 1}px 0px 0px 0px` });
    io.observe(sentinel);
  }

  // initial state from the address: #publications etc. pick a chip, ?q= fills the search
  const q0 = new URLSearchParams(location.search).get('q') || '';
  if (input && q0) input.value = q0;
  const h0 = readHash();
  if (HASH_KIND.has(h0)) state.kind = HASH_KIND.get(h0);
  state.q = q0;
  state.tokens = fold(q0).split(/[\s,]+/).filter(Boolean);
  searching = state.tokens.length > 0;
  if (form) form.classList.toggle('has-q', q0.length > 0);
  if (clear) clear.hidden = q0.length === 0;
  apply({ animate: false });
  if (h0 === 'about') setUrl(baseUrl());
  // These ids only serve visitors without scripts. Without them, Back/Forward to #publications or
  // #pin-<id> cannot make the browser jump to an anchor or drop the focus this script restores.
  sections.forEach((x) => { if (HASH_KIND.has(x.el.id)) x.el.removeAttribute('id'); });
  pins.forEach((p) => { if (p.id.startsWith('pin-')) p.removeAttribute('id'); });
  requestAnimationFrame(() => requestAnimationFrame(() => { board.classList.add('is-animated'); ready = true; }));
  if ((HASH_KIND.has(h0) && h0 !== 'about') || q0) {
    // the browser may jump to the matching anchor on its own; settle on the board top afterwards
    const settle = () => reveal({ force: true, instant: true });
    requestAnimationFrame(settle);
    window.addEventListener('load', () => requestAnimationFrame(settle), { once: true });
  }

  return {
    kind: () => state.kind,
    // the board's own address (search and chip), used when a pin view closes
    url: () => `${baseUrl()}${kindHash()}`,
    setKind,
    search(q) {
      if (input) input.value = q;
      state.kind = 'all';
      searching = false;
      setQuery(q);
      syncUrl();
      // the pin that had keyboard focus may now be filtered out
      const a = document.activeElement;
      const lost = !a || a === document.body || (a.closest && a.closest('[hidden]'));
      if (input && lost && window.matchMedia('(hover: hover)').matches) input.focus({ preventScroll: true });
    },
    // ids of the paper pins currently on the board, in board order
    visiblePapers: () => pins.filter((p) => !p.hidden && p.dataset.kind === 'publications').map((p) => p.dataset.id),
    // every paper pin in board order, which follows the topic headings
    papers: () => pins.filter((p) => p.dataset.kind === 'publications').map((p) => p.dataset.id),
  };
}

/* ---------- closeup: the detail view of one paper ---------- */
function setupCloseup(board) {
  const dlg = $('[data-closeup]');
  const dataEl = $('#pins-data');
  if (!dlg || !dataEl || typeof dlg.showModal !== 'function') return null;
  let data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return null; }
  const base = data.base || '';
  const url = (p) => (p && p.charAt(0) === '/' ? base + p : p);
  const pubs = data.pubs || [];
  // board order (papers grouped under their topic), then any paper the board does not show
  const shown = board ? board.papers().filter((id) => pubs.some((p) => p.id === id)) : [];
  const seqAll = [...shown, ...pubs.map((p) => p.id).filter((id) => !shown.includes(id))];
  const byId = new Map(pubs.map((p) => [p.id, { ...p, index: seqAll.indexOf(p.id) }]));
  const q = (name) => $(`[data-cu-${name}]`, dlg);
  const el = {
    frame: q('frame'), slot: q('slot'), kicker: q('kicker'), title: q('title'), venue: q('venue'), note: q('note'),
    authors: q('authors'), eq: q('eq'), links: q('links'), tags: q('tags'), more: q('more'),
    prev: q('prev'), next: q('next'), close: q('close'), copy: q('copy'),
  };
  const moreSection = $('.cu-more', dlg);
  const toastEl = $('[data-toast]', dlg);
  let current = null; // id of the paper on show
  let pushed = false; // this view added a history entry, so closing steps back past it
  let backPending = false; // history.back() was called and its popstate has not arrived yet
  let backTimer = 0;
  let closing = false; // dlg.close() was called by this script
  let lastFocus = null;
  let firstId = null; // the paper the view was opened on, before any arrow-key steps
  let afterClose = null;
  let toastTimer = 0;
  let downOnBackdrop = false;
  el.title.tabIndex = -1;

  const ratio = (m) => {
    const w = Number(m && m.width) || 16;
    const h = Number(m && m.height) || 9;
    return Math.min(2.4, Math.max(0.8, w / h)).toFixed(4);
  };
  const isEq = (a) => /\*$/.test(a);

  function related(pub) {
    const mine = new Set(pub.tags || []);
    return pubs
      .filter((p) => p.id !== pub.id)
      .map((p, i) => ({ p, score: (p.tags || []).filter((t) => mine.has(t)).length, dist: Math.abs(byId.get(p.id).index - pub.index), i }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.dist - b.dist || a.i - b.i)
      .slice(0, 4)
      .map((r) => r.p);
  }

  function moreCard(p) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'more-card';
    const m = p.media || {};
    const video = m.type === 'video';
    const src = url(video ? m.poster : m.src);
    b.innerHTML = `<span class="more-thumb${video ? ' is-video' : ''}" style="--ar: ${ratio(m)}"><img src="${esc(src)}" alt="" loading="lazy" decoding="async"></span>`
      + `<span class="more-name">${esc(p.short || p.title)}</span><span class="more-venue">${esc(p.venue || '')}</span>`;
    b.title = p.title;
    b.addEventListener('click', () => open(p.id));
    return b;
  }

  function render(pub) {
    current = pub.id;
    const m = pub.media || {};
    const video = m.type === 'video';
    el.frame.classList.toggle('is-video', video);
    el.frame.classList.toggle('is-image', !video);
    el.frame.style.setProperty('--ar', String((Number(m.width) || 16) / (Number(m.height) || 9)));
    // the poster stays behind the video, so it never flashes black before its first frame
    el.frame.style.setProperty('--poster', video && m.poster ? `url("${url(m.poster)}")` : 'none');
    const old = $('video', el.slot);
    if (old) { old.pause(); old.removeAttribute('src'); old.load(); }
    el.slot.replaceChildren();
    if (video) {
      const v = document.createElement('video');
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.preload = 'auto';
      if (m.width) v.width = m.width;
      if (m.height) v.height = m.height;
      v.poster = url(m.poster);
      v.src = url(m.src);
      v.setAttribute('aria-label', m.alt || pub.title);
      // native controls keep the loop pausable from the keyboard
      v.controls = true;
      v.setAttribute('controlslist', 'nodownload noplaybackrate');
      v.disablePictureInPicture = true;
      el.slot.append(v);
      if (!reduceMotion()) play(v);
    } else {
      const img = document.createElement('img');
      img.src = url(m.src);
      img.alt = m.alt || '';
      img.decoding = 'async';
      if (m.width) img.width = m.width;
      if (m.height) img.height = m.height;
      el.slot.append(img);
    }
    // restart the detection-frame lock-on
    const det = $('.det', el.frame);
    if (det) det.replaceWith(det.cloneNode(true));

    el.kicker.textContent = `pub_${pad2(pub.index + 1)} · ${pub.short || ''}`;
    el.title.textContent = pub.title;
    el.venue.textContent = pub.venue || '';
    el.note.textContent = pub.note || '';
    el.note.className = `cu-note${pub.note_kind ? ` is-${pub.note_kind}` : ''}`;
    const authors = pub.authors || [];
    el.authors.innerHTML = authors.map((a) => {
      const name = a.replace(/\*$/, '');
      return (name === data.me ? `<strong class="me">${esc(name)}</strong>` : esc(name)) + (isEq(a) ? '<sup>*</sup>' : '');
    }).join(', ');
    el.eq.hidden = !authors.some(isEq);

    const links = pub.links || [];
    const primary = (links.find((l) => l.label === 'Paper') || links[0] || {}).label;
    el.links.replaceChildren(...links.map((l) => {
      const a = document.createElement('a');
      a.className = `pill${l.label === primary ? ' is-primary' : ''}`;
      a.href = l.url;
      a.rel = 'noopener';
      a.innerHTML = `${esc(l.label)}${ARROW}`;
      return a;
    }));

    el.tags.replaceChildren(...(pub.tags || []).map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tag-btn';
      b.textContent = t;
      b.title = `Show every pin about ${t}`;
      b.addEventListener('click', () => close(() => board && board.search(t)));
      return b;
    }));

    const more = related(pub);
    el.more.replaceChildren(...more.map(moreCard));
    moreSection.hidden = more.length === 0;

    const seq = order();
    el.prev.hidden = seq.length < 2;
    el.next.hidden = seq.length < 2;
    dlg.scrollTop = 0;
    // focus sat on a node that was just replaced (a link, a tag, a related card): park it on the title
    const a = document.activeElement;
    if (dlg.open && (!a || a === document.body || !dlg.contains(a))) el.title.focus({ preventScroll: true });
  }

  // prev/next walk the papers currently on the board (or all papers if this one is filtered out)
  function order() {
    const vis = board ? board.visiblePapers() : [];
    return vis.includes(current) ? vis : seqAll;
  }
  function step(d) {
    const seq = order();
    if (seq.length < 2) return;
    const i = seq.indexOf(current);
    open(seq[(i + d + seq.length) % seq.length]);
  }

  const pinUrl = (id) => `${location.pathname}${location.search}#pin-${id}`;
  const boardUrl = () => (board ? board.url() : `${location.pathname}${location.search}`);

  // push: add a history entry (a click on the board); fromHistory: Back/Forward landed on #pin-<id>
  function open(id, { push = true, fromHistory = false } = {}) {
    const pub = byId.get(id);
    if (!pub) return false;
    clearTimeout(backTimer);
    backPending = false;
    // popstate and hashchange both report the same move; render once
    if (dlg.open && current === id) return true;
    if (!dlg.open) {
      render(pub);
      lastFocus = document.activeElement;
      firstId = id;
      dlg.showModal();
      root.classList.add('has-modal');
      bus.dispatchEvent(new Event('modal'));
      if (fromHistory) {
        // an entry this view pushed earlier (reached with Forward) is stepped back over again on close
        pushed = !!(history.state && history.state.hkPin);
      } else {
        pushed = push;
        if (push) history.pushState({ hkPin: id }, '', pinUrl(id));
      }
    } else {
      render(pub);
      setUrl(pinUrl(id), pushed ? { hkPin: id } : history.state);
    }
    return true;
  }

  // tidy up after the dialog has closed, whoever closed it
  function cleanup() {
    clearTimeout(backTimer);
    backPending = false;
    if (current === null) return;
    const v = $('video', el.slot);
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    el.slot.replaceChildren();
    root.classList.remove('has-modal');
    const id = current;
    current = null;
    pushed = false;
    bus.dispatchEvent(new Event('modal'));
    const link = $(`.pin-open[data-open="${CSS.escape(id)}"]`);
    const target = link && !link.closest('[hidden]') ? link : lastFocus;
    if (target && target.focus) {
      target.focus({ preventScroll: true });
      // The arrow keys may have walked to a pin away from where the view was opened: bring it fully into
      // view. The pin it was opened on only moves if it is now off screen, so a plain close keeps the
      // scroll position. Wait two frames: after Back, the browser restores the old scroll position once
      // the popstate handlers have run.
      const pin = target.closest && target.closest('.pin');
      const walked = id !== firstId;
      if (pin) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const r = pin.getBoundingClientRect();
          const covered = parseFloat(getComputedStyle(root).scrollPaddingTop) || 0; // top bar + chip bar
          const offscreen = r.bottom < 0 || r.top > window.innerHeight;
          const partly = r.top < covered || r.bottom > window.innerHeight;
          if (offscreen || (walked && partly)) pin.scrollIntoView({ block: 'nearest' });
        }));
      }
    }
    const fn = afterClose;
    afterClose = null;
    if (fn) fn();
  }

  function finish() {
    if (dlg.open) { closing = true; dlg.close(); }
    cleanup();
  }

  function close(after) {
    if (after) afterClose = after;
    if (!dlg.open) { cleanup(); return; }
    if (backPending) return;
    if (pushed) {
      // step back past the entry this view added; the popstate handler finishes the close
      backPending = true;
      history.back();
      backTimer = setTimeout(() => { if (backPending && dlg.open) finish(); }, 450);
    } else {
      setUrl(boardUrl());
      finish();
    }
  }

  dlg.addEventListener('close', () => {
    if (closing) { closing = false; return; }
    // closed by the browser itself (for example an Escape it did not let the page intercept)
    const wasPushed = pushed;
    const pending = backPending;
    cleanup();
    if (pending) return;
    if (wasPushed) history.back();
    else setUrl(boardUrl());
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  // close on a click on the backdrop, but not when a text selection drag merely ends there
  dlg.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dlg; });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && downOnBackdrop) close();
    downOnBackdrop = false;
  });
  // arrow keys step through papers wherever focus sits while the view is open
  document.addEventListener('keydown', (e) => {
    if (!dlg.open || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.tagName === 'VIDEO' || (t.closest && t.closest('input, textarea, select')))) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
  window.addEventListener('load', () => {
    // a deep link opens the view before the page finishes loading; make sure focus ended up inside it
    if (dlg.open && !dlg.contains(document.activeElement)) el.close.focus({ preventScroll: true });
  });
  el.close.addEventListener('click', () => close());
  el.prev.addEventListener('click', () => step(-1));
  el.next.addEventListener('click', () => step(1));

  const toast = (msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 1800);
  };
  el.copy.addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}#pin-${current}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      dlg.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      el.copy.focus({ preventScroll: true });
      // the address bar already holds this pin's link
      toast(ok ? 'Link copied' : 'Copy the link from the address bar');
    }
  });

  // open a pin from the board; modified clicks keep their usual new-tab behaviour
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('.pin-open[data-open]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (byId.has(a.dataset.open)) { e.preventDefault(); open(a.dataset.open); }
  });

  return {
    has: (id) => byId.has(id),
    isOpen: () => dlg.open,
    open,
    finish,
  };
}

/* ---------- address bar routing: #pin-<id> opens a pin, #publications etc. pick a chip ---------- */
function setupRouting(board, closeup) {
  const route = () => {
    const h = readHash();
    if (closeup && h.startsWith('pin-') && closeup.has(h.slice(4))) {
      closeup.open(h.slice(4), { fromHistory: true });
      return;
    }
    const wasOpen = closeup ? closeup.isOpen() : false;
    if (closeup) closeup.finish();
    const kind = h === '' ? 'all' : HASH_KIND.get(h);
    if (board && kind && kind !== board.kind()) board.setKind(kind, { updateUrl: false, scroll: !wasOpen });
  };
  window.addEventListener('popstate', route);
  window.addEventListener('hashchange', route);
  // a shared link straight to one paper; closing it rewrites this entry rather than stepping back
  const h0 = readHash();
  if (closeup && h0.startsWith('pin-') && closeup.has(h0.slice(4))) closeup.open(h0.slice(4), { push: false });
}

setupTheme();
setupMotionToggle();
setupScrollUi();
setupMedia();
const board = setupBoard();
const closeup = setupCloseup(board);
setupRouting(board, closeup);
