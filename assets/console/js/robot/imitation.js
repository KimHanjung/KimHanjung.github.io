// Imitation mode: record a demonstration path, split it into "skills", and trace the robot's replay.
import * as THREE from 'three';
import { SKILL_COLORS } from './config.js';

const SPACING = 0.004;        // resample spacing (m)
const MIN_LENGTH = 0.06;      // shortest demonstration accepted (m)
const TURN = (55 * Math.PI) / 180;
const PAUSE = 0.28;           // s without movement that counts as a skill boundary
const MIN_SEG = 0.03;         // shortest skill segment (m)
const MAX_SEGS = 8;

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function dots(count, radius, material) {
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 10, 8), material, count);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  return mesh;
}

export class Imitation {
  constructor(scene) {
    this.palette = SKILL_COLORS.map((c) => new THREE.Color(c));
    // demonstration: a wide translucent band (colored by skill once segmented)
    // robot replay: a thin bright core drawn by the pen tip
    this.human = dots(1600, 0.0068, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }));
    this.robot = dots(2400, 0.0024, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.human.renderOrder = 2;
    scene.add(this.human, this.robot);
    this.raw = [];
    this.points = [];
    this.segments = [];
    this.robotPts = [];
    this._m = new THREE.Matrix4();
    this._white = new THREE.Color(0xe8f0ea);
    this._core = new THREE.Color(0xf4fff0);
  }

  clear() {
    this.raw = [];
    this.points = [];
    this.segments = [];
    this.robotPts = [];
    this.human.count = 0;
    this.robot.count = 0;
    this._lastRobot = null;
    this._lastDot = null;
  }

  begin(p, t) {
    this.clear();
    this.add(p, t);
  }

  add(p, t) {
    const last = this.raw[this.raw.length - 1];
    // ignore jitter; keeping the old timestamp lets a hold register as a pause
    if (last && last.p.distanceTo(p) < 0.0015) return;
    this.raw.push({ p: p.clone(), t });
    if (!this._lastDot || this._lastDot.distanceTo(p) >= SPACING) {
      this._addDot(this.human, p, this._white);
      this._lastDot = p.clone();
    }
  }

  _addDot(mesh, p, color) {
    const i = mesh.count;
    if (i >= mesh.instanceMatrix.count) return;
    this._m.makeTranslation(p.x, p.y, p.z);
    mesh.setMatrixAt(i, this._m);
    mesh.setColorAt(i, color);
    mesh.count = i + 1;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Finish recording. Returns { valid, points, segments, length } with the path resampled at even spacing. */
  end() {
    const raw = this.raw;
    let length = 0;
    for (let i = 1; i < raw.length; i++) length += raw[i].p.distanceTo(raw[i - 1].p);
    if (raw.length < 2 || length < MIN_LENGTH) return { valid: false, length };

    // resample by arc length, carrying time so pauses survive
    const pts = [raw[0].p.clone()];
    const times = [raw[0].t];
    const pauseAt = new Set();
    let carry = 0;
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1], b = raw[i];
      const seg = a.p.distanceTo(b.p);
      if (b.t - a.t > PAUSE) pauseAt.add(pts.length - 1);
      let d = SPACING - carry;
      while (d <= seg) {
        const u = d / seg;
        pts.push(a.p.clone().lerp(b.p, u));
        times.push(a.t + (b.t - a.t) * u);
        d += SPACING;
      }
      carry = seg - (d - SPACING);
    }
    const lastRaw = raw[raw.length - 1].p;
    if (pts[pts.length - 1].distanceTo(lastRaw) > 1e-4) { pts.push(lastRaw.clone()); times.push(raw[raw.length - 1].t); }

    // boundaries: sharp turns (over a short window) and pauses
    const cuts = new Set([...pauseAt].filter((i) => i > 0 && i < pts.length - 1));
    const w = 3;
    for (let i = w; i < pts.length - w; i++) {
      const h1 = Math.atan2(pts[i].z - pts[i - w].z, pts[i].x - pts[i - w].x);
      const h2 = Math.atan2(pts[i + w].z - pts[i].z, pts[i + w].x - pts[i].x);
      if (Math.abs(wrapAngle(h2 - h1)) > TURN) cuts.add(i);
    }
    // collapse neighbouring cuts, then build segments
    const sorted = [...cuts].sort((a, b) => a - b);
    const bounds = [0];
    for (const c of sorted) if (c - bounds[bounds.length - 1] >= 4) bounds.push(c);
    if (bounds[bounds.length - 1] !== pts.length - 1) bounds.push(pts.length - 1);
    let segs = [];
    for (let k = 0; k < bounds.length - 1; k++) segs.push({ start: bounds[k], end: bounds[k + 1] });
    const segLen = (s) => (s.end - s.start) * SPACING;
    // merge short segments into a neighbour, then cap the count
    let changed = true;
    while (changed && segs.length > 1) {
      changed = false;
      for (let k = 0; k < segs.length; k++) {
        if (segLen(segs[k]) < MIN_SEG || segs.length > MAX_SEGS) {
          const j = k === 0 ? 1 : (k === segs.length - 1 ? k - 1 : (segLen(segs[k - 1]) < segLen(segs[k + 1]) ? k - 1 : k + 1));
          const a = Math.min(k, j), b = Math.max(k, j);
          segs.splice(a, 2, { start: segs[a].start, end: segs[b].end });
          changed = true;
          break;
        }
      }
    }
    segs = segs.map((s, k) => ({ ...s, index: k, color: this.palette[k % this.palette.length], length: segLen(s) }));

    // recolor the human trace by skill
    this.human.count = 0;
    let k = 0;
    for (let i = 0; i < pts.length; i += 1) {
      while (k < segs.length - 1 && i > segs[k].end) k++;
      this._addDot(this.human, pts[i], segs[k].color);
    }
    this.points = pts;
    this.segments = segs;
    return { valid: true, points: pts, segments: segs, length };
  }

  segmentOfPoint(i) {
    for (const s of this.segments) if (i <= s.end) return s.index;
    return this.segments.length - 1;
  }

  /** Record where the robot's pen tip actually went. */
  addRobot(p, skillIndex) {
    if (this._lastRobot && this._lastRobot.distanceTo(p) < 0.0025) return;
    this._lastRobot = p.clone();
    this.robotPts.push(p.clone());
    this._addDot(this.robot, p, this._core);
  }

  /** Mean and max distance (m) from the robot's trace to the demonstrated path. */
  deviation() {
    const pts = this.points;
    if (!pts.length || !this.robotPts.length) return null;
    let sum = 0, max = 0;
    const tmp = new THREE.Vector3();
    const seg = new THREE.Line3();
    for (const r of this.robotPts) {
      let best = Infinity;
      for (let i = 1; i < pts.length; i++) {
        seg.set(pts[i - 1], pts[i]);
        seg.closestPointToPoint(r, true, tmp);
        const d = tmp.distanceTo(r);
        if (d < best) best = d;
      }
      sum += best;
      if (best > max) max = best;
    }
    return { mean: sum / this.robotPts.length, max };
  }

  setVisible(on) {
    this.human.visible = on;
    this.robot.visible = on;
  }
}
