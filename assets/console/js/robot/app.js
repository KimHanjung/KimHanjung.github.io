// Robot viewport controller: scene, input, modes (teleop / imitate / auto), telemetry.
import * as THREE from 'three';
import { ARM, BASE, BLOCK, HOVER_CLEAR, TRAVEL_Y, DRAW_Y, REACH, GRIP, READY, SKILL_COLORS } from './config.js';
import { solveIK, LIMITS } from './ik.js';
import { Arm } from './arm.js';
import { BlockWorld } from './blocks.js';
import { Sequencer, V } from './motion.js';
import { Imitation } from './imitation.js';
import { nextRestoreOp } from './planner.js';

const HALF_PI = Math.PI / 2;
const DEG = 180 / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const THEMES = {
  dark: {
    bg: 0x0c110f, floor: 0x101814, grid: 0x1c2a22, gridMajor: 0x2c4422, ring: 0x76b900, ringOpacity: 0.32,
    hemiSky: 0xdde8e1, hemiGround: 0x18261d, hemi: 1.05, key: 2.5, fill: 0.5, rim: 1.25, marks: 0.38, exposure: 1.0,
  },
  light: {
    bg: 0xf7f9f7, floor: 0xe7ede8, grid: 0xcfd9d2, gridMajor: 0xa9c58a, ring: 0x5c9c00, ringOpacity: 0.45,
    hemiSky: 0xffffff, hemiGround: 0xb9c9bd, hemi: 1.5, key: 2.3, fill: 0.55, rim: 0.45, marks: 0.55, exposure: 1.0,
  },
};

const STATUS_COLORS = { idle: 0x76b900, busy: 0xffb547, hold: 0x3fd2e6, pen: 0xc084fc };

