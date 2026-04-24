/**
 * VoxelVehicle.js
 * Renders a destructible voxel car using a single THREE.InstancedMesh.
 *
 * Memory-safe design:
 *  - Fixed max instance count; removed voxels scale to 0 (not spliced out).
 *  - Free-list tracks recyclable instance slots.
 *  - Debris uses an independent pooled InstancedMesh with its own free-list.
 *  - Rapier bodies are removed promptly after debris lifespan expires.
 *
 * If voxel count > 5000, frustum-culling and LOD toggle hooks are available.
 */

import * as THREE from 'three';

const MAX_VOXELS        = 512;
const MAX_DEBRIS        = 128;
const DEBRIS_LIFESPAN   = 3.0;   // seconds before debris fades
const IMPACT_THRESHOLD  = 15;    // impulse (N·s) to shed voxels
const VOXEL_SIZE        = 0.25;  // metres per side
const LOD_THRESHOLD     = 5000;  // if live voxel world count > this, enable LOD hints

// ── Scratch allocations ───────────────────────────────────────────────────────
const _m4    = new THREE.Matrix4();
const _pos   = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();

export class VoxelVehicle {
  /**
   * @param {import('../physics/PhysicsManager').PhysicsManager} physics
   * @param {THREE.Scene} scene
   * @param {Object} [opts]
   * @param {number} [opts.gridW]  voxel grid width
   * @param {number} [opts.gridH]  voxel grid height
   * @param {number} [opts.gridD]  voxel grid depth
   * @param {THREE.Color|number} [opts.baseColor]
   */
  constructor(physics, scene, opts = {}) {
    this.physics = physics;
    this.scene   = scene;

    this.gridW = opts.gridW ?? 8;
    this.gridH = opts.gridH ?? 4;
    this.gridD = opts.gridD ?? 16;

    // ── Main car InstancedMesh ────────────────────────────────────────────
    const geo = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);
    const mat = new THREE.MeshStandardMaterial({
      color:     opts.baseColor ?? 0x00f0ff,
      metalness: 0.85,
      roughness: 0.25,
      emissive:  new THREE.Color(0x002a3a),
      emissiveIntensity: 0.4,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_VOXELS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow    = true;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    scene.add(this.mesh);

    // ── Debris InstancedMesh ──────────────────────────────────────────────
    const dMat = new THREE.MeshStandardMaterial({
      color:     0xff6600,
      metalness: 0.6,
      roughness: 0.5,
      emissive:  new THREE.Color(0x330a00),
      emissiveIntensity: 0.5,
    });
    this.debrisMesh = new THREE.InstancedMesh(geo, dMat, MAX_DEBRIS);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.count = 0;
    scene.add(this.debrisMesh);

    // ── Metadata arrays ───────────────────────────────────────────────────
    /** Per-instance alive flag (1=alive, 0=dead/free) @type {Uint8Array} */
    this.alive       = new Uint8Array(MAX_VOXELS);
    /** Local grid offset for each instance @type {Float32Array} (x,y,z triples) */
    this.localPos    = new Float32Array(MAX_VOXELS * 3);
    /** Free-list of recyclable instance slots @type {number[]} */
    this.freeList    = [];

    /** Number of live voxel instances */
    this.voxelCount  = 0;

    // ── Debris state ──────────────────────────────────────────────────────
    /** @type {{body:RAPIER.RigidBody, age:number, idx:number}[]} */
    this.debrisItems = [];
    this.debrisFree  = [];
    this.debrisCount = 0;

    // ── LOD / frustum culling toggle hook ─────────────────────────────────
    /** Set to true externally to enable frustum culling on debris mesh */
    this.frustumCullDebris = false;

    /**
     * Impulse threshold (N·s) below which no voxels are shed.
     * Raised by the Armor Density upgrade via GarageManager.
     */
    this.impactThreshold = IMPACT_THRESHOLD;

    /**
     * Multiplier applied to the outward debris launch impulse.
     * Raised by the Explosive Force upgrade via GarageManager.
     */
    this.debrisImpulseMultiplier = 1.0;

    /**
     * Optional callback fired whenever a voxel is shed.
     * Signature: (positionGetter: ()=>{x,y,z}|null) => void
     * Assigned externally (e.g. by FXManager) to attach trails.
     * @type {((getPos:()=>{x:number,y:number,z:number}|null)=>void)|null}
     */
    this.onVoxelDetached = null;

    // Build initial voxel grid
    this._buildGrid();
  }

  /** @private Populate InstancedMesh with the voxel grid. */
  _buildGrid() {
    const hw = (this.gridW - 1) * VOXEL_SIZE * 0.5;
    const hh = 0;
    const hd = (this.gridD - 1) * VOXEL_SIZE * 0.5;

    let idx = 0;
    for (let z = 0; z < this.gridD; z++) {
      for (let y = 0; y < this.gridH; y++) {
        for (let x = 0; x < this.gridW; x++) {
          if (idx >= MAX_VOXELS) break;

          const lx = x * VOXEL_SIZE - hw;
          const ly = y * VOXEL_SIZE + hh;
          const lz = z * VOXEL_SIZE - hd;

          this.localPos[idx * 3]     = lx;
          this.localPos[idx * 3 + 1] = ly;
          this.localPos[idx * 3 + 2] = lz;
          this.alive[idx] = 1;

          _m4.compose(
            new THREE.Vector3(lx, ly, lz),
            new THREE.Quaternion(),
            new THREE.Vector3(1, 1, 1)
          );
          this.mesh.setMatrixAt(idx, _m4);

          // Neon-blue tint with slight variation per row
          const hue = 0.54 + (y / this.gridH) * 0.06;
          _color.setHSL(hue, 1.0, 0.55);
          this.mesh.setColorAt(idx, _color);

          idx++;
        }
      }
    }

    this.mesh.count  = idx;
    this.voxelCount  = idx;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Sync InstancedMesh transforms with vehicle body pose.
   * @param {THREE.Vector3} bodyPos
   * @param {THREE.Quaternion} bodyQuat
   */
  syncToBody(bodyPos, bodyQuat) {
    for (let i = 0; i < this.mesh.count; i++) {
      if (!this.alive[i]) continue;

      _pos.set(
        this.localPos[i * 3],
        this.localPos[i * 3 + 1],
        this.localPos[i * 3 + 2]
      ).applyQuaternion(bodyQuat).add(bodyPos);

      _m4.compose(_pos, bodyQuat, _scale.setScalar(1));
      this.mesh.setMatrixAt(i, _m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Process a collision impact: shed nearby voxels above the impulse threshold.
   * @param {THREE.Vector3} hitWorldPos   - world-space impact point
   * @param {THREE.Vector3} vehiclePos    - vehicle body position
   * @param {THREE.Quaternion} vehicleQuat
   * @param {number} impulse              - collision impulse magnitude
   * @returns {number} count of voxels detached
   */
  processImpact(hitWorldPos, vehiclePos, vehicleQuat, impulse) {
    if (impulse < this.impactThreshold) return 0;

    // Convert hit point to vehicle local space
    const hitLocal = hitWorldPos.clone()
      .sub(vehiclePos)
      .applyQuaternion(vehicleQuat.clone().invert());

    // Number of voxels to shed scales with impulse (capped)
    const shedCount = Math.min(
      Math.floor((impulse - IMPACT_THRESHOLD) / 8) + 1,
      6,
      this.voxelCount
    );

    // ── LOD hint: if total world voxels > threshold, shed fewer ──────────
    const effectiveShed = this.voxelCount > LOD_THRESHOLD
      ? Math.ceil(shedCount * 0.5)
      : shedCount;

    // Find nearest alive voxels to hit point
    const nearest = this._findNearestVoxels(hitLocal, effectiveShed);
    let detached = 0;

    for (const idx of nearest) {
      if (this._detachVoxel(idx, vehiclePos, vehicleQuat, impulse)) {
        detached++;
      }
    }

    // LOD toggle hook
    if (this.voxelCount > LOD_THRESHOLD) {
      this.frustumCullDebris = true;
      this.debrisMesh.frustumCulled = true;
    }

    return detached;
  }

  /**
   * Find the N alive voxel indices closest to a local-space point.
   * @private
   */
  _findNearestVoxels(localPoint, n) {
    /** @type {{idx:number, dist:number}[]} */
    const candidates = [];

    for (let i = 0; i < this.mesh.count; i++) {
      if (!this.alive[i]) continue;
      const dx = this.localPos[i * 3]     - localPoint.x;
      const dy = this.localPos[i * 3 + 1] - localPoint.y;
      const dz = this.localPos[i * 3 + 2] - localPoint.z;
      candidates.push({ idx: i, dist: dx * dx + dy * dy + dz * dz });
    }

    candidates.sort((a, b) => a.dist - b.dist);
    return candidates.slice(0, n).map(c => c.idx);
  }

  /**
   * Detach a single voxel: hide on car mesh, spawn physics debris.
   * @private
   */
  _detachVoxel(idx, vehiclePos, vehicleQuat, impulse) {
    if (!this.alive[idx]) return false;
    if (this.debrisCount >= MAX_DEBRIS) return false;

    // ── Hide on car mesh ──────────────────────────────────────────────────
    this.alive[idx] = 0;
    this.voxelCount--;
    this.freeList.push(idx);
    _m4.makeScale(0, 0, 0); // zero-scale hides instance without GPU re-upload
    this.mesh.setMatrixAt(idx, _m4);
    this.mesh.instanceMatrix.needsUpdate = true;

    // ── World position of this voxel ──────────────────────────────────────
    _pos.set(
      this.localPos[idx * 3],
      this.localPos[idx * 3 + 1],
      this.localPos[idx * 3 + 2]
    ).applyQuaternion(vehicleQuat).add(vehiclePos);

    // ── Debris InstancedMesh slot ─────────────────────────────────────────
    let dIdx;
    if (this.debrisFree.length > 0) {
      dIdx = this.debrisFree.pop();
    } else {
      dIdx = this.debrisCount;
      this.debrisCount = Math.min(this.debrisCount + 1, MAX_DEBRIS);
    }
    this.debrisMesh.count = Math.max(this.debrisMesh.count, dIdx + 1);

    _m4.compose(_pos, vehicleQuat, _scale.setScalar(1));
    this.debrisMesh.setMatrixAt(dIdx, _m4);
    this.debrisMesh.instanceMatrix.needsUpdate = true;

    // ── Rapier physics body for debris ────────────────────────────────────
    const body = this.physics.createDynamicBody(
      { x: _pos.x, y: _pos.y, z: _pos.z }
    );
    body.setAdditionalMass(0.2);
    this.physics.addBoxCollider(
      body,
      { x: VOXEL_SIZE * 0.5, y: VOXEL_SIZE * 0.5, z: VOXEL_SIZE * 0.5 },
      0.4, 0.5
    );

    // Give debris an impulse in the impact direction
    const impulseMag = Math.min(impulse * 0.004 * this.debrisImpulseMultiplier, 3.5);
    body.applyImpulse(
      { x: (Math.random() - 0.5) * impulseMag, y: impulseMag * 0.6, z: (Math.random() - 0.5) * impulseMag },
      true
    );

    this.debrisItems.push({ body, age: 0, idx: dIdx });

    // Notify external listeners (e.g. FXManager trail emitter).
    // We close over `body` and check validity before each access.
    if (this.onVoxelDetached) {
      const capturedBody = body;
      this.onVoxelDetached(() => {
        try {
          const tr = capturedBody.translation();
          return { x: tr.x, y: tr.y, z: tr.z };
        } catch {
          return null;
        }
      });
    }

    return true;
  }

  /**
   * Update debris: advance age, sync transforms, fade out, and clean up.
   * @param {number} dt
   */
  update(dt) {
    let i = this.debrisItems.length;
    while (i--) {
      const item = this.debrisItems[i];
      item.age += dt;

      if (item.age >= DEBRIS_LIFESPAN) {
        // ── Clean up Rapier body ──────────────────────────────────────────
        this.physics.removeBody(item.body);

        // ── Recycle debris instance slot ──────────────────────────────────
        _m4.makeScale(0, 0, 0);
        this.debrisMesh.setMatrixAt(item.idx, _m4);
        this.debrisMesh.instanceMatrix.needsUpdate = true;
        this.debrisFree.push(item.idx);

        this.debrisItems.splice(i, 1);
        continue;
      }

      // ── Sync debris mesh with Rapier body ─────────────────────────────
      const t = item.body.translation();
      const r = item.body.rotation();
      _pos.set(t.x, t.y, t.z);
      _quat.set(r.x, r.y, r.z, r.w);

      // Fade scale in last 0.8 seconds of lifespan
      const remaining = DEBRIS_LIFESPAN - item.age;
      const fadeFactor = remaining < 0.8 ? remaining / 0.8 : 1.0;
      _scale.setScalar(fadeFactor);

      _m4.compose(_pos, _quat, _scale);
      this.debrisMesh.setMatrixAt(item.idx, _m4);
    }
    this.debrisMesh.instanceMatrix.needsUpdate = true;
  }

  /** @returns {number} count of live car voxels */
  getLiveVoxelCount() { return this.voxelCount; }

  /**
   * Update the voxel colour to show Armor Density upgrade visually.
   * Outer-shell voxels (top layer + side extremes) gain a metallic silver
   * tint that increases with upgrade level (1–5).
   * Level 0 restores the original neon-blue gradient.
   * @param {number} level 0–5
   */
  applyArmorVisual(level) {
    const silverColor = new THREE.Color(0x99aacc);
    const blueColor   = new THREE.Color();

    // Find Y-axis bounds to determine "outer" shell
    let minY = Infinity, maxY = -Infinity;
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.mesh.count; i++) {
      if (!this.alive[i]) continue;
      const lx = this.localPos[i * 3],
            ly = this.localPos[i * 3 + 1],
            lz = this.localPos[i * 3 + 2];
      if (lx < minX) minX = lx; if (lx > maxX) maxX = lx;
      if (ly < minY) minY = ly; if (ly > maxY) maxY = ly;
      if (lz < minZ) minZ = lz; if (lz > maxZ) maxZ = lz;
    }

    const EPS = VOXEL_SIZE * 0.6;
    const t   = Math.min(level / 5, 1);

    for (let i = 0; i < this.mesh.count; i++) {
      if (!this.alive[i]) continue;
      const lx = this.localPos[i * 3],
            ly = this.localPos[i * 3 + 1],
            lz = this.localPos[i * 3 + 2];

      // Outer shell: top + all four lateral faces
      const isShell = ly >= maxY - EPS
        || lx <= minX + EPS || lx >= maxX - EPS
        || lz <= minZ + EPS || lz >= maxZ - EPS;

      if (isShell && level > 0) {
        const relY = maxY > minY ? (ly - minY) / (maxY - minY) : 0.5;
        blueColor.setHSL(0.54 + relY * 0.06, 1.0, 0.55);
        _color.lerpColors(blueColor, silverColor, t);
      } else {
        // Restore neon-blue row gradient
        const relY = maxY > minY ? (ly - minY) / (maxY - minY) : 0.5;
        _color.setHSL(0.54 + relY * 0.06, 1.0, 0.55);
      }
      this.mesh.setColorAt(i, _color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Full disposal: remove all physics bodies, geometries, materials, textures.
   * Call on level unload to avoid leaks.
   */
  dispose() {
    // Remove all debris physics bodies
    for (const item of this.debrisItems) {
      this.physics.removeBody(item.body);
    }
    this.debrisItems = [];

    // Remove meshes from scene and dispose GPU resources
    this.scene.remove(this.mesh);
    this.scene.remove(this.debrisMesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.debrisMesh.geometry.dispose();
    this.debrisMesh.material.dispose();
  }
}
