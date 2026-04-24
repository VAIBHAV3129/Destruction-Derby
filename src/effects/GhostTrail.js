/**
 * GhostTrail.js
 * Speed-activated "ghost" effect: renders N translucent wireframe
 * imprints of the car at previous frame positions.
 *
 * Activated when speed exceeds SPEED_THRESHOLD (m/s).
 * Uses a ring buffer of (position, quaternion) snapshots sampled
 * every RECORD_EVERY frames. Each ghost is a THREE.LineSegments
 * (EdgesGeometry of a car-sized box) with decreasing opacity.
 */

import * as THREE from 'three';

const GHOST_COUNT      = 5;    // number of trailing ghosts
const RECORD_EVERY     = 3;    // sample every N frames (≈20 Hz at 60 FPS)
const SPEED_THRESHOLD  = 22;   // m/s — below this, ghosts are hidden
const SPEED_FADE_RANGE = 8;    // m/s over which ghosts fade in
const GHOST_MAX_OPACITY= 0.28; // opacity of the freshest ghost
const GHOST_COLOR      = 0x00f0ff;

// Approximate car bounding box (width × height × depth)
const CAR_W = 2.0, CAR_H = 0.9, CAR_D = 4.0;

export class GhostTrail {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this._scene      = scene;
    this._frameCount = 0;

    // Ring buffer: { pos: Vector3, quat: Quaternion }[]
    this._snapshots  = [];
    for (let i = 0; i < GHOST_COUNT * RECORD_EVERY + 1; i++) {
      this._snapshots.push({
        pos:  new THREE.Vector3(),
        quat: new THREE.Quaternion(),
      });
    }
    this._snapHead = 0; // next write index
    this._snapSize = 0; // number of valid entries

    // ── Ghost meshes ────────────────────────────────────────────────────────
    const boxGeo   = new THREE.BoxGeometry(CAR_W, CAR_H, CAR_D);
    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose(); // only need edges

    /** @type {THREE.LineSegments[]} */
    this._ghosts = [];

    for (let g = 0; g < GHOST_COUNT; g++) {
      const mat = new THREE.LineBasicMaterial({
        color:       GHOST_COLOR,
        transparent: true,
        opacity:     0,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
      });
      const ghost = new THREE.LineSegments(edgesGeo, mat);
      ghost.visible = false;
      scene.add(ghost);
      this._ghosts.push(ghost);
    }

    this._edgesGeo = edgesGeo; // keep ref for disposal
  }

  /**
   * Call once per frame from the main update loop.
   * @param {THREE.Vector3}    carPos
   * @param {THREE.Quaternion} carQuat
   * @param {number}           speed   — car speed in m/s
   */
  update(carPos, carQuat, speed) {
    this._frameCount++;

    // ── Record snapshot ──────────────────────────────────────────────────
    if (this._frameCount % RECORD_EVERY === 0) {
      const slot = this._snapshots[this._snapHead % this._snapshots.length];
      slot.pos.copy(carPos);
      slot.quat.copy(carQuat);
      this._snapHead++;
      this._snapSize = Math.min(this._snapSize + 1, this._snapshots.length);
    }

    // ── Compute global fade factor from speed ────────────────────────────
    const speedExcess = speed - SPEED_THRESHOLD;
    const fade = Math.max(0, Math.min(1, speedExcess / SPEED_FADE_RANGE));

    if (fade <= 0) {
      // Hide all ghosts when below threshold
      for (const g of this._ghosts) g.visible = false;
      return;
    }

    // ── Position ghosts at past snapshots ────────────────────────────────
    for (let g = 0; g < GHOST_COUNT; g++) {
      const ghost = this._ghosts[g];

      // Each ghost looks RECORD_EVERY * (g+1) frames into the past
      const lookBack = (g + 1) * RECORD_EVERY;
      if (lookBack > this._snapSize) {
        ghost.visible = false;
        continue;
      }

      const snapIdx  = ((this._snapHead - lookBack - 1) % this._snapshots.length + this._snapshots.length) % this._snapshots.length;
      const snap     = this._snapshots[snapIdx];

      ghost.position.copy(snap.pos);
      ghost.quaternion.copy(snap.quat);
      ghost.visible = true;

      // Opacity: freshest ghost is most opaque; oldest is most transparent
      const ageFraction = (g + 1) / GHOST_COUNT; // 0.2 … 1.0
      /** @type {THREE.LineBasicMaterial} */
      const mat = /** @type {any} */ (ghost.material);
      mat.opacity = GHOST_MAX_OPACITY * (1 - ageFraction * 0.85) * fade;
    }
  }

  dispose() {
    for (const g of this._ghosts) {
      this._scene.remove(g);
      g.material.dispose();
    }
    this._edgesGeo.dispose();
  }
}
