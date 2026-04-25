/**
 * Vehicle.js
 * 4-wheel arcade raycast-vehicle controller using Rapier raycasts for suspension.
 *
 * Each wheel fires a downward ray from its anchor point. Spring force is applied
 * proportional to compression, with separate stiffness / damping / compression
 * coefficients. A friction-circle model limits combined lateral+longitudinal grip.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

// ─── Reusable scratch allocations (avoid per-frame GC pressure) ───────────────
const _rayOrigin = new THREE.Vector3();
const _down = { x: 0, y: -1, z: 0 };
const _worldPos = new THREE.Vector3();
const _bodyPos = new THREE.Vector3();
const _bodyQuat = new THREE.Quaternion();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Suspension spring parameters
 * @typedef {Object} SuspensionConfig
 * @property {number} restLength   - natural spring length (m)
 * @property {number} stiffness    - spring constant (N/m)
 * @property {number} damping      - damping ratio
 * @property {number} compression  - extra resistance on compression
 * @property {number} travelLimit  - max compression / extension (m)
 */

/**
 * Single wheel descriptor
 * @typedef {Object} WheelConfig
 * @property {THREE.Vector3} localPos - anchor in vehicle local space
 * @property {number} radius          - wheel radius (m)
 */

export class Vehicle {
  /**
   * @param {import('../physics/PhysicsManager').PhysicsManager} physics
   * @param {Object} [opts]
   * @param {number} [opts.mass]
   * @param {number} [opts.engineForce]       - max drive force (N)
   * @param {number} [opts.brakeForce]        - max brake force (N)
   * @param {number} [opts.maxSteerAngle]     - radians
   * @param {number} [opts.lateralStiffness]  - friction circle lateral coefficient
   * @param {SuspensionConfig} [opts.suspension]
   */
  constructor(physics, opts = {}) {
    this.physics = physics;

    // ── Vehicle tunables ─────────────────────────────────────────────────────
    this.mass          = opts.mass          ?? 800;       // kg
    this.engineForce   = opts.engineForce   ?? 4000;      // N
    this.brakeForce    = opts.brakeForce    ?? 6000;      // N
    this.maxSteerAngle = opts.maxSteerAngle ?? 0.45;      // ~26 deg
    this.lateralStiffness = opts.lateralStiffness ?? 12.0;

    /** @type {SuspensionConfig} */
    this.suspension = Object.assign({
      restLength:  0.35,
      stiffness:   22000,
      damping:     2200,
      compression: 2600,
      travelLimit: 0.25,
    }, opts.suspension);

    // ── Wheel layout ─────────────────────────────────────────────────────────
    const wr = 0.35; // wheel radius
    /** @type {WheelConfig[]} */
    this.wheels = [
      { localPos: new THREE.Vector3(-0.9, -0.1,  1.4), radius: wr }, // FL
      { localPos: new THREE.Vector3( 0.9, -0.1,  1.4), radius: wr }, // FR
      { localPos: new THREE.Vector3(-0.9, -0.1, -1.4), radius: wr }, // RL
      { localPos: new THREE.Vector3( 0.9, -0.1, -1.4), radius: wr }, // RR
    ];

    /** Per-wheel runtime state */
    this.wheelState = this.wheels.map(() => ({
      compression: 0,      // current spring compression (m)
      prevComp:    0,      // previous frame compression (for damping)
      onGround:    false,
    }));

    // ── Control inputs (set externally each frame) ───────────────────────────
    this.controls = { throttle: 0, brake: 0, steer: 0 };

    // ── Physics body (created in init) ───────────────────────────────────────
    this.body = null;
    this.collider = null;
  }

