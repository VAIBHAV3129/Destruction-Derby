/**
 * GarageManager.js
 * Player data, upgrade purchasing, car tier unlocks, and cloud-save hooks.
 *
 * Upgrade cost formula: Math.round(baseCost × 1.5 ^ currentLevel)
 * This ensures costs grow ~50% per tier — long enough to be a meaningful grind,
 * short enough to feel rewarding in a CrazyGames session.
 */

import { SaveSchema }                  from '../persistence/saveSchema.js';
import { VEHICLE_TIERS }               from './ProgressionSystem.js';

// ── Upgrade catalogue ─────────────────────────────────────────────────────────

export const UPGRADES = {
  enginePower: {
    id:          'enginePower',
    name:        'Engine Power',
    description: 'Increases drive force and top speed (+12 % per level).',
    maxLevel:    5,
    baseCost:    80,
    icon:        '⚡',
  },
  armorDensity: {
    id:          'armorDensity',
    name:        'Armor Density',
    description: 'Raises the impulse threshold before voxels shed. Fewer parts fall off.',
    maxLevel:    5,
    baseCost:    100,
    icon:        '🛡',
  },
  explosiveForce: {
    id:          'explosiveForce',
    name:        'Explosive Force',
    description: 'Amplifies outward debris launch impulse on impact.',
    maxLevel:    5,
    baseCost:    120,
    icon:        '💥',
  },
};

/**
 * Cost to upgrade from `currentLevel` → `currentLevel + 1`.
 * Returns Infinity when already at max or unknown ID.
 * @param {string} id
 * @param {number} currentLevel
 */
export function upgradeCost(id, currentLevel) {
  const u = UPGRADES[id];
  if (!u || currentLevel >= u.maxLevel) return Infinity;
  return Math.round(u.baseCost * Math.pow(1.5, currentLevel));
}

// ─────────────────────────────────────────────────────────────────────────────

