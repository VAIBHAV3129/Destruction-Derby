/**
 * LevelLoader.js
 * Handles transitions between levels and spawns procedural hazards.
 *
 * Procedural hazards added in higher levels:
 *  - Explosive barrels: high restitution dynamic boxes; explode on contact
 *  - Gravity traps: spherical trigger zones that attract debris inward
 */

import * as THREE from 'three';

const BARREL_HALF = { x: 0.3, y: 0.5, z: 0.3 };
const BARREL_COLOR = 0xff3300;
const BARREL_MASS  = 60;

/** How many hazards to spawn per level index (0-based). */
const HAZARD_TABLE = [
  { barrels: 0, gravTraps: 0 },
  { barrels: 3, gravTraps: 0 },
  { barrels: 5, gravTraps: 1 },
  { barrels: 8, gravTraps: 2 },
  { barrels: 12, gravTraps: 3 },
];

export class LevelLoader {
  /**
   * @param {import('../physics/PhysicsManager').PhysicsManager} physics
   * @param {THREE.Scene} scene
   */
  constructor(physics, scene) {
    this.physics = physics;
    this.scene   = scene;

    /** @type {{mesh:THREE.Mesh, body:RAPIER.RigidBody, type:string}[]} */
    this._hazards = [];

    // Reusable geo/mat for barrels
    this._barrelGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.0, 8);
    this._barrelMat = new THREE.MeshStandardMaterial({
      color: BARREL_COLOR,
      metalness: 0.7,
      roughness: 0.4,
      emissive: new THREE.Color(0x200500),
    });

    this._trapGeo = new THREE.SphereGeometry(1.5, 10, 8);
    this._trapMat = new THREE.MeshStandardMaterial({
      color: 0x8800ff,
      transparent: true,
      opacity: 0.22,
      emissive: new THREE.Color(0x220040),
      emissiveIntensity: 1,
      wireframe: true,
    });
  }

  /**
   * Load/transition to a level: apply environment fog/lighting and spawn hazards.
   * @param {number} levelIndex  0-based level number
   * @param {object} envConfig   from LevelManager.environment
   * @param {THREE.Scene} scene  (allows replacing fog/bg)
   * @param {THREE.Camera} [camera]
   */
  load(levelIndex, envConfig, scene) {
    // ── Clean up previous hazards ─────────────────────────────────────────
    this.unload();

    // ── Environment fog ───────────────────────────────────────────────────
    scene.fog = new THREE.FogExp2(envConfig.fogColor, 0.012);

    // ── Spawn hazards ──────────────────────────────────────────────────────
    const table = HAZARD_TABLE[Math.min(levelIndex, HAZARD_TABLE.length - 1)];
    this._spawnBarrels(table.barrels);
    this._spawnGravityTraps(table.gravTraps);
  }

  /** @private */
  _spawnBarrels(count) {
    const ARENA = 24;
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * ARENA;
      const z = (Math.random() - 0.5) * ARENA;

      const mesh = new THREE.Mesh(this._barrelGeo, this._barrelMat);
      mesh.position.set(x, 1.0, z);
      mesh.castShadow = true;
      this.scene.add(mesh);

      const body = this.physics.createDynamicBody({ x, y: 1.0, z });
      body.setAdditionalMass(BARREL_MASS);
      this.physics.addBoxCollider(body, BARREL_HALF, 0.5, 0.6, true);

      // Listen for heavy collision → explode
      this.physics.onCollision(body.handle, (otherHandle, started, impulse) => {
        if (started && impulse > 40) {
          this._explodeBarrel(mesh, body);
        }
      });

      this._hazards.push({ mesh, body, type: 'barrel' });
    }
  }

  /** @private */
  _spawnGravityTraps(count) {
    const ARENA = 20;
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * ARENA;
      const z = (Math.random() - 0.5) * ARENA;

      const mesh = new THREE.Mesh(this._trapGeo, this._trapMat);
      mesh.position.set(x, 2.0, z);
      this.scene.add(mesh);

      // Gravity traps are visual only; the pull logic is in update()
      this._hazards.push({ mesh, body: null, type: 'gravity_trap', pos: { x, y: 2, z } });
    }
  }

  /**
   * Explode a barrel: remove its body and play a force-push on nearby objects.
   * @private
   */
  _explodeBarrel(mesh, body) {
    // Prevent double-explosion
    if (!this.physics.world || !this.physics.world.containsRigidBody(body)) return;

    this.physics.offCollision(body.handle);
    this.physics.removeBody(body);

    // Hide the mesh (fade could be improved with a tween)
    mesh.visible = false;

    // ── Apply outward impulse to nearby rigid bodies ───────────────────
    const origin = mesh.position;
    const RADIUS = 8;
    const FORCE  = 2200;

    this.physics.world.forEachRigidBody(rb => {
      if (!rb.isDynamic()) return;
      const t = rb.translation();
      const dx = t.x - origin.x;
      const dy = t.y - origin.y;
      const dz = t.z - origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < RADIUS && dist > 0.01) {
        const scale = (1 - dist / RADIUS) * FORCE;
        rb.applyImpulse({ x: (dx / dist) * scale, y: 2 * scale, z: (dz / dist) * scale }, true);
      }
    });
  }

  /**
   * Per-frame update: animate gravity traps (pull nearby bodies inward).
   * @param {number} dt
   */
  update(dt) {
    for (const h of this._hazards) {
      if (h.type !== 'gravity_trap') continue;

      // Pulse visual
      const scale = 1 + 0.08 * Math.sin(performance.now() * 0.003);
      h.mesh.scale.setScalar(scale);

      // Pull nearby dynamic bodies toward trap centre
      const { x, y, z } = h.pos;
      const PULL_RADIUS  = 10;
      const PULL_FORCE   = 18;

      if (!this.physics.world) continue;
      this.physics.world.forEachRigidBody(rb => {
        if (!rb.isDynamic()) return;
        const t = rb.translation();
        const dx = x - t.x, dy = y - t.y, dz = z - t.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < PULL_RADIUS && dist > 0.5) {
          const scale = PULL_FORCE / (dist * dist);
          rb.applyImpulse({ x: dx * scale * dt, y: dy * scale * dt, z: dz * scale * dt }, true);
        }
      });
    }
  }

  /** Remove all hazards from the scene and physics. */
  unload() {
    for (const h of this._hazards) {
      this.scene.remove(h.mesh);
      if (h.body && this.physics.world && this.physics.world.containsRigidBody(h.body)) {
        this.physics.offCollision(h.body.handle);
        this.physics.removeBody(h.body);
      }
    }
    this._hazards = [];
  }

  /** Full disposal of shared geometry/materials. */
  dispose() {
    this.unload();
    this._barrelGeo.dispose();
    this._barrelMat.dispose();
    this._trapGeo.dispose();
    this._trapMat.dispose();
  }
}
