// Rearrangement planner for autonomous mode: restore every letter block to its home mark.
// Each call returns a single pick-and-place operation { block, to: {x, z} }, or null when done.
import { BASE, BLOCK, REACH } from './config.js';

const CLEAR = BLOCK + 0.008;

function homeFree(world, b) {
  return world.floorFree(b.home.x, b.home.z, b);
}

/** Closest reachable floor spot that is free and keeps every home mark clear. */
export function bufferSpot(world, block, from) {
  let best = null;
  let bestD = Infinity;
  for (let pass = 0; pass < 2 && !best; pass++) {
    const avoidHomes = pass === 0;
    for (let x = -0.33; x <= 0.331; x += 0.055) {
      for (let z = -0.12; z <= 0.24; z += 0.055) {
        const r = Math.hypot(x - BASE.x, z - BASE.z);
        if (r < REACH.min + 0.06 || r > REACH.max - 0.04) continue;
        if (world.blocks.some((o) => o !== block && !o.held && Math.abs(o.mesh.position.x - x) < CLEAR && Math.abs(o.mesh.position.z - z) < CLEAR)) continue;
        if (avoidHomes && world.blocks.some((o) => Math.abs(o.home.x - x) < CLEAR && Math.abs(o.home.z - z) < CLEAR)) continue;
        const d = Math.hypot(x - from.x, z - from.z);
        if (d < bestD) { bestD = d; best = { x, z }; }
      }
    }
  }
  return best;
}

export function nextRestoreOp(world, holding, tcp) {
  const blocks = world.blocks;

  // 1. Put down whatever the gripper holds.
  if (holding) {
    if (homeFree(world, holding)) return { block: holding, to: { x: holding.home.x, z: holding.home.z }, why: 'home' };
    const spot = bufferSpot(world, holding, tcp);
    return spot ? { block: holding, to: spot, why: 'buffer' } : null;
  }

  // 2. Unstack: move the highest stacked block (always the top of its column).
  const stacked = blocks.filter((b) => !b.held && b.mesh.position.y > BLOCK * 0.75).sort((a, b) => b.mesh.position.y - a.mesh.position.y);
  if (stacked.length) {
    const b = stacked[0];
    if (homeFree(world, b)) return { block: b, to: { x: b.home.x, z: b.home.z }, why: 'unstack-home' };
    const spot = bufferSpot(world, b, b.mesh.position);
    if (spot) return { block: b, to: spot, why: 'unstack' };
  }

  // 3. Restore in reading order, clearing any block that sits on a home mark.
  for (const b of blocks) {
    if (world.inPlace(b)) continue;
    const occupant = blocks.find((o) => o !== b && !o.held && world.overlaps(o, b.home.x, b.home.z));
    if (occupant) {
      if (homeFree(world, occupant)) return { block: occupant, to: { x: occupant.home.x, z: occupant.home.z }, why: 'clear-home' };
      const spot = bufferSpot(world, occupant, occupant.mesh.position);
      if (spot) return { block: occupant, to: spot, why: 'clear' };
      continue;
    }
    return { block: b, to: { x: b.home.x, z: b.home.z }, why: 'home' };
  }
  return null;
}