export class GarageManager {
  constructor() {
    this._save = SaveSchema.load();
    this._ensureUpgrades();

    /** @type {((id:string, newLevel:number)=>void)|null} */
    this._onUpgrade     = null;
    /** @type {((scrap:number)=>void)|null} */
    this._onScrapChange = null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Guarantee all known upgrade keys exist in the save (forward-compat). */
  _ensureUpgrades() {
    const ups = (this._save.progression.upgrades ??= {});
    for (const id of Object.keys(UPGRADES)) {
      if (!(id in ups)) ups[id] = 0;
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get scrap()      { return this._save.progression.scrap; }
  get ownedCars()  { return this._save.progression.unlockedVehicles; }
  get selectedCar(){ return this._save.progression.selectedVehicle; }

  /** @param {string} id */
  getUpgradeLevel(id) { return this._save.progression.upgrades[id] ?? 0; }

  /** @param {string} id */
  getNextCost(id)     { return upgradeCost(id, this.getUpgradeLevel(id)); }

  /** @param {string} id */
  canAfford(id)       { return this.scrap >= this.getNextCost(id); }

  // ── Upgrade purchase ──────────────────────────────────────────────────────

  /**
   * Purchase one level of an upgrade.
   * @param {string} id
   * @param {{ vehicle?: any, voxelVehicle?: any }} [live] live game objects
   * @returns {boolean} true on success
   */
  purchase(id, live = {}) {
    const u = UPGRADES[id];
    if (!u) return false;

    const lvl  = this.getUpgradeLevel(id);
    if (lvl >= u.maxLevel) return false;

    const cost = upgradeCost(id, lvl);
    if (this._save.progression.scrap < cost) return false;

    this._save.progression.scrap         -= cost;
    this._save.progression.upgrades[id]   = lvl + 1;
    SaveSchema.save(this._save);

    this._applyUpgrade(id, lvl + 1, live);
    this._onUpgrade?.(id, lvl + 1);
    this._onScrapChange?.(this._save.progression.scrap);
    return true;
  }

  /**
   * Apply all saved upgrade effects on game start.
   * @param {{ vehicle?: any, voxelVehicle?: any }} live
   */
  applyAllUpgrades(live = {}) {
    if (live.vehicle && live.vehicle._baseEngineForce === undefined) {
      live.vehicle._baseEngineForce = live.vehicle.engineForce;
    }
    for (const id of Object.keys(UPGRADES)) {
      const lvl = this.getUpgradeLevel(id);
      if (lvl > 0) this._applyUpgrade(id, lvl, live);
    }
  }

  /** @private */
  _applyUpgrade(id, newLevel, { vehicle, voxelVehicle } = {}) {
    const t = newLevel / (UPGRADES[id]?.maxLevel ?? 5); // 0.2 … 1.0

    if (id === 'enginePower' && vehicle) {
      const base = vehicle._baseEngineForce ?? vehicle.engineForce;
      vehicle._baseEngineForce = base;
      vehicle.engineForce      = Math.round(base * (1 + t * 0.6));
    }

    if (id === 'armorDensity' && voxelVehicle) {
      // Raise voxel-shedding impulse threshold: 15 → 45 over 5 levels
      voxelVehicle.impactThreshold = 15 + newLevel * 6;
    }

    if (id === 'explosiveForce' && voxelVehicle) {
      voxelVehicle.debrisImpulseMultiplier = 1 + newLevel * 0.4;
    }
  }

  // ── Scrap management ──────────────────────────────────────────────────────

  /**
   * Credit scrap and fire the change callback.
   * @param {number} amount
   */
  addScrap(amount) {
    this._save.progression.scrap += amount;
    SaveSchema.save(this._save);
    this._onScrapChange?.(this._save.progression.scrap);
  }

  // ── Car tier unlock / selection ───────────────────────────────────────────

  /** @param {string} tierId @returns {boolean} */
  unlockCar(tierId) {
    const tier = VEHICLE_TIERS[tierId];
    if (!tier || this.ownedCars.includes(tierId)) return false;
    if (this.scrap < tier.unlockCost) return false;

    this._save.progression.scrap -= tier.unlockCost;
    this._save.progression.unlockedVehicles.push(tierId);
    SaveSchema.save(this._save);
    this._onScrapChange?.(this._save.progression.scrap);
    return true;
  }

  /** @param {string} tierId @returns {boolean} */
  selectCar(tierId) {
    if (!this.ownedCars.includes(tierId)) return false;
    this._save.progression.selectedVehicle = tierId;
    SaveSchema.save(this._save);
    return true;
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  /** @param {(id:string, newLevel:number)=>void} cb */
  onUpgrade(cb)     { this._onUpgrade     = cb; }
  /** @param {(scrap:number)=>void} cb */
  onScrapChange(cb) { this._onScrapChange = cb; }

  // ── Cloud-save placeholder ────────────────────────────────────────────────

  /**
   * @placeholder Sync save to CrazyGames cloud slot 0.
   * Implement with window.CrazyGames.SDK.user.save() when cloud-save
   * is enabled in the CrazyGames developer dashboard.
   */
  async cloudSave() {
    try {
      const data = JSON.stringify(this._save);
      if (window.CrazyGames?.SDK?.user) {
        await window.CrazyGames.SDK.user.save({ slot: 0, data });
        console.info('[GarageManager] Cloud save OK');
      } else {
        console.info('[GarageManager] Cloud save: SDK unavailable (dev mode)');
      }
    } catch (e) {
      console.warn('[GarageManager] Cloud save failed:', e);
    }
  }

  async cloudLoad() {
    try {
      if (window.CrazyGames?.SDK?.user) {
        const result = await window.CrazyGames.SDK.user.load({ slot: 0 });
        if (result?.data) {
          this._save = JSON.parse(result.data);
          SaveSchema.save(this._save);
          console.info('[GarageManager] Cloud load OK');
          return true;
        }
      }
    } catch (e) {
      console.warn('[GarageManager] Cloud load failed:', e);
    }
    return false;
  }
}