  /**
   * Create the physics body for this vehicle.
   * @param {{x:number,y:number,z:number}} spawnPos
   */
  init(spawnPos) {
    // Enable CCD on player vehicle to prevent tunnelling at high speeds
    this.body = this.physics.createDynamicBody(spawnPos, null, true);

    // Lower centre of mass for stability
    this.body.setAdditionalMass(this.mass);
    this.body.setAdditionalCenterOfMass({ x: 0, y: -0.5, z: 0 }, true);
    // Set inertia tensor for realistic yaw
    this.body.setAdditionalMassProperties(
      this.mass,
      { x: 0, y: -0.3, z: 0 },
      { x: 800, y: 600, z: 400 },
      { x: 0, y: 0, z: 0, w: 1 },
      true
    );

    this.collider = this.physics.addBoxCollider(
      this.body,
      { x: 1.0, y: 0.45, z: 2.0 },
      0.75,   // friction (tyre on asphalt ≈ 0.7–0.8)
      0.1,    // low restitution – cars don't bounce much
      true    // active collision events
    );
  }

  /**
   * Update vehicle physics for one frame.
   * @param {number} dt
   */
  update(dt) {
    if (!this.body) return;

    const t = this.body.translation();
    const r = this.body.rotation();

    _bodyPos.set(t.x, t.y, t.z);
    _bodyQuat.set(r.x, r.y, r.z, r.w);

    // Derive orientation axes from body quaternion
    _forward.set(0, 0, 1).applyQuaternion(_bodyQuat);
    _right.set(1, 0, 0).applyQuaternion(_bodyQuat);
    _up.set(0, 1, 0).applyQuaternion(_bodyQuat);

    const linVel = this.body.linvel();
    const speed  = Math.sqrt(linVel.x ** 2 + linVel.y ** 2 + linVel.z ** 2);

    // Forward speed (signed) – positive = moving forward
    const fwdSpeed = _forward.dot({ x: linVel.x, y: linVel.y, z: linVel.z });

    // ── Nose-dive: shift CoM forward under braking ────────────────────────
    if (this.controls.brake > 0.1) {
      const noseDive = 0.4 * this.controls.brake;
      this.body.setCenterOfMass({ x: 0, y: -0.3, z: noseDive }, true);
    } else {
      this.body.setCenterOfMass({ x: 0, y: -0.3, z: 0 }, true);
    }

    // ── Per-wheel suspension + traction ──────────────────────────────────
    let groundedWheels = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      groundedWheels += this._processWheel(i, _bodyPos, _bodyQuat, _forward, _right, dt, fwdSpeed);
    }

