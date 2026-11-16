// Two small robots wander along the bottom of the window: a robot dog and a humanoid. They are
// decoration only: hidden from assistive technology, and only their drawn parts take the pointer,
// so clicks pass through the rest of their boxes. Each walks with a gait driven by two-link inverse
// kinematics, stops to look around, turns to watch a mouse pointer that comes near, hops when
// clicked, greets the other robot now and then, and naps once the page has been left alone for a
// while. With "pause animations" on, or when the visitor prefers reduced motion, both rest asleep
// in the bottom-left corner instead. Remove a name from ROBOTS to leave that robot out.
const ROBOTS = ['dog', 'humanoid'];

const root = document.documentElement;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const still = () => motionQuery.matches || root.getAttribute('data-motion') === 'off';
const NS = 'http://www.w3.org/2000/svg';
const RAD = Math.PI / 180;
const NAP_AFTER = 45000; // ms without scrolling, typing, touching or moving the pointer
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// frame-rate independent move of `cur` toward `target`
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const fmt = (n) => String(Math.round(n * 100) / 100);

function svgEl(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}
const setLine = (l, x1, y1, x2, y2) => {
  l.setAttribute('x1', fmt(x1)); l.setAttribute('y1', fmt(y1));
  l.setAttribute('x2', fmt(x2)); l.setAttribute('y2', fmt(y2));
};
const setDot = (c, x, y) => { c.setAttribute('cx', fmt(x)); c.setAttribute('cy', fmt(y)); };

// Two-link inverse kinematics from (hx, hy) toward (tx, ty), clamped to what the limb can reach.
// bend = 1 puts the middle joint behind the line to the target (a robot dog's knee), -1 in front of it.
function ik(hx, hy, tx, ty, l1, l2, bend) {
  let dx = tx - hx;
  let dy = ty - hy;
  const d0 = Math.hypot(dx, dy) || 0.001;
  const d = clamp(d0, Math.abs(l1 - l2) + 0.6, l1 + l2 - 0.6);
  dx *= d / d0;
  dy *= d / d0;
  const a = Math.atan2(dy, dx);
  const b = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  return { jx: hx + l1 * Math.cos(a + bend * b), jy: hy + l1 * Math.sin(a + bend * b), ex: hx + dx, ey: hy + dy };
}

// A foot's place at gait phase p: in stance (first half) it slides back at exactly the walking speed,
// so it stays planted on the ground; in swing it lifts and moves forward.
function stepFoot(p, nx, L, lift) {
  if (p < 0.5) return [nx + L / 2 - L * (p / 0.5), 0];
  const u = (p - 0.5) / 0.5;
  return [nx - L / 2 + (L * (1 - Math.cos(Math.PI * u))) / 2, -lift * Math.sin(Math.PI * u)];
}

/* ---------- what both robots share: pointer, activity, wandering ---------- */
const world = { agents: [], ptr: { x: null, y: null }, lastActive: performance.now(), asleep: false, layer: null, toTop: null };

