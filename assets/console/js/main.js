// Page behaviour for the robot console: theme, boot log, section nav, media, detection boxes,
// and lazy start of the 3D robot viewport.
const root = document.documentElement;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
// OS-level reduced motion, or the visitor's "pause animations" toggle
const reduceMotion = () => motionQuery.matches || root.getAttribute('data-motion') === 'off';
const DEBUG = new URLSearchParams(window.location.search).has('debug');
const bus = new EventTarget();

function setupTheme() {
  const btn = document.querySelector('[data-theme-toggle]');
  const meta = document.querySelector('meta[name="theme-color"]');
  const sync = () => {
    const dark = root.getAttribute('data-theme') !== 'light';
    if (btn) btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    if (meta) meta.setAttribute('content', dark ? '#080b0a' : '#eef2ef');
  };
  if (btn) {
    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('hk-theme', next); } catch (e) { /* private mode */ }
      sync();
      bus.dispatchEvent(new CustomEvent('theme', { detail: next }));
    });
  }
  sync();
}

function setupMotionToggle() {
  const btn = document.querySelector('[data-motion-toggle]');
  if (!btn) return;
  const sync = () => {
    const off = root.getAttribute('data-motion') === 'off';
    btn.setAttribute('aria-pressed', String(off));
    btn.setAttribute('aria-label', off ? 'Resume animations' : 'Pause animations');
    btn.title = off ? 'Resume animations' : 'Pause animations';
  };
  btn.addEventListener('click', () => {
    const off = root.getAttribute('data-motion') !== 'off';
    if (off) root.setAttribute('data-motion', 'off'); else root.removeAttribute('data-motion');
    try { localStorage.setItem('hk-motion', off ? 'off' : 'on'); } catch (e) { /* private mode */ }
    sync();
    for (const v of document.querySelectorAll('video[data-src]')) {
      if (off) { v.pause(); continue; }
      const r = v.getBoundingClientRect();
      if (v.getAttribute('src') && r.bottom > 0 && r.top < window.innerHeight) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    }
    bus.dispatchEvent(new CustomEvent('motion', { detail: off ? 'off' : 'on' }));
  });
  sync();
}

/** Type the boot log line by line. Resolves when done (immediately under reduced motion). */
function runBoot() {
  const boot = document.querySelector('[data-boot]');
  const finish = () => root.classList.remove('boot-pending');
  if (!boot || reduceMotion() || !root.classList.contains('boot-pending')) { finish(); return Promise.resolve(); }
  const lines = [...boot.querySelectorAll('.boot-line')];
  const spans = lines.map((l) => l.querySelector('[data-type]'));
  const full = spans.map((s) => s.textContent);
  spans.forEach((s) => { s.textContent = ''; });
  return new Promise((resolve) => {
    let li = 0;
    let ci = 0;
    const tick = () => {
      if (li >= lines.length) { finish(); resolve(); return; }
      lines[li].classList.add('is-on');
      ci = Math.min(full[li].length, ci + 3);
      spans[li].textContent = full[li].slice(0, ci);
      if (ci >= full[li].length) {
        lines[li].classList.add('is-done');
        li += 1;
        ci = 0;
        setTimeout(tick, 120);
      } else {
        setTimeout(tick, 14);
      }
    };
    setTimeout(tick, 120);
  });
}

