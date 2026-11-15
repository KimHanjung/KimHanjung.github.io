// Shared workcell dimensions, in meters. The robot base sits behind the letter blocks.
export const ARM = Object.freeze({
  H0: 0.155,   // shoulder axis height above the floor
  L1: 0.28,    // shoulder -> elbow
  L2: 0.25,    // elbow -> wrist
  L3: 0.105,   // wrist axis -> tool center point (between the fingers)
  TIP: 0.019,  // tool center point -> fingertip end
});

export const BASE = Object.freeze({ x: 0, z: -0.22 });

export const BLOCK = 0.044;        // block edge length
export const BLOCK_GAP = 0.008;    // gap between neighbouring blocks in a row
export const ROW_GAP = 0.052;      // gap between rows
export const ROW_Z0 = 0.06;        // z of the first row

export const HOVER_CLEAR = 0.075;  // tool center height above the surface under the cursor
export const TRAVEL_Y = 0.17;      // minimum carrying height in autonomous mode
export const DRAW_Y = 0.12;        // height of the imitation drawing plane
export const REACH = Object.freeze({ min: 0.15, max: 0.49 });

export const GRIP = Object.freeze({ open: 0.072, block: BLOCK + 0.003, pen: 0.015, empty: 0.008 });

export const READY = Object.freeze({ r: 0.25, y: 0.25, tool: Math.PI * 0.74 });

export const SKILL_COLORS = ['#76b900', '#3fd2e6', '#ffb547', '#c084fc', '#ff7a7a', '#5eead4', '#facc15', '#93c5fd'];