export class RobotApp {
  constructor(bay, { bus = new EventTarget(), reduceMotion = () => false, debug = false } = {}) {
    this.bay = bay;
    this.bus = bus;
    this.reduceMotion = reduceMotion;
    this.debug = debug;
    this.view = bay.querySelector('[data-view]');
    this.canvas = bay.querySelector('[data-canvas]');
    this.hintEl = bay.querySelector('[data-hint]');
    this.statusEl = bay.querySelector('[data-status]');
    this.skillsEl = bay.querySelector('[data-skills]');
    this.tm = Object.fromEntries([...bay.querySelectorAll('[data-tm]')].map((el) => [el.dataset.tm, el]));
    this.modeButtons = [...bay.querySelectorAll('[data-mode]')];
    this.rows = (bay.dataset.blocks || 'HANJUNG|KIM').split('|').map((s) => s.trim().toUpperCase()).filter(Boolean);
    this.beam = document.querySelector('[data-beam]');
    this.beamEls = this.beam ? {
      line: this.beam.querySelector('.beam'), glow: this.beam.querySelector('.beam-glow'),
      a: this.beam.querySelector('.beam-a'), b: this.beam.querySelector('.beam-b'),
    } : null;

    this.mode = 'boot';
    this.seq = new Sequencer();
    this.holding = null;
    this.penOn = false;
    this.penDown = false;
    this.activeSkill = -1;
    this.drawing = false;
    this.attendEl = null;
    this.anchor = { x: 0, y: 0 };
    this.visible = true;
    this.t = 0;
    this.last = 0;
    this.lastInput = performance.now();
    this.fps = 60;
    this.rollK = 0;
    this.wide = window.matchMedia('(min-width: 961px)');
    this.finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

    this.pointer = { inView: false, ndc: new THREE.Vector2(), clientX: null, clientY: null, down: null };
    this.cursor = { active: false, source: null, pos: new THREE.Vector3(0, 0, 0.08) };
    this.ctx = {
      target: new THREE.Vector3(),
      tool: READY.tool,
      tcp: new THREE.Vector3(),
      setGrip: (state, step) => this._setGrip(state, step),
    };
    this.desired = new THREE.Vector3();
    this.ik = {};
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.drawPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DRAW_Y);
    this.pointPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.02);
    this.camBase = new THREE.Vector3();
    this.camLook = new THREE.Vector3(0.0, 0.165, -0.06);
    this.camOffset = new THREE.Vector2();
    this._frame = this._frame.bind(this);
  }

  // ---------------------------------------------------------------- setup
  async start(bootDone = Promise.resolve()) {
    this._initRenderer();
    this._initScene();
    if (document.fonts && document.fonts.ready) {
      try { await Promise.race([document.fonts.ready, wait(1500)]); } catch (e) { /* fonts are cosmetic */ }
    }
    this.world = new BlockWorld(this.scene, this.rows, this.maxAniso);
    this.world.onLand = () => this._telemetry(true);
    this.imitation = new Imitation(this.scene);
    this._applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    this._initInput();
    this._resize();

    const reduce = this.reduceMotion();
    this.arm.tcpWorld(this.ctx.tcp);
    this.ctx.target.copy(this.ctx.tcp);
    if (reduce) {
      this.powered = true;
      this._readyPose(this.desired, 0);
      solveIK(this.desired, BASE, READY.tool, this.ik);
      this.arm.snap({ q1: this.ik.q1, q2: this.ik.q2, q3: this.ik.q3, q4: this.ik.q4, q5: 0 });
      this.arm.tcpWorld(this.ctx.target);
      this.world.spawn(false);
    } else {
      this.world.hideAll();
    }

    this.bay.classList.add('is-ready');
    this.last = performance.now();
    requestAnimationFrame(this._frame);

    if (reduce) {
      this._setMode('teleop');
    } else {
      this._status('booting · waiting for policy');
      await Promise.race([bootDone, wait(2600)]);
      this._powerOn();
    }
    return this;
  }

  _initRenderer() {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.maxAniso = Math.min(8, r.capabilities.getMaxAnisotropy());
  }

  _initScene() {
    const s = this.scene = new THREE.Scene();
    s.background = new THREE.Color(THEMES.dark.bg);
    s.fog = new THREE.Fog(THEMES.dark.bg, 1.7, 4.2);
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.02, 20);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x223322, 1);
    s.add(this.hemi);
    const key = this.key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(0.55, 1.25, 0.75);
    key.target.position.set(0, 0, -0.05);
    key.castShadow = true;
    const small = window.innerWidth < 700;
    key.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    const sc = key.shadow.camera;
    sc.left = -0.6; sc.right = 0.6; sc.top = 0.6; sc.bottom = -0.6; sc.near = 0.2; sc.far = 3;
    key.shadow.radius = 3;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.012;
    s.add(key, key.target);
    this.fill = new THREE.DirectionalLight(0xcfe3ff, 0.5);
    this.fill.position.set(-1.0, 0.6, 0.4);
    s.add(this.fill);
    this.rim = new THREE.DirectionalLight(0xa6ff4d, 1.2);
    this.rim.position.set(-0.3, 0.8, -1.2);
    s.add(this.rim);

    this.floorMat = new THREE.MeshStandardMaterial({ color: THEMES.dark.floor, roughness: 0.96, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), this.floorMat);
    floor.rotation.x = -HALF_PI;
    floor.receiveShadow = true;
    s.add(floor);

    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x76b900, transparent: true, opacity: 0.32, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(REACH.max - 0.0025, REACH.max, 160), this.ringMat);
    ring.rotation.x = -HALF_PI;
    ring.position.set(BASE.x, 0.0015, BASE.z);
    s.add(ring);
    const inner = new THREE.Mesh(new THREE.RingGeometry(0.115, 0.118, 96), this.ringMat);
    inner.rotation.x = -HALF_PI;
    inner.position.set(BASE.x, 0.0015, BASE.z);
    s.add(inner);

    // imitation drawing plane (shown only in imitate mode)
    this.boardMat = new THREE.MeshBasicMaterial({ color: 0x76b900, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide });
    // ring sector in front of the robot (+z), matching the ±1.9 rad that _drawPoint accepts
    this.board = new THREE.Mesh(new THREE.RingGeometry(REACH.min, REACH.max - 0.01, 120, 1, -HALF_PI - 1.9, 3.8), this.boardMat);
    this.board.rotation.x = -HALF_PI;
    this.board.position.set(BASE.x, DRAW_Y - 0.001, BASE.z);
    this.board.visible = false;
    s.add(this.board);

    // cursor reticle + drop line
    this.reticle = new THREE.Group();
    const retMat = this.retMat = new THREE.MeshBasicMaterial({ color: 0x76b900, transparent: true, opacity: 0.9, depthWrite: false });
    const r1 = new THREE.Mesh(new THREE.RingGeometry(0.019, 0.024, 48), retMat);
    r1.rotation.x = -HALF_PI;
    const r2 = new THREE.Mesh(new THREE.CircleGeometry(0.004, 20), retMat);
    r2.rotation.x = -HALF_PI;
    this.reticle.add(r1, r2);
    this.reticle.visible = false;
    s.add(this.reticle);
    const dropGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
    this.dropLine = new THREE.Line(dropGeo, new THREE.LineDashedMaterial({ color: 0x76b900, dashSize: 0.008, gapSize: 0.006, transparent: true, opacity: 0.7 }));
    this.dropLine.frustumCulled = false;
    this.dropLine.visible = false;
    s.add(this.dropLine);
    this.ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK)), new THREE.LineBasicMaterial({ color: 0x76b900, transparent: true, opacity: 0.85 }));
    this.ghost.visible = false;
    s.add(this.ghost);

    this.arm = new Arm();
    s.add(this.arm.root);
  }

  _makeGrid(theme) {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    const g = this.grid = new THREE.GridHelper(3, 60, theme.gridMajor, theme.grid);
    g.material.transparent = true;
    g.material.opacity = 0.9;
    g.material.depthWrite = false;
    g.position.y = 0.0008;
    this.scene.add(g);
  }

  _applyTheme(name) {
    const t = THEMES[name] || THEMES.dark;
    this.themeName = name;
    this.scene.background.setHex(t.bg);
    this.scene.fog.color.setHex(t.bg);
    this.floorMat.color.setHex(t.floor);
    this.hemi.color.setHex(t.hemiSky);
    this.hemi.groundColor.setHex(t.hemiGround);
    this.hemi.intensity = t.hemi;
    this.key.intensity = t.key;
    this.fill.intensity = t.fill;
    this.rim.intensity = t.rim;
    this.ringMat.color.setHex(t.ring);
    this.ringMat.opacity = t.ringOpacity;
    this.retMat.color.setHex(t.ring);
    this.dropLine.material.color.setHex(t.ring);
    this.ghost.material.color.setHex(t.ring);
    this.boardMat.color.setHex(t.ring);
    this.renderer.toneMappingExposure = t.exposure;
    if (this.world) this.world.setMarkColor(t.ring, t.marks);
    this._makeGrid(t);
  }

  _initInput() {
    const c = this.canvas;
    c.addEventListener('pointermove', (e) => this._onPointerMove(e));
    c.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    c.addEventListener('pointerup', (e) => this._onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this._onPointerUp(e, true));
    c.addEventListener('pointerleave', () => {
      if (!this.drawing) { this.pointer.inView = false; if (this.cursor.source === 'pointer') this.cursor.active = false; }
    });
    c.addEventListener('contextmenu', (e) => { if (this.mode === 'imitate') e.preventDefault(); });
    window.addEventListener('pointermove', (e) => {
      this.pointer.clientX = e.clientX;
      this.pointer.clientY = e.clientY;
      if (e.target !== c) this.lastInput = performance.now();
    }, { passive: true });

    this.view.addEventListener('keydown', (e) => this._onKey(e));
    this.view.addEventListener('focus', () => this._hintForMode());
    this.view.addEventListener('blur', () => { if (this.cursor.source === 'key') this.cursor.active = false; this._hintForMode(); });

    for (const b of this.modeButtons) b.addEventListener('click', () => this._setMode(b.dataset.mode, true));

    this.bus.addEventListener('attend', (e) => { this.attendEl = e.detail && e.detail.el; this.attendLabel = e.detail && e.detail.label; this.lastInput = performance.now(); });
    this.bus.addEventListener('release', () => { this.attendEl = null; });
    this.bus.addEventListener('theme', (e) => this._applyTheme(e.detail));

    new ResizeObserver(() => this._resize()).observe(this.view);
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) this.inViewport = en.isIntersecting;
      this._updateVisible();
    }, { threshold: 0.01 });
    io.observe(this.bay);
    document.addEventListener('visibilitychange', () => this._updateVisible());
  }

  _updateVisible() {
    const was = this.visible;
    this.visible = (this.inViewport !== false) && document.visibilityState === 'visible';
    if (this.visible && !was) this.last = performance.now();
  }

  _resize() {
    const w = Math.max(1, this.view.clientWidth);
    const h = Math.max(1, this.view.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, w < 700 ? 1.5 : 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    // three-quarter view framing ~0.64 m wide and ~0.5 m tall around the look-at point
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
    const dist = Math.max(0.35 / Math.tan(hfov / 2), 0.34 / Math.tan(vfov / 2));
    const elev = THREE.MathUtils.degToRad(27);
    const azim = THREE.MathUtils.degToRad(24);
    this.camBase.set(
      this.camLook.x + dist * Math.cos(elev) * Math.sin(azim),
      this.camLook.y + dist * Math.sin(elev),
      this.camLook.z + dist * Math.cos(elev) * Math.cos(azim),
    );
    cam.position.copy(this.camBase);
    cam.lookAt(this.camLook);
    cam.updateProjectionMatrix();
    this.canvasRect = this.canvas.getBoundingClientRect();
  }

  // ---------------------------------------------------------------- modes
  _setMode(mode, user = false) {
    if (user) this.lastInput = performance.now();
    const prev = this.mode;
    if (mode === prev && mode !== 'auto') return;
    if (this.mode === 'boot' && user) {
      // let a click during power-on take effect once it finishes
      this.pendingMode = mode;
      return;
    }
    this.seq.cancel();
    // a cancelled step never runs its completion callback: restore what it would have reset
    this.arm.omega = 9;
    if (!this.holding) this.arm.gapT = GRIP.open;
    this.drawing = false;
    this.drawId = null;
    this.penDown = false;
    this.activeSkill = -1;
    this.mode = mode;
    this.bay.dataset.mode = mode;
    for (const b of this.modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    this.board.visible = mode === 'imitate';
    if (mode !== 'imitate') {
      this.imitation.clear();
      this._showSkills(null);
      if (this.penOn) this._pen(false);
    }
    if (this.holding && mode !== 'teleop') {
      // set the block down where it is before switching tasks
      const p = this.ctx.tcp;
      const at = this.world.placementFor(p.x, p.z, this.holding);
      if (mode === 'auto') {
        // the planner places it properly
      } else {
        this._queuePlace(at, () => this._enterMode(mode));
        this._hintForMode();
        return;
      }
    }
    this._enterMode(mode);
  }

  _enterMode(mode) {
    if (mode === 'imitate') {
      this._pen(true);
      this.imitation.clear();
      this._status('imitate · waiting for a demonstration');
    } else if (mode === 'auto') {
      this.autoMisses = 0;
      this._status(`auto · restoring ${this.rows.join(' ')}`);
      this._autoStep();
    } else if (mode === 'teleop') {
      this._status(this.holding ? `teleop · holding [${this.holding.letter}]` : 'teleop · ready');
    }
    this._hintForMode();
  }

  _powerOn() {
    this.mode = 'boot';
    this.powered = true;
    this._status('power on · homing joints');
    this.world.spawn(true);
    this.arm.omega = 5.5;
    setTimeout(() => {
      this.arm.omega = 9;
      this.mode = '';
      this._setMode(this.pendingMode || 'teleop');
      this.pendingMode = null;
    }, 1500);
  }

  _pen(on) {
    this.penOn = on;
    this.arm.setPen(on);
  }

  _hintForMode() {
    let text;
    const touch = !this.finePointer.matches;
    let focused = false;
    try { focused = this.view.matches(':focus-visible'); } catch (e) { focused = false; }
    if (this.mode === 'imitate') {
      text = this.seq.busy ? 'imitating your demonstration…' : (touch ? 'drag on the table to demonstrate a path' : 'drag on the table to draw a path · the robot will imitate it');
    } else if (this.mode === 'auto') {
      text = 'autonomous restore · pick teleop to take over';
    } else if (focused) {
      text = 'arrows/wasd move · space grasp · 1/2/3 modes';
    } else if (this.holding) {
      text = touch ? `tap to place [${this.holding.letter}] · tap a block to stack` : `click to place [${this.holding.letter}] · drop on a block to stack`;
    } else {
      text = touch ? 'tap a block to grasp it' : 'move to aim · click a block to grasp';
    }
    this._hint(text);
  }

  _hint(text) {
    if (this.hintEl && this.hintText !== text) { this.hintEl.textContent = text; this.hintText = text; }
  }

  _status(text) {
    if (this.statusEl && this.statusText !== text) { this.statusEl.textContent = text; this.statusText = text; }
  }

  // ---------------------------------------------------------------- input
  _ndcFromEvent(e) {
    const r = this.canvasRect = this.canvas.getBoundingClientRect();
    this.pointer.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  _onPointerMove(e) {
    this.lastInput = performance.now();
    this.pointer.inView = true;
    this.pointer.clientX = e.clientX;
    this.pointer.clientY = e.clientY;
    if (this.drawing) {
      if (e.pointerId !== this.drawId) return;   // only the finger that started the demo draws
      this._ndcFromEvent(e);
      const p = this._drawPoint();
      if (p) this.imitation.add(p, performance.now() / 1000);
      return;
    }
    this._ndcFromEvent(e);
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
      this.cursor.active = true;
      this.cursor.source = 'pointer';
      this._cursorFromPointer();
    }
  }

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.isPrimary === false || this.drawing) return;   // ignore extra fingers
    this.lastInput = performance.now();
    this._ndcFromEvent(e);
    this.pointer.down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    if (this.mode === 'imitate' && !this.seq.busy && this.penOn) {
      const p = this._drawPoint();
      if (!p) return;
      e.preventDefault();
      this.drawing = true;
      this.drawId = e.pointerId;
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      this.imitation.begin(p, performance.now() / 1000);
      this._showSkills(null);
      this._status('imitate · recording demonstration');
      this._hint('release to let the robot imitate');
    }
  }

  _onPointerUp(e, cancelled = false) {
    const down = this.pointer.down;
    if (down && e.pointerId !== down.id) return;   // a different finger lifted
    this.pointer.down = null;
    if (this.drawing) {
      this.drawing = false;
      this.drawId = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      const demo = this.imitation.end();
      if (demo.valid && !cancelled) this._runImitation(demo);
      else {
        this.imitation.clear();
        this._status('imitate · demonstration too short');
        this._hint('draw a longer path (at least 6 cm)');
      }
      return;
    }
    if (cancelled || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > 10 || performance.now() - down.t > 800) return;
    if (this.mode !== 'teleop') return;
    this._ndcFromEvent(e);
    this.cursor.source = this.cursor.source || 'pointer';
    this._cursorFromPointer();
    this._act();
  }

  _onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // leave browser shortcuts alone
    const k = e.key.toLowerCase();
    const step = e.shiftKey ? 0.03 : 0.012;
    const moves = { arrowleft: [-step, 0], a: [-step, 0], arrowright: [step, 0], d: [step, 0], arrowup: [0, -step], w: [0, -step], arrowdown: [0, step], s: [0, step] };
    if (moves[k]) {
      e.preventDefault();
      if (!this.cursor.active || this.cursor.source !== 'key') {
        this.cursor.pos.set(this.ctx.tcp.x, 0, this.ctx.tcp.z);
        this.cursor.source = 'key';
      }
      this.cursor.active = true;
      this.cursor.pos.x += moves[k][0];
      this.cursor.pos.z += moves[k][1];
      this._clampWorkspace(this.cursor.pos);
      this.lastInput = performance.now();
    } else if (k === ' ' || k === 'enter') {
      e.preventDefault();
      if (this.mode === 'teleop') {
        if (!this.cursor.active) { this.cursor.pos.set(this.ctx.tcp.x, 0, this.ctx.tcp.z); this.cursor.source = 'key'; this.cursor.active = true; }
        this._act();
      }
    } else if (k === '1' || k === '2' || k === '3') {
      this._setMode(['teleop', 'imitate', 'auto'][Number(k) - 1], true);
    } else if (k === 'escape') {
      this.view.blur();
    }
  }

  _clampWorkspace(p) {
    const dx = p.x - BASE.x;
    const dz = p.z - BASE.z;
    let r = Math.hypot(dx, dz);
    let ang = Math.atan2(dx, dz);
    ang = clamp(ang, -2.3, 2.3);
    r = clamp(r, REACH.min, REACH.max - 0.02);
    p.x = BASE.x + Math.sin(ang) * r;
    p.z = BASE.z + Math.cos(ang) * r;
    return p;
  }

  _cursorFromPointer() {
    this.raycaster.setFromCamera(this.pointer.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.world.pickables(), false);
    if (hits.length) {
      const b = hits[0].object.userData.block;
      const col = this.world.topBlockAt(b.mesh.position.x, b.mesh.position.z, BLOCK * 0.3) || b;
      this.cursor.pos.set(col.mesh.position.x, 0, col.mesh.position.z);
      this.cursor.block = col;
    } else {
      const p = this.raycaster.ray.intersectPlane(this.floorPlane, this.tmp);
      if (p) this.cursor.pos.set(p.x, 0, p.z);
      else {
        const dir = this.raycaster.ray.direction;
        this.cursor.pos.set(BASE.x + dir.x * 2, 0, BASE.z + Math.abs(dir.z) * 2);
      }
      this.cursor.block = null;
    }
    this._clampWorkspace(this.cursor.pos);
  }

  _drawPoint() {
    this.raycaster.setFromCamera(this.pointer.ndc, this.camera);
    const p = this.raycaster.ray.intersectPlane(this.drawPlane, new THREE.Vector3());
    if (!p) return null;
    const dx = p.x - BASE.x;
    const dz = p.z - BASE.z;
    const ang = clamp(Math.atan2(dx, dz), -1.9, 1.9);
    const r = clamp(Math.hypot(dx, dz), REACH.min + 0.02, REACH.max - 0.03);
    p.set(BASE.x + Math.sin(ang) * r, DRAW_Y, BASE.z + Math.cos(ang) * r);
    return p;
  }

  // ---------------------------------------------------------------- actions
  _act() {
    if (this.seq.busy) { this._hint('busy · wait for the current motion'); return; }
    const c = this.cursor.pos;
    if (!this.holding) {
      const b = this.world.topBlockAt(c.x, c.z, BLOCK * 0.75);
      if (b && !this._reachable(b.mesh.position)) { this._hint(`[${b.letter}] is out of reach`); return; }
      if (b) this._queuePick(b, 'teleop');
      else this._queueProbe(c);
    } else {
      const at = this.world.placementFor(c.x, c.z, this.holding);
      if (!this._reachable(at)) { this._hint('out of reach · try a lower or closer spot'); return; }
      this._queuePlace(at);
    }
  }

  /** Can the gripper reach `p` pointing straight down, within joint limits? */
  _reachable(p) {
    const s = solveIK(p, BASE, Math.PI, this.ikProbe || (this.ikProbe = {}));
    if (!s.reachable) return false;
    return ['q2', 'q3', 'q4'].every((k) => s[k] >= LIMITS[k][0] && s[k] <= LIMITS[k][1]);
  }

  _travelY(extra = 0) {
    return Math.max(this.ctx.target.y, this.world.maxTop() + HOVER_CLEAR + extra);
  }

  _queuePick(b, why = 'teleop', onDone) {
    const p = b.mesh.position.clone();
    const auto = why === 'auto';
    const travel = auto ? Math.max(TRAVEL_Y, this.world.maxTop() + 0.09) : Math.max(this.ctx.target.y, p.y + HOVER_CLEAR);
    this._status(`${auto ? 'auto' : 'teleop'} · grasp [${b.letter}]`);
    if (auto) this.seq.push({ kind: 'move', to: V(this.ctx.target.x, travel, this.ctx.target.z), speed: 0.45, tool: Math.PI });
    this.seq.push(
      { kind: 'move', to: V(p.x, travel, p.z), speed: auto ? 0.5 : 0.65, tool: Math.PI },
      { kind: 'move', to: p.clone(), speed: 0.22, minTime: 0.25, tol: 0.004 },
      { kind: 'grip', state: 'close', block: b, time: 0.26 },
      { kind: 'move', to: V(p.x, Math.max(travel, p.y + HOVER_CLEAR), p.z), speed: 0.32 },
      { kind: 'call', onDone: () => { this._telemetry(true); this._hintForMode(); if (onDone) onDone(); } },
    );
  }

  _queuePlace(at, onDone, why = 'teleop') {
    const auto = why === 'auto';
    const travel = auto ? Math.max(TRAVEL_Y, this.world.maxTop() + BLOCK + 0.09) : Math.max(this.ctx.target.y, at.y + HOVER_CLEAR);
    const letter = this.holding ? this.holding.letter : '';
    this._status(`${auto ? 'auto' : 'teleop'} · place [${letter}]`);
    if (auto) this.seq.push({ kind: 'move', to: V(this.ctx.target.x, travel, this.ctx.target.z), speed: 0.45, tool: Math.PI });
    this.seq.push(
      { kind: 'move', to: V(at.x, travel, at.z), speed: auto ? 0.5 : 0.65, tool: Math.PI },
      { kind: 'move', to: at.clone(), speed: 0.2, minTime: 0.25, tol: 0.004 },
      { kind: 'grip', state: 'open', at: at.clone(), time: 0.24 },
      { kind: 'move', to: V(at.x, at.y + HOVER_CLEAR, at.z), speed: 0.32 },
      { kind: 'call', onDone: () => { this._telemetry(true); this._hintForMode(); if (onDone) onDone(); } },
    );
  }

  _queueProbe(c) {
    const y = this.world.supportTop(c.x, c.z) + 0.03;
    this._status('teleop · probing · no object detected');
    this.seq.push(
      { kind: 'move', to: V(c.x, Math.max(this.ctx.target.y, y + 0.06), c.z), speed: 0.65, tool: Math.PI },
      { kind: 'move', to: V(c.x, y, c.z), speed: 0.25 },
      { kind: 'grip', state: 'close', time: 0.2 },
      { kind: 'grip', state: 'open', time: 0.2 },
      { kind: 'move', to: V(c.x, y + HOVER_CLEAR, c.z), speed: 0.35 },
      { kind: 'call', onDone: () => { this._status('teleop · ready'); this._hintForMode(); } },
    );
  }

  _setGrip(state, step) {
    if (state === 'close') {
      const b = step && step.block;
      if (b && !b.held && this.ctx.tcp.distanceTo(b.mesh.position) < 0.02) {
        this.arm.gapT = GRIP.block;
        step.onDone = () => {
          b.held = true;
          b.falling = false;
          this.holding = b;
          this.arm.attach(b.mesh);
        };
      } else {
        this.arm.gapT = this.penOn ? GRIP.pen : GRIP.empty;
      }
    } else if (state === 'open') {
      this.arm.gapT = GRIP.open;
      const b = this.holding;
      if (b) {
        const at = (step && step.at) || this.ctx.tcp.clone();
        this.holding = null;
        this.world.release(b, at);
      }
    }
  }

  _autoStep() {
    if (this.mode !== 'auto') return;
    const op = nextRestoreOp(this.world, this.holding, this.ctx.tcp);
    const n = this.world.total;
    if (!op) {
      this._status(`auto · all ${n} blocks in place`);
      this._hint(`${this.rows.join(' ')} restored`);
      this.seq.push({ kind: 'wait', time: 0.6 }, { kind: 'call', onDone: () => { if (this.mode === 'auto') this._setMode('teleop'); } });
      return;
    }
    const placed = this.world.inPlaceCount();
    this._hint(`restoring ${this.rows.join(' ')} · ${placed}/${n} in place`);
    const target = this.world.placementFor(op.to.x, op.to.z, op.block);
    const place = () => {
      if (this.holding !== op.block) {
        // the grasp missed (block out of reach or moved): re-plan, but never loop forever
        this.autoMisses = (this.autoMisses || 0) + 1;
        if (this.autoMisses > 2) {
          this._setMode('teleop');
          this._hint(`auto stopped · cannot reach [${op.block.letter}]`);
          return;
        }
        this._autoStep();
        return;
      }
      this._queuePlace(target, () => { this.autoMisses = 0; this._autoStep(); }, 'auto');
    };
    if (this.holding === op.block) place();
    else this._queuePick(op.block, 'auto', place);
  }

  _runImitation(demo) {
    const pts = demo.points;
    const first = pts[0];
    const last = pts[pts.length - 1];
    this._showSkills(demo.segments);
    this._status(`imitate · ${demo.segments.length} skill${demo.segments.length > 1 ? 's' : ''} from ${(demo.length * 100).toFixed(0)} cm demo`);
    this._hintForMode();
    this.seq.push(
      { kind: 'move', to: V(first.x, DRAW_Y + 0.07, first.z), speed: 0.55, tool: Math.PI },
      { kind: 'move', to: first.clone(), speed: 0.2, tol: 0.003 },
      {
        kind: 'path', points: pts, speed: 0.17,
        segOf: (i) => this.imitation.segmentOfPoint(i),
        onStart: () => { this.penDown = true; this.arm.omega = 14; },
        onProgress: (u, k) => this._activeSkillIs(k),
        onDone: () => { this.penDown = false; this.arm.omega = 9; },
      },
      { kind: 'move', to: V(last.x, DRAW_Y + 0.07, last.z), speed: 0.3 },
      {
        kind: 'call',
        onDone: () => {
          this._activeSkillIs(-1, true);
          const dev = this.imitation.deviation();
          const mm = dev ? (dev.mean * 1000).toFixed(1) : '–';
          this._status(`imitate · done · mean deviation ${mm} mm`);
          this._hint(`mean deviation ${mm} mm · draw again`);
          this.lastDeviation = dev;
        },
      },
    );
  }

  _showSkills(segments) {
    const el = this.skillsEl;
    if (!el) return;
    if (!segments) { el.hidden = true; el.textContent = ''; this.skillChips = []; return; }
    el.hidden = false;
    el.textContent = '';
    const key = document.createElement('span');
    key.className = 'z-key';
    key.textContent = 'skills';
    el.appendChild(key);
    this.skillChips = segments.map((s, i) => {
      const chip = document.createElement('span');
      chip.className = 'z';
      chip.style.setProperty('--zc', SKILL_COLORS[i % SKILL_COLORS.length]);
      chip.innerHTML = `z<sub>${i + 1}</sub>`;
      el.appendChild(chip);
      return chip;
    });
  }

  _activeSkillIs(k, finished = false) {
    if (k === this.activeSkill && !finished) return;
    this.activeSkill = k;
    (this.skillChips || []).forEach((c, i) => {
      c.classList.toggle('is-active', i === k);
      c.classList.toggle('is-done', finished || (k >= 0 && i < k));
    });
  }

  // ---------------------------------------------------------------- per-frame control
  _readyPose(out, yaw, lift = 0) {
    return out.set(BASE.x + Math.sin(yaw) * READY.r, READY.y + lift, BASE.z + Math.cos(yaw) * READY.r);
  }

  _yawBias() {
    if (this.pointer.clientX == null) return 0;
    const r = this.canvasRect || this.canvas.getBoundingClientRect();
    const dx = (this.pointer.clientX - (r.left + r.width / 2)) / Math.max(1, r.width);
    return clamp(dx * 0.9, -0.85, 0.85);
  }

  _pointAt(el, out) {
    const r = el.getBoundingClientRect();
    const cr = this.canvasRect = this.canvas.getBoundingClientRect();
    const top = Math.max(r.top, 60);
    const bottom = Math.min(r.bottom, window.innerHeight - 8);
    this.anchor.x = Math.min(r.right + 6, cr.left - 10);
    this.anchor.y = bottom > top ? (top + bottom) / 2 : r.top + r.height / 2;
    const ndc = this.tmp2.set(((this.anchor.x - cr.left) / cr.width) * 2 - 1, -((this.anchor.y - cr.top) / cr.height) * 2 + 1, 0);
    this.raycaster.setFromCamera(ndc, this.camera);
    let P = this.raycaster.ray.intersectPlane(this.pointPlane, this.tmp);
    if (!P) P = this.tmp.set(-1, ARM.H0, 0.02);
    const dx = P.x - BASE.x;
    const dz = P.z - BASE.z;
    const dy = P.y - ARM.H0;
    const yaw = Math.atan2(dx, dz);
    const R = 0.33;   // keep the gripper inside the viewport; the beam spans the rest
    // never aim so low that the tool center would dip below 6 cm (the gripper would sink into the table)
    const psiMax = Math.acos(clamp((0.06 - ARM.H0) / R, -1, 1));
    const psi = clamp(Math.atan2(Math.hypot(dx, dz), dy), 0.45, psiMax);
    out.set(BASE.x + Math.sin(yaw) * Math.sin(psi) * R, ARM.H0 + Math.cos(psi) * R, BASE.z + Math.cos(yaw) * Math.sin(psi) * R);
    return psi;
  }

  _freeTarget(dt) {
    const d = this.desired;
    let tool = READY.tool;
    let lambda = 4;
    const now = performance.now();
    if (this.mode === 'boot') {
      this._readyPose(d, 0);
      lambda = 3;
    } else if (this.mode === 'teleop' && this.attendEl && this.wide.matches) {
      tool = this._pointAt(this.attendEl, d);
      lambda = 6;
    } else if (this.mode === 'teleop' && this.cursor.active) {
      const c = this.cursor.pos;
      d.set(c.x, this.world.supportTop(c.x, c.z, this.holding) + HOVER_CLEAR, c.z);
      tool = Math.PI;
      lambda = 11;
    } else if (this.mode === 'imitate' && this.drawing && this.imitation.raw.length) {
      // watch the demonstration: turn toward the latest point without covering it
      const p = this.imitation.raw[this.imitation.raw.length - 1].p;
      const yaw = Math.atan2(p.x - BASE.x, p.z - BASE.z);
      this._readyPose(d, yaw * 0.85, 0.02);
      lambda = 5;
    } else {
      let yaw = this._yawBias();
      let lift = 0;
      const idle = now - this.lastInput > 9000;
      if (idle && !this.reduceMotion()) {
        yaw = 0.55 * Math.sin(this.t * 0.42);
        lift = 0.025 * Math.sin(this.t * 0.9);
      }
      this._readyPose(d, yaw, lift);
      lambda = 3.5;
    }
    const k = 1 - Math.exp(-lambda * dt);
    this.ctx.target.lerp(d, k);
    this.ctx.tool += (tool - this.ctx.tool) * k;
  }

  _control(dt) {
    this.arm.tcpWorld(this.ctx.tcp);
    if (!this.powered) { this.ctx.target.copy(this.ctx.tcp); return; }   // stay folded until power-on
    let scripted = false;
    if (this.seq.busy) scripted = this.seq.update(dt, this.ctx);
    if (!scripted) this._freeTarget(dt);

    solveIK(this.ctx.target, BASE, this.ctx.tool, this.ik);
    let q5 = 0;
    if (Math.abs(this.ctx.tool - Math.PI) < 0.4) {
      if (!this.holding) {
        const off = this.ik.q1 - this.rollK * HALF_PI;
        if (Math.abs(off) > HALF_PI / 2 + 0.12) this.rollK = Math.round(this.ik.q1 / HALF_PI);
      }
      q5 = this.ik.q1 - this.rollK * HALF_PI;
    }
    this.arm.setTargets({ q1: this.ik.q1, q2: this.ik.q2, q3: this.ik.q3, q4: this.ik.q4, q5 });

    const busy = this.seq.busy || this.mode === 'auto';
    this.arm.setStatusColor(this.penOn ? STATUS_COLORS.pen : this.holding ? STATUS_COLORS.hold : busy ? STATUS_COLORS.busy : STATUS_COLORS.idle);
  }

  _updateCursorVisuals() {
    const show = this.mode === 'teleop' && this.cursor.active && !this.attendEl;
    this.reticle.visible = show;
    this.dropLine.visible = show && !this.seq.busy;
    this.ghost.visible = false;
    let highlight = null;
    if (show) {
      const c = this.cursor.pos;
      const top = this.world.supportTop(c.x, c.z, this.holding);
      this.reticle.position.set(c.x, top + 0.0016, c.z);
      if (this.holding) {
        const at = this.world.placementFor(c.x, c.z, this.holding, this.tmp2);
        this.ghost.position.copy(at);
        this.ghost.visible = !this.seq.busy;
      } else {
        highlight = this.world.topBlockAt(c.x, c.z, BLOCK * 0.6);
      }
      if (this.dropLine.visible) {
        const pos = this.dropLine.geometry.attributes.position;
        this.arm.tipWorld(this.tmp);
        pos.setXYZ(0, this.tmp.x, this.tmp.y, this.tmp.z);
        pos.setXYZ(1, c.x, top + 0.002, c.z);
        pos.needsUpdate = true;
        this.dropLine.computeLineDistances();
      }
    }
    if (highlight !== this.highlighted) {
      this.highlighted = highlight;
      this.world.setHighlight(highlight);
    }
  }

  _updateBeam() {
    if (!this.beam) return;
    const on = this.mode === 'teleop' && this.attendEl && this.wide.matches && !this.seq.busy;
    if (on !== this.beamOn) {
      this.beamOn = on;
      this.beam.classList.toggle('is-on', !!on);
    }
    if (!on) return;
    this.arm.tipWorld(this.tmp).project(this.camera);
    const cr = this.canvasRect;
    const sx = clamp(cr.left + ((this.tmp.x + 1) / 2) * cr.width, cr.left + 2, cr.right - 2);
    const sy = clamp(cr.top + ((1 - this.tmp.y) / 2) * cr.height, cr.top + 2, cr.bottom - 2);
    const { line, glow, a, b } = this.beamEls;
    for (const l of [line, glow]) {
      l.setAttribute('x1', sx.toFixed(1)); l.setAttribute('y1', sy.toFixed(1));
      l.setAttribute('x2', this.anchor.x.toFixed(1)); l.setAttribute('y2', this.anchor.y.toFixed(1));
    }
    a.setAttribute('cx', sx.toFixed(1)); a.setAttribute('cy', sy.toFixed(1));
    b.setAttribute('cx', this.anchor.x.toFixed(1)); b.setAttribute('cy', this.anchor.y.toFixed(1));
  }

  _updateCamera(dt) {
    if (this.reduceMotion()) return;
    let tx = 0, ty = 0;
    if (this.pointer.inView && this.pointer.clientX != null) {
      tx = this.pointer.ndc.x;
      ty = this.pointer.ndc.y;
    }
    const k = 1 - Math.exp(-2.5 * dt);
    this.camOffset.x += (tx - this.camOffset.x) * k;
    this.camOffset.y += (ty - this.camOffset.y) * k;
    const cam = this.camera;
    cam.position.set(this.camBase.x + this.camOffset.x * 0.03, this.camBase.y + this.camOffset.y * 0.015, this.camBase.z);
    cam.lookAt(this.camLook);
  }

  _telemetry(force = false) {
    const now = performance.now();
    if (!force && now - (this.lastTm || 0) < 100) return;
    this.lastTm = now;
    const q = this.arm.q;
    const deg = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * DEG).toFixed(1)}°`;
    const set = (k, v) => { const el = this.tm[k]; if (el && el.textContent !== v) el.textContent = v; };
    set('j1', deg(q.q1));
    set('j2', deg(q.q2));
    set('j3', deg(q.q3));
    set('j4', deg(q.q4));
    set('j5', deg(q.q5));
    set('grip', `${(this.arm.gap * 1000).toFixed(0)} mm`);
    const p = this.ctx.tcp;
    const f = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`;
    set('ee', `x ${f(p.x - BASE.x)} y ${f(p.y)} z ${f(p.z - BASE.z)}`);
    set('hold', this.holding ? `[${this.holding.letter}]` : this.penOn ? 'pen' : 'none');
    if (this.world) set('blocks', `${this.world.inPlaceCount()}/${this.world.total} home`);
    set('fps', `${Math.round(this.fps)}`);
  }

  _frame(now) {
    requestAnimationFrame(this._frame);
    if (!this.visible) { this.last = now; return; }
    const elapsed = now - this.last;
    const idle = now - this.lastInput > 12000 && !this.seq.busy && !this.attendEl && this.mode === 'teleop';
    if (idle && elapsed < 31) return;          // ~30 fps while nobody interacts
    if (elapsed <= 0) return;
    this.last = now;
    const dt = Math.min(elapsed / 1000, 0.05);
    this.t += dt;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;

    this._control(dt);
    this.arm.update(dt);
    this.world.update(dt);
    if (this.penDown) {
      this.arm.tcpWorld(this.tmp);
      this.imitation.addRobot(this.tmp, this.activeSkill);
    }
    this._updateCursorVisuals();
    this._updateCamera(dt);
    this._updateBeam();
    this.renderer.render(this.scene, this.camera);
    this._telemetry();
    if (this.mode === 'teleop' && !this.seq.busy) {
      this._status(this.attendEl && this.wide.matches
        ? `attend · ${this.attendLabel || 'publication'}`
        : this.holding ? `teleop · holding [${this.holding.letter}]` : 'teleop · ready');
    }
  }

  // ---------------------------------------------------------------- debug helpers (?debug)
  /** Screen position (client px) of a block's top face center, for automated tests. */
  screenOf(target) {
    const v = new THREE.Vector3();
    if (target && target.mesh) target.mesh.getWorldPosition(v).add(new THREE.Vector3(0, BLOCK / 2, 0));
    else v.copy(target);
    v.project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  state() {
    return {
      mode: this.mode,
      busy: this.seq.busy,
      holding: this.holding ? this.holding.letter : null,
      inPlace: this.world ? this.world.inPlaceCount() : 0,
      total: this.world ? this.world.total : 0,
      pen: this.penOn,
      status: this.statusText,
      hint: this.hintText,
      deviation: this.lastDeviation || null,
      tcp: this.ctx.tcp.toArray().map((v) => +v.toFixed(4)),
      fps: Math.round(this.fps),
      beam: !!this.beamOn,
    };
  }
}
