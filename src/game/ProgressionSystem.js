/**
 * ProgressionSystem.js
 * LevelManager — environment config, difficulty scaling, objective tracking.
 * VehicleGarage  — tier unlock logic backed by localStorage via saveSchema.
 */

import { SaveSchema } from '../persistence/saveSchema.js';

// ── Environment definitions ───────────────────────────────────────────────────
const ENVIRONMENTS = [
  {
    id: 'neon_city',
    name: 'Neon City',
    fogColor: 0x000a14,
    fogNear: 30,
    fogFar: 120,
    gridColor: 0x00f0ff,
    ambientIntensity: 0.15,
  },
  {
    id: 'orbital_station',
    name: 'Orbital Station',
    fogColor: 0x04001a,
    fogNear: 20,
    fogFar: 100,
    gridColor: 0x8800ff,
    ambientIntensity: 0.08,
  },
  {
    id: 'industrial_wasteland',
    name: 'Industrial Wasteland',
    fogColor: 0x0a0800,
    fogNear: 25,
    fogFar: 90,
    gridColor: 0xff6600,
    ambientIntensity: 0.2,
  },
];

// ── Vehicle tier definitions ──────────────────────────────────────────────────
export const VEHICLE_TIERS = {
  scout: {
    id: 'scout',
    name: 'Scout',
    unlockCost: 0,
    mass: 500,
    engineForce: 5000,
    brakeForce: 5500,
    maxSteerAngle: 0.52,
    lateralStiffness: 14,
    suspension: { stiffness: 18000, damping: 1800, compression: 2000, restLength: 0.3, travelLimit: 0.2 },
    voxelGrid: { w: 6, h: 3, d: 12 },
    impactThreshold: 10,    // low — sheds easily
    description: 'Fast & light. Nimble drifting but easily damaged.',
  },
  bruiser: {
    id: 'bruiser',
    name: 'Bruiser',
    unlockCost: 150,        // scrap cost
    mass: 800,
    engineForce: 4000,
    brakeForce: 6000,
    maxSteerAngle: 0.45,
    lateralStiffness: 11,
    suspension: { stiffness: 22000, damping: 2200, compression: 2600, restLength: 0.35, travelLimit: 0.25 },
    voxelGrid: { w: 8, h: 4, d: 16 },
    impactThreshold: 20,
    description: 'Balanced weight and armor. Reinforced front bumper.',
  },
  behemoth: {
    id: 'behemoth',
    name: 'Behemoth',
    unlockCost: 400,
    mass: 1600,
    engineForce: 5500,
    brakeForce: 9000,
    maxSteerAngle: 0.3,
    lateralStiffness: 7,
    suspension: { stiffness: 32000, damping: 3500, compression: 4000, restLength: 0.45, travelLimit: 0.3 },
    voxelGrid: { w: 10, h: 5, d: 20 },
    impactThreshold: 40,    // high — tank-like
    description: 'Heavy tank. Sluggish but devastating on impact.',
  },
};

// ── Difficulty config per level index ────────────────────────────────────────
const DIFFICULTY_LEVELS = [
  { aiCount: 2, aiAggression: 0.3, voxelTarget: 200 },
  { aiCount: 3, aiAggression: 0.5, voxelTarget: 350 },
  { aiCount: 4, aiAggression: 0.7, voxelTarget: 500 },
  { aiCount: 5, aiAggression: 0.9, voxelTarget: 800 },
  { aiCount: 6, aiAggression: 1.0, voxelTarget: 1200 },
];

// ─────────────────────────────────────────────────────────────────────────────

export class LevelManager {
  constructor() {
    this._levelIndex     = 0;
    this._voxelsDestroyed = 0;
    this._onLevelComplete = null;
  }

  /** Current environment config. */
  get environment() {
    return ENVIRONMENTS[this._levelIndex % ENVIRONMENTS.length];
  }

  /** Current difficulty config. */
  get difficulty() {
    return DIFFICULTY_LEVELS[Math.min(this._levelIndex, DIFFICULTY_LEVELS.length - 1)];
  }

  /** Current level number (1-based). */
  get levelNumber() { return this._levelIndex + 1; }

  /**
   * Set a callback fired when the voxel destruction target is reached.
   * @param {()=>void} cb
   */
  onLevelComplete(cb) { this._onLevelComplete = cb; }

  /**
   * Record destroyed voxels and check objective.
   * @param {number} count
   */
  recordDestruction(count) {
    this._voxelsDestroyed += count;
    if (this._voxelsDestroyed >= this.difficulty.voxelTarget && this._onLevelComplete) {
      this._onLevelComplete();
    }
  }

  /** Advance to the next level. */
  nextLevel() {
    this._levelIndex++;
    this._voxelsDestroyed = 0;
  }

  /** Progress fraction toward destruction target [0,1]. */
  get objectiveProgress() {
    return Math.min(1, this._voxelsDestroyed / this.difficulty.voxelTarget);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class VehicleGarage {
  constructor() {
    this._save = SaveSchema.load();
  }

  /** Currently selected tier id. */
  get selectedTier() { return this._save.progression.selectedVehicle; }

  /**
   * Check whether a tier has been unlocked.
   * @param {string} tierId
   */
  isUnlocked(tierId) {
    return this._save.progression.unlockedVehicles.includes(tierId);
  }

  /**
   * Try to unlock a tier using scrap. Returns true on success.
   * @param {string} tierId
   */
  unlock(tierId) {
    const tier = VEHICLE_TIERS[tierId];
    if (!tier) return false;
    if (this.isUnlocked(tierId)) return true;
    if (this._save.progression.scrap < tier.unlockCost) return false;

    this._save.progression.scrap -= tier.unlockCost;
    this._save.progression.unlockedVehicles.push(tierId);
    SaveSchema.save(this._save);
    return true;
  }

  /**
   * Select an unlocked tier.
   * @param {string} tierId
   */
  selectTier(tierId) {
    if (!this.isUnlocked(tierId)) return false;
    this._save.progression.selectedVehicle = tierId;
    SaveSchema.save(this._save);
    return true;
  }

  /**
   * Add scrap and save.
   * @param {number} amount
   */
  addScrap(amount) {
    this._save.progression.scrap += amount;
    SaveSchema.save(this._save);
  }

  /** Current scrap balance. */
  get scrap() { return this._save.progression.scrap; }

  /** Config object for the currently selected vehicle tier. */
  get currentConfig() { return VEHICLE_TIERS[this.selectedTier]; }

  /** All tier configs, annotated with unlock status. */
  getTierList() {
    return Object.values(VEHICLE_TIERS).map(t => ({
      ...t,
      unlocked: this.isUnlocked(t.id),
    }));
  }
}
