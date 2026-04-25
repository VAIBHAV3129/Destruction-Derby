/**
 * saveSchema.js
 * Versioned save data schema with migration helpers.
 *
 * Design:
 *  - Schema version is stored in `meta.schemaVersion`.
 *  - Permanent progression (scrap/unlocks) is in `progression`.
 *  - Ephemeral run-state is NOT persisted (debris, live voxels, etc.).
 *  - Unknown keys (future upgrades/tiers) are preserved when loading older saves.
 *  - Migration chain: v1 → v2 → … runs automatically on load.
 */

const STORAGE_KEY    = 'neonDebris_save';
const CURRENT_VERSION = 2;

// ── Default save object ───────────────────────────────────────────────────────
function createDefaultSave() {
  return {
    meta: {
      schemaVersion: CURRENT_VERSION,
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
    },
    progression: {
      /** Total scrap currency */
      scrap: 0,
      /** Array of unlocked vehicle tier IDs */
      unlockedVehicles: ['scout'],
      /** Currently selected tier */
      selectedVehicle: 'scout',
      /** Highest level index reached (0-based) */
      highestLevel: 0,
      /** Per-upgrade purchased flags (future-proof: add keys freely) */
      upgrades: {},
    },
    /**
     * Statistics — never affect gameplay, useful for display.
     * Add new keys freely; old clients will ignore unknown ones.
     */
    stats: {
      totalVoxelsDestroyed: 0,
      totalScrapEarned: 0,
      totalPlaytimeSeconds: 0,
    },
  };
}

// ── Migration functions ───────────────────────────────────────────────────────

/**
 * Migrate a v1 save to v2.
 * v1 did not have `stats` or `progression.upgrades` — add them safely.
 * @param {object} save
 * @returns {object}
 */
function migrateV1ToV2(save) {
  // Add stats block if missing
  if (!save.stats) {
    save.stats = {
      totalVoxelsDestroyed: 0,
      totalScrapEarned: 0,
      totalPlaytimeSeconds: 0,
    };
  }
  // Add upgrades map if missing
  if (!save.progression.upgrades) {
    save.progression.upgrades = {};
  }
  // Ensure selectedVehicle exists
  if (!save.progression.selectedVehicle) {
    save.progression.selectedVehicle = save.progression.unlockedVehicles?.[0] ?? 'scout';
  }
  save.meta.schemaVersion = 2;
  return save;
}

/** Chain of migration functions indexed by fromVersion. */
const MIGRATIONS = {
  1: migrateV1ToV2,
  // v2 → v3 placeholder:
  // 2: migrateV2ToV3,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Best-effort private-browsing detection.
 * Returns true when localStorage is unavailable (Safari private mode) or
 * when the storage quota is zero. Returns false otherwise (Chrome / Firefox
 * incognito still allow localStorage; they just do not persist it).
 * @returns {boolean}
 */
export function isSaveIncognito() {
  try {
    const testKey = '__nd_priv__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
    return false;
  } catch {
    // Safari private mode throws a SecurityError / QuotaExceededError here
    return true;
  }
}

export class SaveSchema {
  /**
   * Load the save from localStorage, run any needed migrations, and return it.
   * Returns a fresh default save if nothing is stored.
   * @returns {ReturnType<typeof createDefaultSave>}
   */
  static load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultSave();

      let save = JSON.parse(raw);

      // Run migration chain
      let version = save?.meta?.schemaVersion ?? 1;
      while (version < CURRENT_VERSION) {
        const migrateFn = MIGRATIONS[version];
        if (migrateFn) {
          save = migrateFn(save);
        } else {
          // No migration available — bump version and continue
          save.meta.schemaVersion = version + 1;
        }
        version = save.meta.schemaVersion;
      }

      // Merge in any missing top-level keys from defaults (forward-compat)
      const defaults = createDefaultSave();
      return SaveSchema._deepMergeDefaults(save, defaults);
    } catch (e) {
      console.warn('[SaveSchema] Failed to load save, resetting:', e);
      return createDefaultSave();
    }
  }

  /**
   * Persist the save object to localStorage.
   * @param {object} save
   */
  static save(save) {
    try {
      save.meta.updatedAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(save));
    } catch (e) {
      console.warn('[SaveSchema] Failed to persist save:', e);
    }
  }

  /** Wipe the save (for testing or "New Game"). */
  static reset() {
    localStorage.removeItem(STORAGE_KEY);
  }

  /**
   * Deep-merge `defaults` into `target`, adding any missing keys.
   * Existing keys in `target` (including unknown future keys) are preserved.
   * @private
   */
  static _deepMergeDefaults(target, defaults) {
    for (const key of Object.keys(defaults)) {
      if (!(key in target)) {
        target[key] = defaults[key];
      } else if (
        typeof defaults[key] === 'object' &&
        defaults[key] !== null &&
        !Array.isArray(defaults[key]) &&
        typeof target[key] === 'object' &&
        target[key] !== null &&
        !Array.isArray(target[key])
      ) {
        SaveSchema._deepMergeDefaults(target[key], defaults[key]);
      }
    }
    return target;
  }
}
