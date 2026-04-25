/**
 * PhysicsManager.js
 * Wraps Rapier3D world: fixed-step deterministic update, CCD for player,
 * collision event dispatch, and helper factories for bodies/colliders.
 */

import RAPIER from '@dimforge/rapier3d-compat';

/** Physics fixed timestep (seconds). Matches 60 Hz simulation. */
const FIXED_STEP = 1 / 60;

export class PhysicsManager {
  /** @type {RAPIER.World} */
  world = null;

  /** Accumulator for fixed-step sub-stepping */
  _accumulator = 0;

  /** @type {RAPIER.EventQueue} */
  _eventQueue = null;

  /** Map of handle -> collision listener callbacks */
  _collisionListeners = new Map();

  /**
   * Async init — must be awaited before using any physics.
   */
  async init() {
    await RAPIER.init();

    this.world = new RAPIER.World({ x: 0, y: -19.62, z: 0 });

    // Tune solver for arcade-feel: more iterations = stiffer constraints
    this.world.numSolverIterations = 8;
    this.world.numAdditionalFrictionIterations = 4;

    this._eventQueue = new RAPIER.EventQueue(true);
  }

  /**
   * Create a dynamic rigid body at position/rotation.
   * @param {{x:number,y:number,z:number}} position
   * @param {{x:number,y:number,z:number,w:number}} [rotation]
   * @param {boolean} [enableCcd] - enable Continuous Collision Detection
   * @returns {RAPIER.RigidBody}
   */
  createDynamicBody(position, rotation, enableCcd = false) {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setCcdEnabled(enableCcd);

    if (rotation) {
      desc.setRotation(rotation);
    }
    return this.world.createRigidBody(desc);
  }

  /**
   * Create a kinematic (position-driven) rigid body.
   */
  createKinematicBody(position) {
    const desc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(position.x, position.y, position.z);
    return this.world.createRigidBody(desc);
  }

  /**
   * Create a static rigid body (immovable floor/walls).
   */
  createStaticBody(position, rotation) {
    const desc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(position.x, position.y, position.z);
    if (rotation) desc.setRotation(rotation);
    return this.world.createRigidBody(desc);
  }

  /**
   * Attach a box collider to a rigid body.
   * @param {RAPIER.RigidBody} body
   * @param {{x:number,y:number,z:number}} halfExtents
   * @param {number} [friction]
   * @param {number} [restitution]
   * @param {boolean} [activeEvents] - enable collision events
   * @returns {RAPIER.Collider}
   */
  addBoxCollider(body, halfExtents, friction = 0.7, restitution = 0.2, activeEvents = false) {
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setFriction(friction)
      .setRestitution(restitution);

    if (activeEvents) {
      desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    }
    return this.world.createCollider(desc, body);
  }

  /**
   * Attach a sphere collider.
   */
  addSphereCollider(body, radius, friction = 0.7, restitution = 0.3) {
    const desc = RAPIER.ColliderDesc.ball(radius)
      .setFriction(friction)
      .setRestitution(restitution);
    return this.world.createCollider(desc, body);
  }

  /**
   * Cast a ray and return the nearest hit.
   * @param {{x,y,z}} origin
   * @param {{x,y,z}} dir  (should be unit length)
   * @param {number} maxToi  max distance
   * @param {boolean} [solid]
   * @returns {{toi:number, collider:RAPIER.Collider}|null}
   */
  castRay(origin, dir, maxToi, solid = true) {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, maxToi, solid);
    if (!hit) return null;
    return { toi: hit.toi, collider: hit.collider };
  }

  /**
   * Register a callback fired when two bodies with active events collide.
   * @param {number} bodyHandle
   * @param {(otherHandle:number, started:boolean, impulse:number)=>void} cb
   */
  onCollision(bodyHandle, cb) {
    this._collisionListeners.set(bodyHandle, cb);
  }

  /** Remove a collision listener by body handle. */
  offCollision(bodyHandle) {
    this._collisionListeners.delete(bodyHandle);
  }

  /**
   * Advance physics by dt seconds using fixed sub-steps.
   * Drains the event queue and dispatches collision callbacks.
   * @param {number} dt - real elapsed seconds
   */
  update(dt) {
    this._accumulator += dt;

    while (this._accumulator >= FIXED_STEP) {
      this.world.step(this._eventQueue);
      this._drainEvents();
      this._accumulator -= FIXED_STEP;
    }
  }

  /** @private */
  _drainEvents() {
    this._eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      // Approximate impulse from contact manifolds (best-effort, not exact)
      const impulse = this._estimateImpulse(handle1, handle2);

      const cb1 = this._collisionListeners.get(handle1);
      const cb2 = this._collisionListeners.get(handle2);
      if (cb1) cb1(handle2, started, impulse);
      if (cb2) cb2(handle1, started, impulse);
    });
  }

  /**
   * Rough impulse estimate using relative velocity * average mass.
   * @private
   */
  _estimateImpulse(h1, h2) {
    try {
      const b1 = this.world.getRigidBody(h1);
      const b2 = this.world.getRigidBody(h2);
      if (!b1 || !b2) return 0;
      const v1 = b1.linvel();
      const v2 = b2.linvel();
      const dvx = v1.x - v2.x, dvy = v1.y - v2.y, dvz = v1.z - v2.z;
      const relSpeed = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
      const m1 = b1.isDynamic() ? (1 / (b1.invMass() || 1)) : 1000;
      const m2 = b2.isDynamic() ? (1 / (b2.invMass() || 1)) : 1000;
      const reducedMass = (m1 * m2) / (m1 + m2);
      return reducedMass * relSpeed;
    } catch {
      return 0;
    }
  }

  /** Remove a rigid body and all its colliders from the world. */
  removeBody(body) {
    if (body && this.world.containsRigidBody(body)) {
      this.world.removeRigidBody(body);
    }
  }

  /** Clean up all physics resources. */
  dispose() {
    this._collisionListeners.clear();
    if (this.world) {
      this.world.free();
      this.world = null;
    }
  }
}
