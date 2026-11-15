// Analytic inverse kinematics for a yaw + 3-pitch arm with a wrist roll.
//
// Joints: q1 base yaw, q2 shoulder pitch, q3 elbow pitch, q4 wrist pitch, q5 wrist roll.
// Pitch angles are measured from vertical (up) toward the arm's forward direction, so the
// tool direction angle is q2 + q3 + q4 (PI means pointing straight down).
import { ARM } from './config.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const LIMITS = Object.freeze({
  q1: [-2.8, 2.8],
  q2: [-1.5, 1.8],
  q3: [-0.6, 2.9],
  q4: [-3.0, 3.0],
  q5: [-3.1, 3.1],
});

/**
 * Solve joint angles that put the tool center point at `target` with the tool
 * pointing along `toolAngle` (in the arm's vertical plane). Elbow-up solution.
 * Unreachable targets are projected onto the reachable shell; `out.reachable` reports it.
 */
export function solveIK(target, base, toolAngle = Math.PI, out = {}) {
  const dx = target.x - base.x;
  const dz = target.z - base.z;
  const r = Math.hypot(dx, dz);
  out.q1 = r > 1e-5 ? Math.atan2(dx, dz) : (out.q1 ?? 0);

  let wr = r - ARM.L3 * Math.sin(toolAngle);
  let wy = target.y - ARM.L3 * Math.cos(toolAngle) - ARM.H0;
  let d = Math.hypot(wr, wy);
  const dMax = ARM.L1 + ARM.L2 - 1e-3;
  const dMin = Math.abs(ARM.L1 - ARM.L2) + 0.04;
  out.reachable = true;
  if (d > dMax) {
    const s = dMax / d;
    wr *= s; wy *= s; d = dMax;
    out.reachable = false;
  } else if (d < dMin) {
    if (d < 1e-6) { wr = dMin; wy = 0; } else { const s = dMin / d; wr *= s; wy *= s; }
    d = dMin;
    out.reachable = false;
  }

  const phi = Math.atan2(wr, wy);
  const alpha = Math.acos(clamp((ARM.L1 * ARM.L1 + d * d - ARM.L2 * ARM.L2) / (2 * ARM.L1 * d), -1, 1));
  const beta = Math.acos(clamp((ARM.L1 * ARM.L1 + ARM.L2 * ARM.L2 - d * d) / (2 * ARM.L1 * ARM.L2), -1, 1));
  out.q2 = phi - alpha;
  out.q3 = Math.PI - beta;
  out.q4 = toolAngle - out.q2 - out.q3;
  return out;
}

/** Forward kinematics in the arm plane: tool center point (r, y) relative to the base. */
export function forwardPlanar(q2, q3, q4) {
  const a1 = q2, a2 = q2 + q3, a3 = q2 + q3 + q4;
  return {
    r: ARM.L1 * Math.sin(a1) + ARM.L2 * Math.sin(a2) + ARM.L3 * Math.sin(a3),
    y: ARM.H0 + ARM.L1 * Math.cos(a1) + ARM.L2 * Math.cos(a2) + ARM.L3 * Math.cos(a3),
  };
}
