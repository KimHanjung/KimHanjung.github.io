// Procedural 5-DOF arm with a parallel gripper, built from primitives.
import * as THREE from 'three';
import { ARM, BASE, GRIP } from './config.js';
import { LIMITS } from './ik.js';

const HALF_PI = Math.PI / 2;
const JOINTS = ['q1', 'q2', 'q3', 'q4', 'q5'];
const FINGER_T = 0.012;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const FOLDED = Object.freeze({ q1: 0, q2: -0.35, q3: 2.6, q4: 1.15, q5: 0 });

export class Arm {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'arm';
    this.root.position.set(BASE.x, 0, BASE.z);
    this.q = { ...FOLDED };
    this.qt = { ...FOLDED };
    this.qd = { q1: 0, q2: 0, q3: 0, q4: 0, q5: 0 };
    this.omega = 9;
    this.vmax = 3.0;
    this.gap = GRIP.open;
    this.gapT = GRIP.open;
    this._build();
    this.apply();
  }

  _mesh(geo, mat, parent, pos, rot) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(m);
    return m;
  }

  _build() {
    const M = this.materials = {
      shell: new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.36, metalness: 0.05 }),
      joint: new THREE.MeshStandardMaterial({ color: 0x252b30, roughness: 0.42, metalness: 0.4 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x15191c, roughness: 0.7, metalness: 0.15 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x76b900, emissive: 0x76b900, emissiveIntensity: 0.9, roughness: 0.4 }),
      status: new THREE.MeshStandardMaterial({ color: 0x76b900, emissive: 0x76b900, emissiveIntensity: 1.2, roughness: 0.3 }),
      pen: new THREE.MeshStandardMaterial({ color: 0x1b2025, roughness: 0.5, metalness: 0.3 }),
      penTip: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x76b900, emissiveIntensity: 2.0 }),
    };

    // pedestal
    this._mesh(new THREE.CylinderGeometry(0.096, 0.11, 0.03, 56), M.joint, this.root, [0, 0.015, 0]);
    this._mesh(new THREE.TorusGeometry(0.098, 0.0032, 8, 80), M.accent, this.root, [0, 0.03, 0], [HALF_PI, 0, 0]);

    // J1: turret (yaw)
    this.j1 = new THREE.Group();
    this.j1.position.y = 0.03;
    this.root.add(this.j1);
    this._mesh(new THREE.CylinderGeometry(0.064, 0.074, 0.095, 48), M.shell, this.j1, [0, 0.0475, 0]);
    this._mesh(new THREE.TorusGeometry(0.0655, 0.0028, 8, 64), M.accent, this.j1, [0, 0.095, 0], [HALF_PI, 0, 0]);

    // J2: shoulder (pitch about local x)
    this.shoulder = new THREE.Group();
    this.shoulder.position.y = ARM.H0 - 0.03;
    this.j1.add(this.shoulder);
    this._mesh(new THREE.CylinderGeometry(0.054, 0.054, 0.13, 40), M.joint, this.shoulder, [0, 0, 0], [0, 0, HALF_PI]);
    for (const s of [-1, 1]) {
      this._mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.006, 32), M.accent, this.shoulder, [s * 0.067, 0, 0], [0, 0, HALF_PI]);
    }
    this._mesh(new THREE.CapsuleGeometry(0.037, ARM.L1 - 0.074, 6, 24), M.shell, this.shoulder, [0, ARM.L1 / 2, 0]);

    // J3: elbow
    this.elbow = new THREE.Group();
    this.elbow.position.y = ARM.L1;
    this.shoulder.add(this.elbow);
    this._mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.112, 40), M.joint, this.elbow, [0, 0, 0], [0, 0, HALF_PI]);
    for (const s of [-1, 1]) {
      this._mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.005, 28), M.accent, this.elbow, [s * 0.058, 0, 0], [0, 0, HALF_PI]);
    }
    this._mesh(new THREE.CapsuleGeometry(0.031, ARM.L2 - 0.062, 6, 24), M.shell, this.elbow, [0, ARM.L2 / 2, 0]);

    // J4: wrist pitch
    this.wrist = new THREE.Group();
    this.wrist.position.y = ARM.L2;
    this.elbow.add(this.wrist);
    this._mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.088, 32), M.joint, this.wrist, [0, 0, 0], [0, 0, HALF_PI]);

    // J5: wrist roll + gripper (tool axis = local +y)
    this.roll = new THREE.Group();
    this.wrist.add(this.roll);
    this._mesh(new THREE.CylinderGeometry(0.03, 0.033, 0.026, 32), M.joint, this.roll, [0, 0.036, 0]);
    this.statusRing = this._mesh(new THREE.TorusGeometry(0.0335, 0.0032, 8, 48), M.status, this.roll, [0, 0.049, 0], [HALF_PI, 0, 0]);
    this._mesh(new THREE.BoxGeometry(0.104, 0.026, 0.046), M.shell, this.roll, [0, 0.061, 0]);
    this._mesh(new THREE.BoxGeometry(0.092, 0.004, 0.048), M.dark, this.roll, [0, 0.0745, 0]);

    this.fingers = [];
    for (const s of [-1, 1]) {
      const f = new THREE.Group();
      f.position.y = 0.074;
      this.roll.add(f);
      this._mesh(new THREE.BoxGeometry(FINGER_T, 0.05, 0.03), M.shell, f, [0, 0.025, 0]);
      this._mesh(new THREE.BoxGeometry(0.002, 0.034, 0.026), M.dark, f, [-s * (FINGER_T / 2 + 0.0005), 0.032, 0]);
      f.userData.side = s;
      this.fingers.push(f);
    }

    this.tcp = new THREE.Object3D();
    this.tcp.position.y = ARM.L3;
    this.roll.add(this.tcp);
    this.tip = new THREE.Object3D();
    this.tip.position.y = ARM.L3 + ARM.TIP;
    this.roll.add(this.tip);

    // Light pen used in imitation mode; its tip sits on the tool center point.
    this.pen = new THREE.Group();
    this.pen.visible = false;
    this.roll.add(this.pen);
    this._mesh(new THREE.CylinderGeometry(0.0062, 0.0062, 0.1, 20), M.pen, this.pen, [0, ARM.L3 - 0.062, 0]);
    this._mesh(new THREE.ConeGeometry(0.0062, 0.012, 20), M.pen, this.pen, [0, ARM.L3 - 0.006, 0]);
    this.penTip = this._mesh(new THREE.SphereGeometry(0.0042, 16, 12), M.penTip, this.pen, [0, ARM.L3, 0]);
    this.penTip.castShadow = false;
  }

  setTargets(t) {
    for (const k of JOINTS) {
      if (t[k] !== undefined && Number.isFinite(t[k])) this.qt[k] = clamp(t[k], LIMITS[k][0], LIMITS[k][1]);
    }
  }

  snap(q) {
    for (const k of JOINTS) {
      if (q[k] !== undefined) { this.q[k] = this.qt[k] = q[k]; this.qd[k] = 0; }
    }
    this.apply();
  }

  update(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    const w = this.omega;
    for (let i = 0; i < steps; i++) {
      for (const k of JOINTS) {
        const x = this.q[k];
        const a = w * w * (this.qt[k] - x) - 2 * w * this.qd[k];
        const v = clamp(this.qd[k] + a * h, -this.vmax, this.vmax);
        this.qd[k] = v;
        this.q[k] = x + v * h;
      }
    }
    this.gap += (this.gapT - this.gap) * (1 - Math.exp(-16 * dt));
    this.apply();
  }

  apply() {
    this.j1.rotation.y = this.q.q1;
    this.shoulder.rotation.x = this.q.q2;
    this.elbow.rotation.x = this.q.q3;
    this.wrist.rotation.x = this.q.q4;
    this.roll.rotation.y = this.q.q5;
    for (const f of this.fingers) f.position.x = f.userData.side * (this.gap / 2 + FINGER_T / 2);
  }

  /** Mean joint speed (rad/s); used to decide when the arm has settled. */
  speed() {
    return (Math.abs(this.qd.q1) + Math.abs(this.qd.q2) + Math.abs(this.qd.q3) + Math.abs(this.qd.q4)) / 4;
  }

  tcpWorld(out) { return this.tcp.getWorldPosition(out); }
  tipWorld(out) { return this.tip.getWorldPosition(out); }

  setStatusColor(hex) {
    this.materials.status.color.setHex(hex);
    this.materials.status.emissive.setHex(hex);
  }

  setPen(on) {
    this.pen.visible = on;
    this.gapT = on ? GRIP.pen : GRIP.open;
  }

  /** Carry a block between the fingers, centered on the tool center point. */
  attach(mesh) {
    this.roll.attach(mesh);
    mesh.position.copy(this.tcp.position);
  }
}
