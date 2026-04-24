/**
 * GarageUI.js
 * DOM-based neon terminal overlay for the Garage and Upgrade system.
 * Requires garage.css (imported via `import '../ui/garage.css'` in main.js).
 *
 * Communicates with the game engine purely through constructor callback hooks
 * so the UI layer remains decoupled from physics / audio / SDK modules.
 */

import { UPGRADES, upgradeCost }  from '../game/GarageManager.js';
import { VEHICLE_TIERS }          from '../game/ProgressionSystem.js';
import { isSaveIncognito }        from '../persistence/saveSchema.js';

export class GarageUI {
  /**
   * @param {import('../game/GarageManager').GarageManager} garageManager
   * @param {object} hooks
   * @param {()=>void}                            hooks.onOpen
   * @param {()=>void}                            hooks.onClose
   * @param {(done:()=>void)=>void}               hooks.onScrapDoubler
   * @param {()=>void}                            hooks.onCloudSave
   * @param {{ vehicle?:any, voxelVehicle?:any }} hooks.live
   */
  constructor(garageManager, hooks = {}) {
    this.gm    = garageManager;
    this.hooks = hooks;
    this._open = false;

    this._buildDOM();
    this._bindManagerCallbacks();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    this._overlay = document.createElement('div');
    this._overlay.id = 'garage-overlay';
    this._overlay.classList.add('hidden');
    this._overlay.setAttribute('role', 'dialog');
    this._overlay.setAttribute('aria-modal', 'true');
    this._overlay.setAttribute('aria-label', 'Garage');

    const panel = document.createElement('div');
    panel.className = 'garage-panel';
    panel.innerHTML = `
      <div class="incognito-banner" id="gu-incog-banner">
        ⚠ PRIVATE MODE DETECTED — Progress is not saved permanently this session.
      </div>
      <div class="garage-header">
        <span class="garage-title">⚙ GARAGE</span>
        <span class="garage-scrap" id="gu-scrap">⬡ ${this.gm.scrap} SCRAP</span>
        <button class="garage-close-btn" id="gu-close" aria-label="Close garage">✕</button>
      </div>
      <div class="garage-section-title">▸ Vehicle Bay</div>
      <div class="car-grid" id="gu-cars"></div>
      <div class="garage-section-title">▸ Upgrades</div>
      <div class="upgrade-list" id="gu-upgrades"></div>
      <div class="scrap-doubler">
        <div class="scrap-doubler-text">
          📺 Watch a short ad — earn <strong>+500 SCRAP</strong> instantly.
        </div>
        <button class="neon-btn gold-btn" id="gu-doubler-btn">WATCH AD</button>
      </div>
      <div class="garage-footer">
        <button class="neon-btn silver-btn" id="gu-cloud-save">☁ CLOUD SAVE</button>
      </div>
    `;

    this._overlay.appendChild(panel);
    document.body.appendChild(this._overlay);

    document.getElementById('gu-close')
      .addEventListener('click', () => this.close());

    document.getElementById('gu-doubler-btn')
      .addEventListener('click', () => {
        this.hooks.onScrapDoubler?.(() => {
          this._refreshScrap();
          this._flash(document.getElementById('gu-scrap'));
          this._chirp();
        });
      });

    document.getElementById('gu-cloud-save')
      .addEventListener('click', () => this.hooks.onCloudSave?.());

    // Close when clicking the dark backdrop (not the panel itself)
    this._overlay.addEventListener('click', e => {
      if (e.target === this._overlay) this.close();
    });

    // Escape key closes the overlay
    this._escHandler = e => { if (e.code === 'Escape' && this._open) this.close(); };
    window.addEventListener('keydown', this._escHandler);
  }

  // ── Car grid ──────────────────────────────────────────────────────────────

  _renderCars() {
    const container = document.getElementById('gu-cars');
    if (!container) return;
    container.innerHTML = '';

    for (const tier of Object.values(VEHICLE_TIERS)) {
      const owned    = this.gm.ownedCars.includes(tier.id);
      const selected = this.gm.selectedCar === tier.id;

      const card = document.createElement('div');
      card.className = ['car-card', selected ? 'selected' : '', !owned ? 'locked' : '']
        .filter(Boolean).join(' ');

      card.innerHTML = `
        <div class="car-name">${tier.name.toUpperCase()}</div>
        <div class="car-desc">${tier.description}</div>
        ${selected
          ? `<span class="car-badge" style="color:var(--neon)">✔</span>`
          : !owned ? `<span class="car-badge">🔒</span>` : ''}
      `;

      if (!owned) {
        const btn = this._btn(`UNLOCK — ${tier.unlockCost} ⬡`, 'gold-btn',
          this.gm.scrap < tier.unlockCost);
        btn.style.cssText = 'margin-top:8px;width:100%;font-size:10px;';
        btn.addEventListener('click', e => {
          e.stopPropagation();
          if (this.gm.unlockCar(tier.id)) {
            this._chirp(); this._renderCars(); this._refreshScrap();
          }
        });
        card.appendChild(btn);
      } else if (!selected) {
        const btn = this._btn('SELECT', '', false);
        btn.style.cssText = 'margin-top:8px;width:100%;font-size:10px;';
        btn.addEventListener('click', e => {
          e.stopPropagation();
          if (this.gm.selectCar(tier.id)) this._renderCars();
        });
        card.appendChild(btn);
      }

      container.appendChild(card);
    }
  }

