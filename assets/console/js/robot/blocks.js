// Letter blocks on the table: layout, stacking queries, gravity and highlighting.
import * as THREE from 'three';
import { BLOCK, BLOCK_GAP, ROW_GAP, ROW_Z0 } from './config.js';

const EPS = 1e-4;
const GRAVITY = 9.81;

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function faceTexture(letter, anisotropy) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f2f5f0';
  g.fillRect(0, 0, 256, 256);
  g.lineWidth = 12;
  g.strokeStyle = '#5fae0a';
  roundRect(g, 16, 16, 224, 224, 26);
  g.stroke();
  if (letter) {
    g.fillStyle = '#4b9900';
    g.font = '600 168px "IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const m = g.measureText(letter);
    const asc = m.actualBoundingBoxAscent || 120;
    const desc = m.actualBoundingBoxDescent || 0;
    g.fillText(letter, 128, 128 + (asc - desc) / 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

export class BlockWorld {
  constructor(scene, rows, anisotropy = 4) {
    this.group = new THREE.Group();
    this.group.name = 'blocks';
    scene.add(this.group);
    this.blocks = [];
    this.onLand = null;

    const geo = new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK);
    const sideTex = faceTexture('', anisotropy);
    const pitch = BLOCK + BLOCK_GAP;
    rows.forEach((row, r) => {
      const letters = [...row];
      letters.forEach((ch, i) => {
        const home = new THREE.Vector3((i - (letters.length - 1) / 2) * pitch, BLOCK / 2, ROW_Z0 + r * (BLOCK + ROW_GAP));
        const mk = (map) => new THREE.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0, emissive: 0x76b900, emissiveIntensity: 0 });
        const side = mk(sideTex);
        const top = mk(sideTex);
        const front = mk(faceTexture(ch, anisotropy));
        // BoxGeometry material order: +x, -x, +y, -y, +z, -z (the lettered front faces the camera)
        const mesh = new THREE.Mesh(geo, [side, side, top, side, front, side]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.copy(home);
        mesh.name = `block-${ch}`;
        this.group.add(mesh);
        const block = { id: this.blocks.length, letter: ch, mesh, home, held: false, falling: false, vy: 0, delay: 0, mats: [side, top, front] };
        mesh.userData.block = block;
        this.blocks.push(block);
      });
    });

    // floor marks at each home position (tape squares)
    const marks = [];
    const h = BLOCK / 2 + 0.004;
    for (const b of this.blocks) {
      const { x, z } = b.home;
      marks.push(x - h, 0, z - h, x + h, 0, z - h, x + h, 0, z - h, x + h, 0, z + h, x + h, 0, z + h, x - h, 0, z + h, x - h, 0, z + h, x - h, 0, z - h);
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(marks, 3));
    this.markMaterial = new THREE.LineBasicMaterial({ color: 0x76b900, transparent: true, opacity: 0.35 });
    this.marks = new THREE.LineSegments(mg, this.markMaterial);
    this.marks.position.y = 0.0012;
    scene.add(this.marks);
  }

  get total() { return this.blocks.length; }

  pickables() {
    return this.blocks.filter((b) => !b.held).map((b) => b.mesh);
  }

  overlaps(b, x, z, margin = BLOCK) {
    const p = b.mesh.position;
    return Math.abs(p.x - x) < margin - EPS && Math.abs(p.z - z) < margin - EPS;
  }

  /** Height of the highest resting surface whose footprint intersects a block-sized footprint at (x, z). */
  supportTop(x, z, exclude = null) {
    let top = 0;
    for (const b of this.blocks) {
      if (b === exclude || b.held || b.falling) continue;
      if (this.overlaps(b, x, z)) top = Math.max(top, b.mesh.position.y + BLOCK / 2);
    }
    return top;
  }

  maxTop() {
    let top = 0;
    for (const b of this.blocks) if (!b.held) top = Math.max(top, b.mesh.position.y + BLOCK / 2);
    return top;
  }

  /** The block resting on top of the column nearest (x, z), if any. */
  topBlockAt(x, z, tol = BLOCK * 0.6) {
    let best = null;
    let bestD = Infinity;
    for (const b of this.blocks) {
      if (b.held || b.falling) continue;
      const p = b.mesh.position;
      const dx = Math.abs(p.x - x);
      const dz = Math.abs(p.z - z);
      if (dx > tol || dz > tol) continue;
      const d = Math.hypot(dx, dz);
      if (!best || p.y > best.mesh.position.y + EPS || (Math.abs(p.y - best.mesh.position.y) < EPS && d < bestD)) {
        best = b;
        bestD = d;
      }
    }
    if (!best) return null;
    // walk up the column in case another block sits on it
    let top = best;
    for (let guard = 0; guard < this.blocks.length; guard++) {
      const above = this.blocks.find((o) => o !== top && !o.held && !o.falling && this.overlaps(o, top.mesh.position.x, top.mesh.position.z) && o.mesh.position.y > top.mesh.position.y + EPS);
      if (!above) break;
      top = above;
    }
    return top;
  }

  isTop(b) {
    const p = b.mesh.position;
    return !this.blocks.some((o) => o !== b && !o.held && this.overlaps(o, p.x, p.z) && o.mesh.position.y > p.y + EPS);
  }

  /** Where a carried block would come to rest if released over (x, z): on top of a column (aligned) or on the floor. */
  placementFor(x, z, carried = null, out = new THREE.Vector3()) {
    let support = null;
    for (const b of this.blocks) {
      if (b === carried || b.held || b.falling) continue;
      if (!this.overlaps(b, x, z)) continue;
      if (!support || b.mesh.position.y > support.mesh.position.y) support = b;
    }
    if (support) {
      const p = support.mesh.position;
      return out.set(p.x, p.y + BLOCK, p.z);
    }
    return out.set(x, BLOCK / 2, z);
  }

  /** True when no other block occupies the footprint at (x, z) on the floor. */
  floorFree(x, z, ignore = null) {
    return !this.blocks.some((b) => b !== ignore && !b.held && this.overlaps(b, x, z));
  }

  release(b, at) {
    b.held = false;
    this.group.attach(b.mesh);
    b.mesh.position.copy(at);
    b.mesh.rotation.set(0, 0, 0);
    b.falling = true;
    b.vy = 0;
  }

  update(dt) {
    for (const b of this.blocks) {
      if (b.delay > 0) {
        b.delay -= dt;
        if (b.delay <= 0) b.mesh.visible = true;
        continue;
      }
      if (!b.falling || b.held) continue;
      const p = b.mesh.position;
      const rest = this.supportTop(p.x, p.z, b) + BLOCK / 2;
      b.vy += GRAVITY * dt;
      p.y -= b.vy * dt;
      if (p.y <= rest) {
        const impact = b.vy;
        p.y = rest;
        b.vy = 0;
        b.falling = false;
        if (this.onLand) this.onLand(b, impact);
      }
    }
  }

  inPlace(b) {
    if (b.held || b.falling) return false;
    const p = b.mesh.position;
    return Math.abs(p.x - b.home.x) < 0.004 && Math.abs(p.z - b.home.z) < 0.004 && Math.abs(p.y - b.home.y) < 0.004;
  }

  inPlaceCount() {
    let n = 0;
    for (const b of this.blocks) if (this.inPlace(b)) n++;
    return n;
  }

  setHighlight(block) {
    for (const b of this.blocks) {
      const v = b === block ? 0.28 : 0;
      for (const m of b.mats) m.emissiveIntensity = v;
    }
  }

  /** Drop every block onto its home mark, staggered (power-on animation). */
  spawn(animate = true) {
    this.blocks.forEach((b, i) => {
      b.mesh.position.copy(b.home);
      b.vy = 0;
      if (animate) {
        b.mesh.position.y = b.home.y + 0.3 + (i % 4) * 0.02;
        b.mesh.visible = false;
        b.delay = 0.05 + i * 0.075;
        b.falling = true;
      } else {
        b.mesh.visible = true;
        b.delay = 0;
        b.falling = false;
      }
    });
  }

  hideAll() {
    for (const b of this.blocks) b.mesh.visible = false;
  }

  setMarkColor(hex, opacity) {
    this.markMaterial.color.setHex(hex);
    this.markMaterial.opacity = opacity;
  }
}
