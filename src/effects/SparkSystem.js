/**
 * SparkSystem.js
 * GPU-friendly particle spark bursts using THREE.Points with a custom shader.
 *
 * Design:
 *  - Single BufferGeometry pre-allocated to MAX_SPARKS.
 *  - Active sparks are tracked with a circular-index allocator.
 *  - CPU-side Euler integration (position, velocity, gravity).
 *  - Per-spark size and life encoded as BufferAttributes uploaded each frame.
 *  - Additive blending for the "neon glow" look; depth-write off so sparks
 *    composite correctly over all opaque geometry.
 */

import * as THREE from 'three';

const MAX_SPARKS = 1024;
const GRAVITY    = -14.0;  // m/s² (slightly exaggerated for drama)
const FLOOR_Y    = 0.02;   // floor height

// ── Custom shader — per-spark fade + size ─────────────────────────────────────
const _vert = /* glsl */`
  attribute float aLife;   // 0 = newborn → 1 = dead
  attribute float aSize;   // initial screen-space diameter (px)
  varying   float vLife;

  void main() {
    vLife = aLife;
    float alive = step(aLife, 0.9999);
    // Shrink over lifetime; snap to zero when dead
    float sz = aSize * (1.0 - aLife * 0.7) * alive;
    vec4 mvp = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = sz * (300.0 / -mvp.z);
    gl_Position  = projectionMatrix * mvp;
  }
`;

const _frag = /* glsl */`
  uniform vec3  uColor;
  uniform float uBrightness;
  varying float vLife;

  void main() {
    // Soft circular point
    vec2  d    = gl_PointCoord - 0.5;
    float dist = dot(d, d) * 4.0;
    if (dist > 1.0) discard;
    float alpha = (1.0 - vLife) * (1.0 - dist * dist) * uBrightness;
    // Inner core brighter
    float core  = 1.0 - smoothstep(0.0, 0.25, dist);
    gl_FragColor = vec4(uColor + core * 0.4, alpha);
  }
`;

export class SparkSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object}      [opts]
   * @param {THREE.Color|number} [opts.color]      neon blue by default
   * @param {number}             [opts.brightness] 0–1, default 1
   */
  constructor(scene, opts = {}) {
    // ── Typed data arrays ───────────────────────────────────────────────────
    this._positions = new Float32Array(MAX_SPARKS * 3); // world x,y,z
    this._velocities= new Float32Array(MAX_SPARKS * 3); // m/s
    this._life      = new Float32Array(MAX_SPARKS);     // 0→1
    this._invTTL    = new Float32Array(MAX_SPARKS);     // 1/lifespan
    this._sizes     = new Float32Array(MAX_SPARKS);     // px

    // Circular write head — wraps to reuse old, dead spark slots
    this._head = 0;

    // ── BufferGeometry ──────────────────────────────────────────────────────
    const geo = new THREE.BufferGeometry();

    this._posAttr  = new THREE.BufferAttribute(this._positions, 3);
    this._lifeAttr = new THREE.BufferAttribute(this._life,      1);
    this._sizeAttr = new THREE.BufferAttribute(this._sizes,     1);

    this._posAttr.setUsage(THREE.DynamicDrawUsage);
    this._lifeAttr.setUsage(THREE.DynamicDrawUsage);

    geo.setAttribute('position', this._posAttr);
    geo.setAttribute('aLife',    this._lifeAttr);
    geo.setAttribute('aSize',    this._sizeAttr);
    // Draw all slots; dead sparks are invisible via gl_PointSize = 0
    geo.setDrawRange(0, MAX_SPARKS);

    // ── Material ────────────────────────────────────────────────────────────
    const col = opts.color instanceof THREE.Color
      ? opts.color.clone()
      : new THREE.Color(opts.color ?? 0x00f0ff);

    this._mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor:      { value: col },
        uBrightness: { value: opts.brightness ?? 1.0 },
      },
      vertexShader:   _vert,
      fragmentShader: _frag,
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    this._points = new THREE.Points(geo, this._mat);
    this._points.frustumCulled = false; // sparks can fly anywhere
    this._points.renderOrder   = 2;
    scene.add(this._points);
  }

  /**
   * Emit 20–50 sparks at a world-space impact point.
   * @param {THREE.Vector3} origin     - contact point
   * @param {number}        impulse    - scales count and burst speed
   * @param {{x,y,z}}       [carVel]  - inherit car linear velocity
   */
  burst(origin, impulse, carVel = { x: 0, y: 0, z: 0 }) {
    const count     = Math.min(Math.floor(20 + impulse * 0.6), 50);
    const burstSpd  = Math.min(2.5 + impulse * 0.06, 12);

    for (let i = 0; i < count; i++) {
      const s = this._head % MAX_SPARKS;
      this._head++;

      // Position: at contact + micro-jitter so sparks don't z-fight
      this._positions[s * 3]     = origin.x + (Math.random() - 0.5) * 0.08;
      this._positions[s * 3 + 1] = origin.y + (Math.random() - 0.5) * 0.08;
      this._positions[s * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.08;

      // Velocity: car velocity (40% inheritance) + spherical random burst
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1); // uniform sphere
      const bx    = Math.sin(phi) * Math.cos(theta) * burstSpd;
      const by    = Math.abs(Math.cos(phi))          * burstSpd * 1.4; // up bias
      const bz    = Math.sin(phi) * Math.sin(theta)  * burstSpd;

      this._velocities[s * 3]     = carVel.x * 0.4 + bx;
      this._velocities[s * 3 + 1] = carVel.y * 0.4 + by;
      this._velocities[s * 3 + 2] = carVel.z * 0.4 + bz;

      // Lifespan: 0.25 – 0.55 s (heavier hits → longer trails)
      const ttl = 0.25 + Math.random() * 0.3 + impulse * 0.001;
      this._invTTL[s]  = 1 / ttl;
      this._life[s]    = 0;
      this._sizes[s]   = 3.5 + Math.random() * 4;
    }

    // Upload size changes on burst (infrequent; cost is small)
    this._sizeAttr.needsUpdate = true;
  }

  /**
   * Advance all spark positions and lifetimes by dt seconds.
   * Uploads changed GPU buffers only when at least one spark is alive.
   * @param {number} dt
   */
  update(dt) {
    let anyAlive = false;

    for (let s = 0; s < MAX_SPARKS; s++) {
      if (this._life[s] >= 1) continue;
      anyAlive = true;

      // Gravity + Euler integration
      this._velocities[s * 3 + 1] += GRAVITY * dt;
      this._positions [s * 3]     += this._velocities[s * 3]     * dt;
      this._positions [s * 3 + 1] += this._velocities[s * 3 + 1] * dt;
      this._positions [s * 3 + 2] += this._velocities[s * 3 + 2] * dt;

      // Bounce off floor with damping
      if (this._positions[s * 3 + 1] < FLOOR_Y) {
        this._positions [s * 3 + 1]  = FLOOR_Y;
        this._velocities[s * 3 + 1] *= -0.25;
        // Also bleed off horizontal velocity on bounce
        this._velocities[s * 3]     *= 0.6;
        this._velocities[s * 3 + 2] *= 0.6;
      }

      // Advance life
      this._life[s] = Math.min(1, this._life[s] + dt * this._invTTL[s]);
    }

    if (anyAlive) {
      this._posAttr.needsUpdate  = true;
      this._lifeAttr.needsUpdate = true;
    }
  }

  dispose() {
    this._points.parent?.remove(this._points);
    this._points.geometry.dispose();
    this._mat.dispose();
  }
}