// The parts every robot has: an SVG drawn in rig units (x forward, y down, ground at y = 0), a
// detection box, sleep z's, and the wandering state.
function makeAgent(kind, view, label, conf) {
  const wrap = document.createElement('div');
  wrap.className = `bot bot-${kind}`;
  const flip = document.createElement('div');
  flip.className = 'bot-flip';
  const svg = svgEl('svg', { viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`, focusable: 'false' });
  flip.append(svg);
  const shadow = svgEl('ellipse', { class: 'bot-shadow', cx: 0, cy: 0.6, rx: 10, ry: 3.2 }, svg);
  const hit = svgEl('g', { class: 'bot-hit' }, svg);
  // the detection box stays outside the mirrored part, so its label never reads backwards
  const det = document.createElement('span');
  det.className = 'det';
  det.innerHTML = `<i></i><i></i><i></i><i></i><b>${label} ${conf.toFixed(2)}</b>`;
  const zs = document.createElement('span');
  zs.className = 'bot-z';
  zs.innerHTML = '<i>z</i><i>z</i><i>z</i>';
  wrap.append(flip, det, zs);
  world.layer.append(wrap);

  const A = {
    kind, view, wrap, flip, shadow, hit,
    size: { w: 0, h: 0, gap: 0 },
    x: 0, dir: 1, v: 0, target: 0, gait: null, gaits: {},
    mode: 'wait', until: 0, t: 0, phase: 0, hopT: 0, lookAway: 0, clicks: 0,
    headGoal: 0, headNext: 0, blinkAt: rand(1.5, 4),
  };
  A.measure = () => {
    A.size.w = wrap.offsetWidth;
    A.size.h = wrap.offsetHeight;
    A.size.gap = parseFloat(getComputedStyle(wrap).bottom) || 0;
  };
  A.cx = () => A.x + A.size.w / 2;
  A.bounds = () => {
    const minX = 6;
    const reserve = world.toTop && world.toTop.classList.contains('is-on') ? 72 : 0; // keep clear of the back-to-top button
    return { minX, maxX: Math.max(minX, window.innerWidth - A.size.w - 6 - reserve) };
  };
  A.other = (k) => world.agents.find((o) => o !== A && o.kind === k);
  A.setMode = (mode, dur = 0) => {
    A.mode = mode;
    A.until = A.t + dur;
    if (mode === 'hop') A.hopT = 0;
    if (mode === 'look') A.lookAway = A.t;
    wrap.classList.toggle('is-sleep', mode === 'nap' || mode === 'sleep');
  };
  A.walkTo = (x, gait) => {
    const { minX, maxX } = A.bounds();
    A.target = clamp(x, minX, maxX);
    A.gait = A.gaits[gait];
    A.dir = A.target >= A.x ? 1 : -1;
    A.setMode(gait === 'zoom' ? 'zoom' : 'walk');
  };
  // a random spot at a distance in [near, far], away from where the other robot is or is heading
  A.pickTarget = (near, far) => {
    const { minX, maxX } = A.bounds();
    const others = world.agents.filter((o) => o !== A);
    for (let i = 0; i < 12; i += 1) {
      const t = rand(minX, maxX);
      const d = Math.abs(t - A.x);
      const crowded = others.some((o) => Math.abs((o.mode === 'walk' || o.mode === 'zoom' ? o.target : o.x) - t) < 70);
      if (d >= near && d <= far && !crowded) return t;
    }
    return clamp(A.x + (Math.random() < 0.5 ? -near : near), minX, maxX);
  };
  A.wide = () => { const { minX, maxX } = A.bounds(); return maxX - minX > 520; };
  // move toward the target; true once there
  A.travel = (dt) => {
    const g = A.gait;
    const dist = Math.abs(A.target - A.x);
    A.v = Math.min(g.vmax, A.v + g.accel * dt, Math.sqrt(2 * g.accel * dist));
    A.x += A.dir * Math.min(dist, A.v * dt);
    if (dist >= 0.5) return false;
    A.x = A.target;
    A.v = 0;
    return true;
  };
  A.isNear = () => {
    const p = world.ptr;
    return p.x !== null && Math.abs(p.x - A.cx()) < 150 && p.y > window.innerHeight - 220;
  };
  // head angle that turns the face toward the mouse pointer (negative looks up); hx, hy in rig units
  A.lookAngle = (hx, hy) => {
    const p = world.ptr;
    const u = A.size.h / view.h;
    const originX = A.x + (A.dir > 0 ? -view.x : view.w + view.x) * u;
    const groundY = window.innerHeight - A.size.gap - (view.y + view.h) * u;
    const deg = Math.atan2(p.y - (groundY - hy * u), Math.max(8, Math.abs(p.x - (originX + A.dir * hx * u)))) / RAD;
    return clamp(deg, -38, 22);
  };
  A.idleHead = (lo, hi) => {
    if (A.t > A.headNext) { A.headGoal = rand(lo, hi); A.headNext = A.t + rand(0.7, 1.8); }
    return A.headGoal;
  };
  A.maybeNap = (near) => {
    if (near || ['nap', 'hop', 'wait', 'sleep'].includes(A.mode)) return;
    if (performance.now() - world.lastActive > NAP_AFTER) A.setMode('nap');
  };
  A.blink = () => {
    if (A.t < A.blinkAt || A.mode === 'nap' || A.mode === 'sleep') return;
    wrap.classList.add('is-blink');
    setTimeout(() => wrap.classList.remove('is-blink'), 130);
    A.blinkAt = A.t + rand(2.4, 6);
  };
  A.place = (lift) => {
    A.shadow.setAttribute('opacity', fmt(1 - lift / 40));
    wrap.style.transform = `translate3d(${fmt(A.x)}px, 0, 0)`;
    flip.style.transform = `scaleX(${A.dir})`;
    wrap.classList.toggle('is-left', A.dir < 0);
  };

  // hovering shows the detection box; a click makes it hop, and the detector grows more certain
  const labelEl = det.querySelector('b');
  hit.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') wrap.classList.add('is-hover'); });
  hit.addEventListener('pointerleave', () => wrap.classList.remove('is-hover'));
  hit.addEventListener('click', () => {
    if (A.mode === 'sleep') return;
    wakeAll();
    A.clicks += 1;
    labelEl.textContent = `${label} ${Math.min(1, conf + 0.01 * A.clicks).toFixed(2)}`;
    A.setMode('hop');
  });
  return A;
}

/* ---------- robot dog: trotting quadruped, knees bent toward the tail ---------- */
function createDog() {
  const view = { x: -52, y: -70, w: 112, h: 76 };
  const A = makeAgent('dog', view, 'robot_dog', 0.97);
  const HIP = { front: 23, rear: -23, y: 6 }; // hip joints relative to the body centre
  const THIGH = 18;
  const CALF = 19;
  const FAR = 3; // far-side legs sit a little forward so they peek out from behind the near ones
  // body height and pitch per pose, and where the feet rest relative to their hip
  const POSES = {
    stand: { bodyY: 35, pitch: 0, front: 2, rear: -1 },
    sit: { bodyY: 27, pitch: -26, front: 4, rear: 10 },
    lie: { bodyY: 13, pitch: 0, front: 2, rear: 2 },
  };
  A.gaits = {
    walk: { vmax: 44, accel: 160, step: 15, lift: 5.5 },
    zoom: { vmax: 150, accel: 420, step: 24, lift: 9 },
  };

  // drawn back to front: far legs, body and head, near legs; diagonal pairs share a phase (a trot)
  const legs = [];
  const addLeg = (end, far, offset) => {
    const g = svgEl('g', { class: far ? 'bot-leg is-far' : 'bot-leg' }, A.hit);
    legs.push({
      end, far, offset,
      thigh: svgEl('line', { class: 'bot-thigh' }, g),
      calf: svgEl('line', { class: 'bot-calf' }, g),
      knee: svgEl('circle', { class: 'bot-knee', r: 3.2 }, g),
      foot: svgEl('circle', { class: 'bot-foot', r: 3 }, g),
      hip: far ? null : svgEl('circle', { class: 'bot-hip', r: 5.2 }, g),
      fx: 0, fy: 0,
    });
  };
  addLeg('rear', true, 0);
  addLeg('front', true, 0.5);
  const body = svgEl('g', {}, A.hit);
  svgEl('rect', { class: 'bot-shell', x: -32, y: -11, width: 64, height: 22, rx: 9 }, body);
  svgEl('rect', { class: 'bot-panel', x: -25, y: -11, width: 44, height: 7.5, rx: 3.75 }, body);
  svgEl('path', { class: 'bot-stripe', d: 'M-19 3.5H11' }, body);
  svgEl('circle', { class: 'bot-led', cx: -27.5, cy: -2.5, r: 1.5 }, body);
  const head = svgEl('g', {}, body);
  svgEl('rect', { class: 'bot-shell', x: -3, y: -8, width: 18, height: 14, rx: 5 }, head);
  svgEl('rect', { class: 'bot-face', x: 10, y: -6, width: 6, height: 10, rx: 2.6 }, head);
  svgEl('rect', { class: 'bot-eye', x: 5.5, y: -4.2, width: 4.6, height: 3, rx: 1.5 }, head);
  svgEl('path', { class: 'bot-happy', d: 'M5.4 -1.7Q7.8 -5.2 10.2 -1.7' }, head);
  addLeg('rear', false, 0.5);
  addLeg('front', false, 0);

  const pose = { baseY: POSES.stand.bodyY, bodyY: POSES.stand.bodyY, pitch: 0, head: 0, lift: 0 };
  const neutral = (leg, P) => HIP[leg.end] + (leg.far ? FAR : 0) + (leg.end === 'front' ? P.front : P.rear);
  legs.forEach((leg) => { leg.fx = neutral(leg, POSES.stand); });

  A.next = () => {
    // now and then it sits down next to the humanoid
    const h = A.other('hum');
    if (h && Math.abs(h.cx() - A.cx()) < 160 && Math.random() < 0.3) {
      A.dir = h.cx() >= A.cx() ? 1 : -1;
      A.setMode('sit', rand(2.5, 4.5));
      return;
    }
    const r = Math.random();
    if (r < 0.5) A.walkTo(A.pickTarget(90, 420), 'walk');
    else if (r < 0.58 && A.wide()) A.walkTo(A.pickTarget(380, 4000), 'zoom');
    else if (r < 0.76) A.setMode('idle', rand(1.4, 3.4));
    else if (r < 0.9) A.setMode('sit', rand(3, 6.5));
    else A.setMode('sniff', rand(1.3, 2.2));
  };

  A.update = (dt) => {
    A.t += dt;
    const near = A.isNear();
    if (near && ['walk', 'zoom', 'idle', 'sniff'].includes(A.mode)) A.setMode('look');
    A.maybeNap(near);
    let P = POSES.stand;
    let headGoal = 0;
    let walking = false;
    switch (A.mode) {
      case 'wait':
        if (A.t > A.until) A.walkTo(A.target, 'walk');
        break;
      case 'walk':
      case 'zoom':
        walking = true;
        headGoal = A.mode === 'zoom' ? -7 : Math.sin(A.t * 1.4) * 3;
        if (A.travel(dt)) A.setMode('idle', rand(0.8, 2.4));
        break;
      case 'idle':
        headGoal = A.idleHead(-14, 10);
        if (A.t > A.until) A.next();
        break;
      case 'sit':
        P = POSES.sit;
        if (near) { A.dir = world.ptr.x >= A.cx() ? 1 : -1; headGoal = A.lookAngle(36, pose.bodyY + 5) + 20; } else headGoal = 6 + Math.sin(A.t * 0.9) * 6;
        if (A.t > A.until) A.setMode('rise', 0.45);
        break;
      case 'sniff':
        headGoal = 26 + Math.sin(A.t * 10) * 4;
        if (A.t > A.until) A.setMode('idle', rand(0.6, 1.4));
        break;
      case 'look':
        if (near) {
          A.lookAway = A.t;
          A.dir = world.ptr.x >= A.cx() ? 1 : -1;
          headGoal = A.lookAngle(36, pose.bodyY + 5);
        } else if (A.t - A.lookAway > 0.9) A.next();
        break;
      case 'hop': {
        A.hopT += dt;
        const k = A.hopT / 0.62;
        pose.lift = k < 1 ? 80 * k * (1 - k) : 0;
        headGoal = -12;
        if (k >= 1) A.setMode('idle', rand(0.8, 1.6));
        break;
      }
      case 'nap':
        P = POSES.lie;
        headGoal = 14;
        break;
      default: // rise
        if (A.t > A.until) A.next();
    }
    if (A.mode !== 'hop') pose.lift = 0;
    if (!walking) A.v = approach(A.v, 0, 12, dt);

    // pose: ease toward the target; trotting adds a small bob, standing still a slow breath
    pose.baseY = approach(pose.baseY, P.bodyY, 9, dt);
    pose.pitch = approach(pose.pitch, P.pitch, 8, dt);
    pose.head = approach(pose.head, headGoal, 7, dt);
    const k = walking ? clamp(A.v / A.gait.vmax, 0, 1) : 0;
    const bob = walking ? -1.2 * Math.cos(4 * Math.PI * A.phase) * k : Math.sin(A.t * 2.1) * 0.35;
    pose.bodyY = pose.baseY + bob + pose.lift;

    if (walking) {
      const g = A.gait;
      A.phase = (A.phase + (dt * g.vmax) / (2 * g.step)) % 1; // the same cadence while speeding up or slowing down
      for (const leg of legs) {
        [leg.fx, leg.fy] = stepFoot((A.phase + leg.offset) % 1, neutral(leg, P), g.step * k, g.lift * Math.min(1, k * 1.6));
      }
    } else {
      for (const leg of legs) {
        leg.fx = approach(leg.fx, neutral(leg, P), 14, dt);
        leg.fy = A.mode === 'hop' ? -pose.lift * 0.55 : approach(leg.fy, 0, 14, dt);
      }
    }
    A.blink();
  };

  A.render = () => {
    const th = pose.pitch * RAD;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const cy = -pose.bodyY;
    body.setAttribute('transform', `translate(0 ${fmt(cy)}) rotate(${fmt(pose.pitch)})`);
    head.setAttribute('transform', `translate(28 -5) rotate(${fmt(pose.head)})`);
    for (const leg of legs) {
      const lx = HIP[leg.end] + (leg.far ? FAR : 0);
      const ly = HIP.y - (leg.far ? 1 : 0);
      const hx = lx * c - ly * s;
      const hy = cy + lx * s + ly * c;
      const j = ik(hx, hy, leg.fx, leg.fy, THIGH, CALF, 1);
      setLine(leg.thigh, hx, hy, j.jx, j.jy);
      setLine(leg.calf, j.jx, j.jy, j.ex, j.ey);
      setDot(leg.knee, j.jx, j.jy);
      setDot(leg.foot, j.ex, j.ey);
      if (leg.hip) setDot(leg.hip, hx, hy);
    }
    A.shadow.setAttribute('rx', fmt(30 * (1 - pose.lift / 45)));
    A.place(pose.lift);
  };

  // asleep, lying down, at x
  A.rest = (x) => {
    A.setMode('sleep');
    Object.assign(A, { x, dir: 1, v: 0 });
    Object.assign(pose, { baseY: POSES.lie.bodyY, bodyY: POSES.lie.bodyY, pitch: 0, head: 14, lift: 0 });
    legs.forEach((leg) => { leg.fx = neutral(leg, POSES.lie); leg.fy = 0; });
    A.render();
  };
  A.settled = () => A.mode === 'sleep' || (A.mode === 'nap' && Math.abs(pose.baseY - POSES.lie.bodyY) < 0.05);
  return A;
}

/* ---------- humanoid: a small biped in the spirit of the Unitree G1, knees bent forward ---------- */
function createHumanoid() {
  const view = { x: -40, y: -88, w: 80, h: 94 };
  const A = makeAgent('hum', view, 'humanoid', 0.96);
  const THIGH = 17;
  const SHIN = 17;
  const UPPER = 13;
  const FORE = 12;
  const ANKLE = 3; // ankle height above the ground
  const FAR = { x: 1.5, y: -0.6 }; // far-side limbs, offset so they show behind the near ones
  const SHOULDER = { x: 0.5, y: -22.5 }; // relative to the pelvis, in the torso's frame
  const POSES = {
    stand: { bodyY: 33, pitch: 0, ankle: 0 },
    sit: { bodyY: 7, pitch: -8, ankle: 26 },
  };
  A.gaits = {
    walk: { vmax: 34, accel: 120, step: 12, lift: 4.5 },
    zoom: { vmax: 92, accel: 280, step: 19, lift: 7 },
  };

  // drawn back to front: far arm, far leg, torso and head, near leg, near arm
  const mkLeg = (far) => {
    const g = svgEl('g', { class: far ? 'bot-leg is-far' : 'bot-leg' }, A.hit);
    return {
      far,
      thigh: svgEl('line', { class: 'bot-thigh' }, g),
      calf: svgEl('line', { class: 'bot-calf' }, g),
      knee: svgEl('circle', { class: 'bot-knee', r: 3.2 }, g),
      foot: svgEl('rect', { class: 'bot-sole', x: -3.5, y: -1.2, width: 12, height: 4.2, rx: 2.1 }, g),
      hip: far ? null : svgEl('circle', { class: 'bot-hip', r: 4.4 }, g),
      fx: far ? FAR.x : 0, fy: -ANKLE,
    };
  };
  const mkArm = (far) => {
    const g = svgEl('g', { class: far ? 'bot-arm is-far' : 'bot-arm' }, A.hit);
    return {
      far,
      upper: svgEl('line', { class: 'bot-upper' }, g),
      fore: svgEl('line', { class: 'bot-fore' }, g),
      elbow: svgEl('circle', { class: 'bot-elbow', r: 2.4 }, g),
      hand: svgEl('circle', { class: 'bot-hand', r: 2.7 }, g),
      shoulder: far ? null : svgEl('circle', { class: 'bot-shoulder', r: 4 }, g),
      a: 4, // shoulder: degrees from hanging straight down, forward is positive
      b: 14, // elbow bend, forward is positive
    };
  };
  const armFar = mkArm(true);
  const legFar = mkLeg(true);
  const torso = svgEl('g', {}, A.hit);
  svgEl('rect', { class: 'bot-panel', x: -5.5, y: -3, width: 11, height: 7, rx: 3 }, torso); // pelvis
  svgEl('rect', { class: 'bot-joint', x: -3.5, y: -7, width: 7, height: 5, rx: 2 }, torso); // waist
  svgEl('rect', { class: 'bot-shell', x: -6.5, y: -27, width: 13.5, height: 21, rx: 5 }, torso);
  svgEl('rect', { class: 'bot-panel', x: 1, y: -25, width: 6, height: 12, rx: 3 }, torso); // chest plate
  svgEl('circle', { class: 'bot-led', cx: 3.8, cy: -20.5, r: 1.2 }, torso);
  svgEl('rect', { class: 'bot-joint', x: -1.8, y: -30, width: 4, height: 4, rx: 1.5 }, torso); // neck
  const head = svgEl('g', {}, torso);
  svgEl('rect', { class: 'bot-shell', x: -6, y: -12.5, width: 13, height: 12.5, rx: 5.5 }, head);
  svgEl('rect', { class: 'bot-face', x: 2.6, y: -10.6, width: 5.6, height: 8, rx: 2.6 }, head);
  svgEl('rect', { class: 'bot-eye', x: 4.4, y: -8, width: 3.2, height: 2, rx: 1 }, head);
  svgEl('path', { class: 'bot-happy', d: 'M4.2 -6.3Q6 -8.9 7.8 -6.3' }, head);
  const legNear = mkLeg(false);
  const armNear = mkArm(false);
  const legs = [legFar, legNear];
  const arms = [armFar, armNear];

  const pose = { baseY: POSES.stand.bodyY, bodyY: POSES.stand.bodyY, pitch: 0, head: 0, lift: 0, ankle: 0 };
  // waving: upper arm raised forward, forearm swinging in front of the face
  const WAVE = 118;
  const waveAngle = () => 32 + 22 * Math.sin(A.t * 9);

  A.next = () => {
    // waves when it meets the dog
    const d = A.other('dog');
    if (d && Math.abs(d.cx() - A.cx()) < 160 && Math.random() < 0.35) {
      A.dir = d.cx() >= A.cx() ? 1 : -1;
      A.setMode('wave', rand(1.4, 2.2));
      return;
    }
    const r = Math.random();
    if (r < 0.52) A.walkTo(A.pickTarget(80, 380), 'walk');
    else if (r < 0.6 && A.wide()) A.walkTo(A.pickTarget(340, 4000), 'zoom');
    else if (r < 0.86) A.setMode('idle', rand(1.6, 3.6));
    else A.setMode('wave', rand(1.2, 2));
  };

  A.update = (dt) => {
    A.t += dt;
    const near = A.isNear();
    if (near && ['walk', 'zoom', 'idle'].includes(A.mode)) A.setMode('look');
    A.maybeNap(near);
    let P = POSES.stand;
    let headGoal = 0;
    let walking = false;
    let aN = 4;
    let bN = 14;
    let aF = 4;
    let bF = 14;
    switch (A.mode) {
      case 'wait':
        if (A.t > A.until) A.walkTo(A.target, 'walk');
        break;
      case 'walk':
      case 'zoom':
        walking = true;
        headGoal = A.mode === 'zoom' ? -4 : 0;
        if (A.travel(dt)) A.setMode('idle', rand(0.8, 2.2));
        break;
      case 'idle':
        headGoal = A.idleHead(-12, 12);
        if (A.t > A.until) A.next();
        break;
      case 'wave':
        aN = WAVE;
        bN = waveAngle();
        headGoal = -4;
        if (A.t > A.until) A.setMode('idle', rand(0.6, 1.4));
        break;
      case 'look':
        if (near) {
          A.lookAway = A.t;
          A.dir = world.ptr.x >= A.cx() ? 1 : -1;
          headGoal = A.lookAngle(3, pose.bodyY + 36);
          if (A.wrap.classList.contains('is-hover')) { aN = WAVE; bN = waveAngle(); }
        } else if (A.t - A.lookAway > 0.9) A.next();
        break;
      case 'hop': {
        A.hopT += dt;
        const k = A.hopT / 0.62;
        pose.lift = k < 1 ? 72 * k * (1 - k) : 0;
        aN = 160; aF = 160; bN = 8; bF = 8;
        headGoal = -10;
        if (k >= 1) A.setMode('idle', rand(0.8, 1.6));
        break;
      }
      case 'nap':
        P = POSES.sit;
        headGoal = 24;
        aN = 42; aF = 42; bN = 46; bF = 46;
        break;
      default: // rise
        if (A.t > A.until) A.next();
    }
    if (A.mode !== 'hop') pose.lift = 0;
    if (!walking) A.v = approach(A.v, 0, 12, dt);

    const k = walking ? clamp(A.v / A.gait.vmax, 0, 1) : 0;
    if (walking) {
      // arms swing against the legs on the same side
      const swing = 22 * k * Math.cos(2 * Math.PI * A.phase);
      aN = 4 - swing;
      aF = 4 + swing;
      bN = 18 + 10 * k;
      bF = bN;
    }
    pose.baseY = approach(pose.baseY, P.bodyY, 8, dt);
    pose.ankle = approach(pose.ankle, P.ankle, 8, dt);
    pose.pitch = approach(pose.pitch, P.pitch + 3 * k, 8, dt);
    pose.head = approach(pose.head, headGoal, 7, dt);
    // the pelvis rides highest over a foot in mid-stance
    const bob = walking ? 1.1 * Math.cos(4 * Math.PI * (A.phase - 0.25)) * k : Math.sin(A.t * 2) * 0.3;
    pose.bodyY = pose.baseY + bob + pose.lift;
    armNear.a = approach(armNear.a, aN, 16, dt);
    armNear.b = approach(armNear.b, bN, 16, dt);
    armFar.a = approach(armFar.a, aF, 16, dt);
    armFar.b = approach(armFar.b, bF, 16, dt);

    if (walking) {
      const g = A.gait;
      A.phase = (A.phase + (dt * g.vmax) / (2 * g.step)) % 1;
      for (const leg of legs) {
        const [fx, fy] = stepFoot((A.phase + (leg.far ? 0.5 : 0)) % 1, leg.far ? FAR.x : 0, g.step * k, g.lift * Math.min(1, k * 1.6));
        leg.fx = fx;
        leg.fy = fy - ANKLE;
      }
    } else {
      for (const leg of legs) {
        leg.fx = approach(leg.fx, (leg.far ? FAR.x : 0) + pose.ankle, 12, dt);
        leg.fy = A.mode === 'hop' ? -ANKLE - pose.lift * 0.5 : approach(leg.fy, -ANKLE, 12, dt);
      }
    }
    A.blink();
  };

  A.render = () => {
    const th = pose.pitch * RAD;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const py = -pose.bodyY; // pelvis
    torso.setAttribute('transform', `translate(0 ${fmt(py)}) rotate(${fmt(pose.pitch)})`);
    head.setAttribute('transform', `translate(0.5 -29.5) rotate(${fmt(pose.head)})`);
    // sitting on the ground turns the toes up
    const tilt = -55 * clamp((pose.ankle - 6) / 18, 0, 1);
    for (const leg of legs) {
      const hx = leg.far ? FAR.x : 0;
      const hy = py + (leg.far ? FAR.y : 0);
      const j = ik(hx, hy, leg.fx, leg.fy, THIGH, SHIN, -1);
      setLine(leg.thigh, hx, hy, j.jx, j.jy);
      setLine(leg.calf, j.jx, j.jy, j.ex, j.ey);
      setDot(leg.knee, j.jx, j.jy);
      leg.foot.setAttribute('transform', `translate(${fmt(j.ex)} ${fmt(j.ey)}) rotate(${fmt(tilt)})`);
      if (leg.hip) setDot(leg.hip, hx, hy);
    }
    for (const arm of arms) {
      // shoulders ride on the torso; arm angles are measured from hanging straight down
      const lx = SHOULDER.x + (arm.far ? FAR.x : 0);
      const ly = SHOULDER.y + (arm.far ? FAR.y : 0);
      const sx = lx * c - ly * s;
      const sy = py + lx * s + ly * c;
      const a = (arm.a - pose.pitch) * RAD;
      const b = (arm.a + arm.b - pose.pitch) * RAD;
      const ex = sx + UPPER * Math.sin(a);
      const ey = sy + UPPER * Math.cos(a);
      const hx = ex + FORE * Math.sin(b);
      const hy = ey + FORE * Math.cos(b);
      setLine(arm.upper, sx, sy, ex, ey);
      setLine(arm.fore, ex, ey, hx, hy);
      setDot(arm.elbow, ex, ey);
      setDot(arm.hand, hx, hy);
      if (arm.shoulder) setDot(arm.shoulder, sx, sy);
    }
    A.shadow.setAttribute('rx', fmt((pose.ankle > 6 ? 22 : 13) * (1 - pose.lift / 45)));
    A.shadow.setAttribute('cx', fmt(pose.ankle * 0.45));
    A.place(pose.lift);
  };

  // asleep, sitting on the ground, at x
  A.rest = (x) => {
    A.setMode('sleep');
    Object.assign(A, { x, dir: 1, v: 0 });
    Object.assign(pose, { baseY: POSES.sit.bodyY, bodyY: POSES.sit.bodyY, pitch: POSES.sit.pitch, head: 24, lift: 0, ankle: POSES.sit.ankle });
    for (const arm of arms) { arm.a = 42; arm.b = 46; }
    legs.forEach((leg) => { leg.fx = (leg.far ? FAR.x : 0) + POSES.sit.ankle; leg.fy = -ANKLE; });
    A.render();
  };
  A.settled = () => A.mode === 'sleep'
    || (A.mode === 'nap' && Math.abs(pose.baseY - POSES.sit.bodyY) < 0.05 && Math.abs(pose.ankle - POSES.sit.ankle) < 0.05);
  return A;
}

/* ---------- the frame loop runs only while something moves ---------- */
let raf = 0;
let last = 0;
const running = () => !still() && !root.classList.contains('has-modal') && !document.hidden;
function frame(ts) {
  raf = 0;
  const dt = last ? Math.min(0.05, (ts - last) / 1000) : 1 / 60;
  last = ts;
  for (const a of world.agents) { a.update(dt); a.render(); }
  if (running() && world.agents.some((a) => !a.settled())) raf = requestAnimationFrame(frame);
}
function kick() {
  if (raf || !running()) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}
// paused or reduced motion: both rest asleep side by side in the corner, without walking there
function sleepAll() {
  world.asleep = true;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  let x = 6;
  for (const a of world.agents) { a.rest(x); x += a.size.w - 10; }
}
function sync() {
  if (still()) { if (!world.asleep) sleepAll(); return; }
  if (world.asleep) {
    world.asleep = false;
    for (const a of world.agents) a.setMode('rise', 0.8);
  }
  kick();
}
function wakeAll() {
  world.lastActive = performance.now();
  for (const a of world.agents) if (a.mode === 'nap') a.setMode('rise', 0.8);
  kick();
}

function start() {
  const layer = document.createElement('div');
  layer.className = 'bots';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  world.layer = layer;
  world.toTop = document.querySelector('[data-to-top]');
  const makers = { dog: createDog, humanoid: createHumanoid };
  world.agents = ROBOTS.filter((k) => makers[k]).map((k) => makers[k]());
  world.agents.forEach((a) => a.measure());

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') { world.ptr.x = e.clientX; world.ptr.y = e.clientY; }
    wakeAll();
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) world.ptr.x = null; });
  window.addEventListener('blur', () => { world.ptr.x = null; });
  for (const type of ['scroll', 'keydown', 'touchstart']) window.addEventListener(type, wakeAll, { passive: true });
  window.addEventListener('resize', () => {
    for (const a of world.agents) {
      a.measure();
      const { minX, maxX } = a.bounds();
      if (a.mode !== 'wait') a.x = clamp(a.x, minX, maxX);
      a.target = clamp(a.target, minX, maxX);
      a.render();
    }
  });
  document.addEventListener('visibilitychange', kick);
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', sync);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-motion', 'class'] });

  if (still()) { sleepAll(); return; }
  // the dog trots in from the left; the humanoid walks in from the right a moment later
  const W = window.innerWidth;
  world.agents.forEach((a, i) => {
    const fromLeft = i % 2 === 0;
    a.x = fromLeft ? -a.size.w - 20 : W + 20;
    a.dir = fromLeft ? 1 : -1;
    a.target = fromLeft ? rand(0.12, 0.4) * W : rand(0.55, 0.85) * W;
    a.setMode('wait', i * 1.6);
    a.render();
  });
  kick();
}

// let the page's own entrance finish first
setTimeout(start, 1200);
