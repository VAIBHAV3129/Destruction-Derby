/**
 * FXManager.js
 * Central orchestrator for all real-time visual special effects:
 *
 *  • SparkSystem  — GPU particle sparks on impact
 *  • VoxelTrail   — digital fragment trails on shed voxels
 *  • GhostTrail   — translucent ghost car at top speed
 *  • PostFX hooks — chromatic aberration, screen flash, radial blur (nitro)
 *
 * Integration surface for main.js:
 *  - fxManager.onImpact(worldPos, impulse, carLinVel)
 *  - fxManager.onVoxelDetached(worldPos, impulseMag, positionGetter)
 *  - fxManager.onNitroStart(strength)
 *  - fxManager.update(dt, carPos, carQuat, speed)   ← call every frame
 *  - fxManager.dispose()
 */

import { SparkSystem }  from './SparkSystem.js';
import { VoxelTrail }   from './VoxelTrail.js';
import { GhostTrail }   from './GhostTrail.js';

export class FXManager {
  /**
   * @param {THREE.Scene}                                         scene
   * @param {import('./PostFX').PostFX}                           postFX
   */
  constructor(scene, postFX) {
    this.sparks     = new SparkSystem(scene);
    this.voxelTrail = new VoxelTrail(scene);
    this.ghost      = new GhostTrail(scene);
    this.postFX     = postFX;
  }

  // ── Event hooks ───────────────────────────────────────────────────────────

  /**
   * Call from the collision event callback.
   * Triggers sparks, chromatic aberration, screen flash (heavy impacts).
   *
   * @param {THREE.Vector3} worldPos  - contact point in world space
   * @param {number}        impulse   - collision impulse magnitude (N·s)
   * @param {{x,y,z}}       carLinVel - vehicle linear velocity at impact
   */
  onImpact(worldPos, impulse, carLinVel) {
    // ── Sparks ──────────────────────────────────────────────────────────────
    this.sparks.burst(worldPos, impulse, carLinVel);

    // ── Post-processing effects ─────────────────────────────────────────────
    if (this.postFX) {
      this.postFX.triggerImpactFlash(impulse);

      // Extra chromatic spike on heavy hits (> 60 N·s)
      if (impulse > 60) {
        this.postFX.triggerChromaticSpike(Math.min((impulse - 60) / 80, 1));
      }
    }
  }

  /**
   * Call from VoxelVehicle.onVoxelDetached — attaches a digital trail.
   *
   * @param {THREE.Vector3}              worldPos    - detachment point
   * @param {number}                     impulseMag  - debris launch impulse
   * @param {()=>{x,y,z}|null}          getPos      - live position getter
   */
  onVoxelDetached(worldPos, impulseMag, getPos) {
    // Register a trail emitter that follows the debris body
    this.voxelTrail.addEmitter(getPos);

    // Small secondary spark burst at detachment point
    this.sparks.burst(worldPos, impulseMag * 8, { x: 0, y: 0, z: 0 });
  }

  /**
   * Call when the player activates Nitro / Overdrive.
   * Triggers radial blur post-process and a bloom pulse.
   * @param {number} [strength] 0–1, default 1
   */
  onNitroStart(strength = 1.0) {
    if (this.postFX) {
      this.postFX.triggerRadialBlur(strength, 0.35);
      // Brief bloom boost
      const prev = this.postFX.bloom.strength;
      this.postFX.setBloomStrength(prev + strength * 1.2);
      setTimeout(() => this.postFX.setBloomStrength(prev), 350);
    }
  }

  // ── Per-frame update ──────────────────────────────────────────────────────

  /**
   * Advance all FX subsystems.
   * @param {number}           dt       - seconds since last frame
   * @param {THREE.Vector3}    carPos   - current vehicle world position
   * @param {THREE.Quaternion} carQuat  - current vehicle orientation
   * @param {number}           speed    - vehicle speed in m/s
   */
  update(dt, carPos, carQuat, speed) {
    this.sparks.update(dt);
    this.voxelTrail.update(dt);
    this.ghost.update(carPos, carQuat, speed);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  dispose() {
    this.sparks.dispose();
    this.voxelTrail.dispose();
    this.ghost.dispose();
  }
}
