/**
 * VoxelTrail.js
 * "Digital Fragment" trail attached to shed voxel debris for ~1 second.
 *
 * Each shed voxel registers a TrailEmitter that polls its Rapier body
 * position via a lightweight getter function (no Rapier import needed here).
 * Every EMIT_INTERVAL seconds a new "puff" of static square-point particles
 * is spawned at the body's current position, tracing a visible digital path.
 *
 * Rendering: square sprites, neon-cyan, additive blending, fades over PUFF_TTL.
 */

import * as THREE from 'three';

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_PUFFS    = 512;   // total pooled puff particles
const PUFF_TTL     = 0.6;   // seconds a puff stays visible
const EMIT_INTERVAL= 0.05;  // seconds between puff emissions per debris piece
const TRAIL_LIFE   = 1.0;   // seconds to keep emitting for one voxel
const PUFFS_PER_EMIT = 6;   // particles per emission tick

// ── Square-sprite shader ──────────────────────────────────────────────────────
const _vert = /* glsl */`
  attribute float aLife;
  attribute float aSize;
  varying   float vLife;
  void main() {
    vLife = aLife;
    float alive = step(aLife, 0.9999);
    float sz = aSize * (1.0 - aLife) * alive;
    vec4 mv  = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = sz * (280.0 / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
`;

const _frag = /* glsl */`
  uniform vec3 uColor;
  varying float vLife;
  void main() {
    // Square mask: keep whole point-sprite region
    vec2 d = abs(gl_PointCoord - 0.5);
    if (max(d.x, d.y) > 0.48) discard;
    float alpha = (1.0 - vLife) * 0.75;
    // Slight flicker using gl_FragCoord for a "digital glitch" feel
    float flicker = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    alpha *= 0.8 + 0.2 * flicker;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

export class VoxelTrail {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this._scene = scene;

    // ── Per-puff typed arrays ───────────────────────────────────────────────
    this._pos    = new Float32Array(MAX_PUFFS * 3);
    this._life   = new Float32Array(MAX_PUFFS);     // 0→1
    this._invTTL = new Float32Array(MAX_PUFFS);
    this._sizes  = new Float32Array(MAX_PUFFS);

    this._head = 0; // circular allocator

    // ── BufferGeometry ──────────────────────────────────────────────────────
    const geo = new THREE.BufferGeometry();
    this._posAttr  = new THREE.BufferAttribute(this._pos,  3);
    this._lifeAttr = new THREE.BufferAttribute(this._life, 1);
    this._sizeAttr = new THREE.BufferAttribute(this._sizes,1);
    this._posAttr.setUsage(THREE.DynamicDrawUsage);
    this._lifeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._posAttr);
    geo.setAttribute('aLife',    this._lifeAttr);
    geo.setAttribute('aSize',    this._sizeAttr);
    geo.setDrawRange(0, MAX_PUFFS);

    // ── Material ────────────────────────────────────────────────────────────
    this._mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0x00ffcc) } },
      vertexShader:   _vert,
      fragmentShader: _frag,
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    this._points = new THREE.Points(geo, this._mat);
    this._points.frustumCulled = false;
    this._points.renderOrder   = 2;
    scene.add(this._points);

    /**
     * Active trail emitters.
     * @type {{ getPos: ()=>{x,y,z}|null, age: number, emitTimer: number }[]}
     */
    this._emitters = [];
  }

  /**
   * Register a new trail emitter for a freshly shed voxel.
   * @param {()=>{x:number,y:number,z:number}|null} getPos
   *   Closure that returns the current world position of the debris body,
   *   or null if the body has been removed.
   */
  addEmitter(getPos) {
    this._emitters.push({ getPos, age: 0, emitTimer: 0 });
  }

  /**
   * Advance all emitters and puff particles by dt.
   * @param {number} dt
   */
  update(dt) {
    // ── Advance emitters ────────────────────────────────────────────────────
    let ei = this._emitters.length;
    while (ei--) {
      const em = this._emitters[ei];
      em.age       += dt;
      em.emitTimer -= dt;

      if (em.age > TRAIL_LIFE) {
        this._emitters.splice(ei, 1);
        continue;
      }

      if (em.emitTimer <= 0) {
        em.emitTimer = EMIT_INTERVAL;
        const p = em.getPos();
        if (p) this._emitPuff(p.x, p.y, p.z);
      }
    }

    // ── Advance puffs ───────────────────────────────────────────────────────
    let anyAlive = false;
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (this._life[i] >= 1) continue;
      anyAlive = true;
      this._life[i] = Math.min(1, this._life[i] + dt * this._invTTL[i]);
    }

    if (anyAlive || this._emitters.length > 0) {
      this._lifeAttr.needsUpdate = true;
    }
  }

  /** @private */
  _emitPuff(ox, oy, oz) {
    for (let k = 0; k < PUFFS_PER_EMIT; k++) {
      const s = this._head % MAX_PUFFS;
      this._head++;

      this._pos[s * 3]     = ox + (Math.random() - 0.5) * 0.18;
      this._pos[s * 3 + 1] = oy + (Math.random() - 0.5) * 0.18;
      this._pos[s * 3 + 2] = oz + (Math.random() - 0.5) * 0.18;

      this._life[s]    = 0;
      this._invTTL[s]  = 1 / (PUFF_TTL * (0.7 + Math.random() * 0.6));
      this._sizes[s]   = 2 + Math.random() * 3;
    }
    this._posAttr.needsUpdate  = true;
    this._sizeAttr.needsUpdate = true;
  }

  dispose() {
    this._points.parent?.remove(this._points);
    this._points.geometry.dispose();
    this._mat.dispose();
  }
}