    // ── Drag / damping when airborne ──────────────────────────────────────
    if (groundedWheels === 0) {
      this.body.setLinearDamping(0.1);
      this.body.setAngularDamping(0.6);
    } else {
      this.body.setLinearDamping(0.0);
      this.body.setAngularDamping(4.0);
    }
  }

  /**
   * Process suspension spring + drive/brake/steer forces for one wheel.
   * @private
   * @returns {number} 1 if grounded, 0 if airborne
   */
  _processWheel(i, bodyPos, bodyQuat, forward, right, dt, fwdSpeed) {
    const wheel = this.wheels[i];
    const state = this.wheelState[i];
    const susp  = this.suspension;

    // World-space anchor point
    _worldPos.copy(wheel.localPos).applyQuaternion(bodyQuat).add(bodyPos);

    // Ray from slightly above anchor straight down
    const rayLen = susp.restLength + susp.travelLimit + wheel.radius;
    _rayOrigin.copy(_worldPos).addScaledVector({ x: 0, y: 1, z: 0 }, 0.1);

    const hit = this.physics.castRay(
      { x: _rayOrigin.x, y: _rayOrigin.y, z: _rayOrigin.z },
      _down,
      rayLen + 0.1,
      true
    );

    if (!hit) {
      state.onGround = false;
      state.prevComp = state.compression;
      state.compression = 0;
      return 0;
    }

    state.onGround = true;
    const hitDist = hit.toi - 0.1; // distance from anchor to contact
    const comp    = Math.max(0, Math.min(susp.travelLimit,
                      susp.restLength - (hitDist - wheel.radius)));

    // ── Spring force ──────────────────────────────────────────────────────
    const compVel  = (comp - state.prevComp) / dt;
    const dampCoef = compVel > 0 ? susp.compression : susp.damping;
    const suspForce = susp.stiffness * comp + dampCoef * compVel;

    const bodyUp = { x: 0, y: 1, z: 0 };
    // Apply upward force at wheel contact point
    this.body.addForceAtPoint(
      { x: bodyUp.x * suspForce, y: bodyUp.y * suspForce, z: bodyUp.z * suspForce },
      { x: _worldPos.x, y: _worldPos.y, z: _worldPos.z },
      true
    );

    state.prevComp = state.compression;
    state.compression = comp;

    // ── Lateral friction (friction circle) ───────────────────────────────
    // Only front wheels steer
    let wheelDir = forward.clone();
    if (i < 2) {
      const steerQuat = new THREE.Quaternion().setFromAxisAngle(_up, this.controls.steer * this.maxSteerAngle);
      wheelDir.applyQuaternion(steerQuat);
    }

    const linVel  = this.body.linvel();
    const latVel  = right.dot({ x: linVel.x, y: linVel.y, z: linVel.z });
    const lateralForceMag = -latVel * this.lateralStiffness * (suspForce / (this.mass * 9.81 / 4));

    // Friction circle: cap combined force to prevent unrealistic grip
    const longiForce  = this._longitudinalForce(i, fwdSpeed, suspForce);
    const totalForce  = Math.sqrt(lateralForceMag ** 2 + longiForce ** 2);
    const maxFriction = 0.9 * suspForce; // μ * Fz
    const scale       = totalForce > maxFriction ? maxFriction / totalForce : 1;

    // Apply lateral force
    this.body.addForceAtPoint(
      {
        x: right.x * lateralForceMag * scale,
        y: right.y * lateralForceMag * scale,
        z: right.z * lateralForceMag * scale,
      },
      { x: _worldPos.x, y: _worldPos.y, z: _worldPos.z },
      true
    );

    // Apply longitudinal force (drive/brake) via forward direction
    this.body.addForceAtPoint(
      {
        x: wheelDir.x * longiForce * scale,
        y: wheelDir.y * longiForce * scale,
        z: wheelDir.z * longiForce * scale,
      },
      { x: _worldPos.x, y: _worldPos.y, z: _worldPos.z },
      true
    );

    return 1;
  }

  /**
   * Longitudinal (drive/brake) force for one wheel.
   * Rear-wheel drive: only wheels 2/3 get engine torque.
   * @private
   */
  _longitudinalForce(wheelIndex, fwdSpeed, suspForce) {
    const { throttle, brake } = this.controls;
    const isRearWheel = wheelIndex >= 2;

    let force = 0;
    if (isRearWheel && throttle > 0) {
      // Reduce force at higher speed (simplistic power curve)
      const speedFactor = Math.max(0, 1 - Math.abs(fwdSpeed) / 40);
      force += throttle * this.engineForce * speedFactor;
    }
    if (brake > 0) {
      // Braking opposes current forward motion
      force -= Math.sign(fwdSpeed) * brake * this.brakeForce * 0.25;
    }
    return force;
  }

  /** World-space position of the vehicle body. */
  getPosition() {
    if (!this.body) return new THREE.Vector3();
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  /** World-space quaternion of the vehicle body. */
  getQuaternion() {
    if (!this.body) return new THREE.Quaternion();
    const r = this.body.rotation();
    return new THREE.Quaternion(r.x, r.y, r.z, r.w);
  }

  /** Current speed in m/s. */
  getSpeed() {
    if (!this.body) return 0;
    const v = this.body.linvel();
    return Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2);
  }

  dispose() {
    if (this.body) {
      this.physics.removeBody(this.body);
      this.body = null;
    }
  }
}
