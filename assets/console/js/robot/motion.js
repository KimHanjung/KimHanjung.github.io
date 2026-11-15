// Step sequencer for scripted motions (pick, place, imitation replay).
//
// Steps:
//   { kind: 'move', to: Vector3, speed?, minTime?, tool?, tol? }  eased straight-line move of the commanded target
//   { kind: 'path', points: Vector3[], speed, segOf?: (i) => k, onProgress?: (u, k) => void }  constant-speed polyline
//   { kind: 'grip', state: 'close'|'open', block?, time? }        actuate the gripper and wait
//   { kind: 'wait', time }
//   { kind: 'call' }                                              run onDone immediately
// Every step may carry onStart / onDone callbacks.
import * as THREE from 'three';

const smooth = (t) => t * t * (3 - 2 * t);

export class Sequencer {
  constructor() {
    this.queue = [];
    this.step = null;
  }

  get busy() { return this.step !== null || this.queue.length > 0; }

  push(...steps) {
    this.queue.push(...steps);
    return this;
  }

  cancel() {
    this.queue.length = 0;
    this.step = null;
  }

  /**
   * Advance the active step. ctx: { target: Vector3, tool: number, tcp: Vector3, setGrip(state, step) }.
   * Returns true when a step controlled the target this frame.
   */
  update(dt, ctx) {
    for (let guard = 0; guard < 8; guard++) {
      if (!this.step) {
        this.step = this.queue.shift() || null;
        if (!this.step) return false;
        this._begin(this.step, ctx);
      }
      const s = this.step;
      if (s.kind === 'call') { this._end(); continue; }
      s.t += dt;
      if (s.kind === 'move') {
        const u = Math.min(1, s.t / s.dur);
        const e = smooth(u);
        ctx.target.lerpVectors(s.from, s.to, e);
        if (s.tool !== undefined) ctx.tool = s.toolFrom + (s.tool - s.toolFrom) * e;
        if (u >= 1 && (ctx.tcp.distanceTo(s.to) < (s.tol ?? 0.005) || s.t > s.dur + 0.9)) this._end();
      } else if (s.kind === 'path') {
        const d = Math.min(s.total, s.t * s.speed);
        const i = this._pointAt(s, d, ctx.target);
        if (s.onProgress) s.onProgress(s.total > 0 ? d / s.total : 1, s.segOf ? s.segOf(i) : 0);
        const last = s.points[s.points.length - 1];
        if (d >= s.total && (ctx.tcp.distanceTo(last) < 0.004 || s.t > s.total / s.speed + 0.9)) this._end();
      } else if (s.kind === 'grip' || s.kind === 'wait') {
        if (s.t >= (s.time ?? 0.24)) this._end();
      }
      return true;
    }
    return true;
  }

  _begin(s, ctx) {
    s.t = 0;
    if (s.kind === 'move') {
      s.from = ctx.target.clone();
      s.toolFrom = ctx.tool;
      const dist = s.from.distanceTo(s.to);
      s.dur = Math.max(s.minTime ?? 0.18, dist / (s.speed ?? 0.4));
    } else if (s.kind === 'path') {
      s.cum = [0];
      for (let i = 1; i < s.points.length; i++) s.cum.push(s.cum[i - 1] + s.points[i].distanceTo(s.points[i - 1]));
      s.total = s.cum[s.cum.length - 1];
      s.cursor = 0;
    } else if (s.kind === 'grip') {
      ctx.setGrip(s.state, s);
    }
    if (s.onStart) s.onStart(s);
  }

  _end() {
    const s = this.step;
    this.step = null;
    if (s && s.onDone) s.onDone(s);
  }

  _pointAt(s, d, out) {
    const pts = s.points;
    let i = s.cursor;
    while (i < pts.length - 2 && s.cum[i + 1] < d) i++;
    s.cursor = i;
    const seg = s.cum[i + 1] - s.cum[i];
    const u = seg > 1e-9 ? (d - s.cum[i]) / seg : 1;
    out.lerpVectors(pts[i], pts[Math.min(i + 1, pts.length - 1)], Math.min(1, Math.max(0, u)));
    return i;
  }
}

export const V = (x, y, z) => new THREE.Vector3(x, y, z);