function setupNav() {
  const links = new Map([...document.querySelectorAll('.nav a[data-nav]')].map((a) => [a.dataset.nav, a]));
  const sections = [...document.querySelectorAll('main .section[id]')];
  if (!sections.length) return;
  let current = null;
  let queued = false;
  const update = () => {
    queued = false;
    // the active section is the last one whose top has passed a line 30% down the viewport
    const line = window.innerHeight * 0.3;
    let active = null;
    for (const s of sections) if (s.getBoundingClientRect().top <= line) active = s.id;
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (atEnd) active = sections[sections.length - 1].id;
    if (active === current) return;
    current = active;
    links.forEach((a, id) => a.classList.toggle('is-active', id === current));
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  update();
}

function setupMedia() {
  const videos = [...document.querySelectorAll('video[data-src]')];
  if (!videos.length) return;
  const play = (v) => { const p = v.play(); if (p && p.catch) p.catch(() => {}); };
  const load = (v) => {
    if (!v.getAttribute('src')) { v.setAttribute('src', v.dataset.src); v.preload = 'auto'; }
  };
  if (!('IntersectionObserver' in window)) { videos.forEach((v) => { load(v); if (!reduceMotion()) play(v); }); return; }
  // fetch a little ahead of the viewport, but only decode/play while actually on screen
  const loader = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { load(e.target); loader.unobserve(e.target); }
  }, { rootMargin: '400px 0px' });
  const player = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target;
      if (e.isIntersecting && e.intersectionRatio >= 0.25) { load(v); if (!reduceMotion()) play(v); }
      else if (!v.paused) v.pause();
    }
  }, { threshold: [0, 0.25] });
  videos.forEach((v) => {
    loader.observe(v);
    player.observe(v);
    const card = v.closest('.pub');
    if (!card) return;
    // with reduced motion, videos only play while hovered or focused
    card.addEventListener('pointerenter', () => { if (reduceMotion()) { load(v); play(v); } });
    card.addEventListener('pointerleave', () => { if (reduceMotion()) v.pause(); });
    card.addEventListener('focusin', () => { if (reduceMotion()) { load(v); play(v); } });
    card.addEventListener('focusout', () => { if (reduceMotion()) v.pause(); });
  });
}

function setupDetection() {
  const box = document.querySelector('[data-detect]');
  const label = box && box.querySelector('[data-detect-label]');
  const pubs = [...document.querySelectorAll('[data-pub]')];
  if (!box || !pubs.length) return;
  const wide = window.matchMedia('(min-width: 961px)');
  let active = null;
  let raf = 0;
  const pad = 6;
  const place = () => {
    if (!active) return;
    const r = active.getBoundingClientRect();
    box.style.transform = `translate(${Math.round(r.left - pad)}px, ${Math.round(r.top - pad)}px)`;
    box.style.width = `${Math.round(r.width + pad * 2)}px`;
    box.style.height = `${Math.round(r.height + pad * 2)}px`;
    raf = requestAnimationFrame(place);
  };
  const on = (el) => {
    if (!wide.matches || active === el) return;
    active = el;
    label.textContent = el.dataset.label || '';
    cancelAnimationFrame(raf);
    place();
    box.hidden = false;
    box.classList.remove('is-locking');
    void box.offsetWidth;
    box.classList.add('is-locking');
    bus.dispatchEvent(new CustomEvent('attend', { detail: { el, label: el.dataset.label } }));
  };
  const off = (el) => {
    if (active !== el) return;
    active = null;
    cancelAnimationFrame(raf);
    box.hidden = true;
    bus.dispatchEvent(new CustomEvent('release'));
  };
  for (const el of pubs) {
    el.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') on(el); });
    el.addEventListener('pointerleave', () => off(el));
    el.addEventListener('focusin', () => on(el));
    el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) off(el); });
  }
  wide.addEventListener('change', () => { if (!wide.matches && active) off(active); });
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (e) {
    return false;
  }
}

function nearViewport(el, margin = '300px') {
  if (!('IntersectionObserver' in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); resolve(); }
    }, { rootMargin: margin });
    io.observe(el);
  });
}

async function setupRobot(bootDone) {
  const bay = document.getElementById('robot');
  if (!bay) return;
  const offline = () => {
    bay.classList.add('is-offline');
    const view = bay.querySelector('[data-view]');
    if (view) { view.removeAttribute('tabindex'); view.removeAttribute('role'); view.removeAttribute('aria-label'); }
  };
  if (!webglAvailable()) { offline(); return; }
  await nearViewport(bay);
  try {
    const { RobotApp } = await import('./robot/app.js');
    const app = new RobotApp(bay, { bus, reduceMotion, debug: DEBUG });
    if (DEBUG) window.__hk = { app, bus };
    await app.start(bootDone);
  } catch (err) {
    console.error('[robot] viewport failed to start:', err);
    offline();
  }
}

setupTheme();
setupMotionToggle();
const bootDone = runBoot();
setupNav();
setupMedia();
setupDetection();
setupRobot(bootDone);