  // ── Upgrade list ──────────────────────────────────────────────────────────

  _renderUpgrades() {
    const container = document.getElementById('gu-upgrades');
    if (!container) return;
    container.innerHTML = '';

    for (const [id, upg] of Object.entries(UPGRADES)) {
      const lvl    = this.gm.getUpgradeLevel(id);
      const maxed  = lvl >= upg.maxLevel;
      const cost   = upgradeCost(id, lvl);
      const canBuy = !maxed && this.gm.scrap >= cost;

      const pips = Array.from({ length: upg.maxLevel }, (_, i) =>
        `<span class="pip ${i < lvl ? 'filled' : ''}"></span>`
      ).join('');

      const card = document.createElement('div');
      card.className = 'upgrade-card';

      card.innerHTML = `
        <div class="upgrade-icon">${upg.icon}</div>
        <div class="upgrade-info">
          <div class="upgrade-name">${upg.name.toUpperCase()}</div>
          <div class="upgrade-desc">${upg.description}</div>
          <div class="upgrade-pips">${pips}</div>
          <div class="upgrade-cost">
            ${maxed
              ? '<span style="color:var(--neon);opacity:0.55">MAX LEVEL</span>'
              : `Cost: <span style="color:var(--gold)">${cost} ⬡</span>`}
          </div>
        </div>
      `;

      const buyBtn = this._btn(maxed ? 'MAXED' : 'BUY', '', !canBuy);
      buyBtn.addEventListener('click', () => {
        const ok = this.gm.purchase(id, this.hooks.live ?? {});
        if (ok) {
          this._chirp();
          this._flash(card);
          this._renderUpgrades();
          this._refreshScrap();
          // Trigger armor-plate visual update on VoxelVehicle
          if (id === 'armorDensity' && this.hooks.live?.voxelVehicle) {
            this.hooks.live.voxelVehicle.applyArmorVisual(this.gm.getUpgradeLevel(id));
          }
        }
      });

      card.appendChild(buyBtn);
      container.appendChild(card);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Create a styled neon button element.
   * @param {string}  label
   * @param {string}  extraClass
   * @param {boolean} disabled
   * @returns {HTMLButtonElement}
   */
  _btn(label, extraClass, disabled) {
    const b = document.createElement('button');
    b.className  = `neon-btn ${extraClass}`.trim();
    b.textContent = label;
    b.disabled   = disabled;
    return b;
  }

  /** Update scrap display and re-evaluate all button disabled states. */
  _refreshScrap() {
    const el = document.getElementById('gu-scrap');
    if (el) el.textContent = `⬡ ${this.gm.scrap} SCRAP`;
    this._renderUpgrades();
    this._renderCars();
  }

  /** Brief CSS glow flash on an element after a successful purchase. */
  _flash(el) {
    if (!el) return;
    el.classList.remove('purchase-flash');
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add('purchase-flash');
  }

  /**
   * Procedural "neon chirp" success sound via Web Audio API.
   * Self-contained — no dependency on the game's AudioManager.
   */
  _chirp() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880,  ctx.currentTime);
      osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.05);
      osc.frequency.setValueAtTime(1760, ctx.currentTime + 0.09);
      env.gain.setValueAtTime(0.14, ctx.currentTime);
      env.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      osc.connect(env);
      env.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
      osc.onended = () => ctx.close();
    } catch { /* silent fallback if AudioContext unavailable */ }
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  open() {
    if (this._open) return;
    this._open = true;

    // Show incognito warning inside the panel if applicable
    const banner = document.getElementById('gu-incog-banner');
    if (banner) banner.classList.toggle('visible', isSaveIncognito());

    this._renderUpgrades();
    this._renderCars();
    this._refreshScrap();
    this._overlay.classList.remove('hidden');
    this.hooks.onOpen?.();

    // Move focus to close button for keyboard accessibility
    requestAnimationFrame(() => document.getElementById('gu-close')?.focus());
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._overlay.classList.add('hidden');
    this.hooks.onClose?.();
  }

  get isOpen() { return this._open; }

  // ── Manager callbacks ─────────────────────────────────────────────────────

  _bindManagerCallbacks() {
    this.gm.onScrapChange(() => { if (this._open) this._refreshScrap(); });
    this.gm.onUpgrade(()     => { if (this._open) this._renderUpgrades(); });
  }

  dispose() {
    window.removeEventListener('keydown', this._escHandler);
    this._overlay?.remove();
  }
}
