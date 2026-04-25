/**
 * CrazyGamesSDK.js
 * Safe wrapper around CrazyGames SDK v3.
 *
 * Key v3 changes vs v2:
 *  - SDK must be initialised with `await SDK.init()` before any other call.
 *  - Both midgame and rewarded ads use `SDK.ad.requestAd(type, callbacks)`.
 *
 * All calls gracefully no-op when the SDK is absent (local dev).
 * Exports `runSitelock()` — call it as the very first executable
 * statement in main.js to block unauthorized domains immediately.
 */

// ── Sitelock ──────────────────────────────────────────────────────────────────

/** Domains authorised to run this game. */
// CrazyGamesSDK.js - Around line 17
const ALLOWED_HOSTS = [
  'crazygames.com', 
  'localhost', 
  '127.0.0.1', 
  'webcontainer.io', // StackBlitz's engine domain
  'stackblitz.io'    // StackBlitz's UI domain
];

/**
 * Block execution on unauthorised domains.
 * Replaces page content with an error overlay and throws so the
 * module import chain halts.
 */
export function runSitelock() {
  const host = window.location.hostname;
  const ok   = ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  if (!ok) {
    _renderSitelockOverlay(host);
    throw new Error(`[Sitelock] Unauthorised domain: ${host}`);
  }
}

function _renderSitelockOverlay(host) {
  document.body.innerHTML = `
    <div style="
      position:fixed;inset:0;background:#000;z-index:9999;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      color:#ff3300;font-family:'Courier New',monospace;text-align:center;gap:18px;padding:24px;
    ">
      <div style="font-size:36px">⛔</div>
      <div style="font-size:22px;letter-spacing:3px">UNAUTHORIZED HOST</div>
      <div style="font-size:13px;opacity:0.75;max-width:380px;line-height:1.6">
        This build is not licensed to run on <strong>${host}</strong>.<br>
        Play the official version at
        <a href="https://www.crazygames.com" style="color:#ff6600">CrazyGames.com</a>
      </div>
    </div>`;
}

// ── SDK availability ──────────────────────────────────────────────────────────

/** @returns {boolean} */
function _sdkReady() {
  return typeof window !== 'undefined' && !!window.CrazyGames?.SDK;
}

// ── CrazyGamesSDK class ───────────────────────────────────────────────────────

export class CrazyGamesSDK {
  constructor() {
    /** Whether the SDK currently considers gameplay active */
    this._active      = false;
    /** Whether SDK.init() has completed */
    this._initialized = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Initialise the CrazyGames SDK v3.
   * MUST be awaited before any other SDK call (gameplay events, ads, etc.).
   * Safe to call in dev where the script is absent — resolves immediately.
   */
  async init() {
    if (this._initialized) return;
    try {
      if (_sdkReady()) {
        await window.CrazyGames.SDK.init();
        console.info('[SDK] Initialized (v3)');
      } else {
        console.info('[SDK] SDK script not loaded — running in dev mode');
      }
    } catch (e) {
      console.warn('[SDK] init() error (non-fatal):', e);
    }
    this._initialized = true;
  }

  // ── Gameplay events ─────────────────────────────────────────────────────────

  /**
   * Signal active gameplay.
   * MUST be triggered by the player's first "Drive" action —
   * never called automatically on load or after the loading screen.
   */
  gameplayStart() {
    if (this._active) return;
    this._active = true;
    try {
      if (_sdkReady()) window.CrazyGames.SDK.game.gameplayStart();
      else console.info('[SDK] gameplayStart — SDK not loaded (dev)');
    } catch (e) {
      console.warn('[SDK] gameplayStart error:', e);
    }
  }

  /**
   * Signal gameplay has paused (shop opened, pause menu, ad playing, etc.).
   * Always paired with a subsequent gameplayStart() when play resumes.
   */
  gameplayStop() {
    if (!this._active) return;
    this._active = false;
    try {
      if (_sdkReady()) window.CrazyGames.SDK.game.gameplayStop();
      else console.info('[SDK] gameplayStop — SDK not loaded (dev)');
    } catch (e) {
      console.warn('[SDK] gameplayStop error:', e);
    }
  }

  /** @returns {boolean} true while gameplay is active */
  get isPlaying() { return this._active; }

  // ── Ads ─────────────────────────────────────────────────────────────────────

  /**
   * Show a midgame ad (interstitial).
   * Per CrazyGames policy:
   *  - `gameplayStop()` must be called before the ad.
   *  - Game audio MUST be muted while the ad plays.
   *  - `gameplayStart()` is called automatically when the ad finishes/errors.
   *
   * @param {()=>void} [onAudioMute]   - called to mute game audio before ad
   * @param {()=>void} [onAudioResume] - called to restore audio after ad
   */
  showMidgameAd(onAudioMute, onAudioResume) {
    if (!_sdkReady()) {
      // Dev simulation — briefly mute/resume with no real ad
      console.info('[SDK] showMidgameAd — simulated in dev (skipped)');
      onAudioMute?.();
      setTimeout(() => { onAudioResume?.(); }, 600);
      return;
    }

    // Per spec: stop gameplay and mute audio before the ad starts
    onAudioMute?.();
    this.gameplayStop();

    window.CrazyGames.SDK.ad.requestAd('midgame', {
      adStarted:  ()    => onAudioMute?.(),
      adFinished: ()    => { onAudioResume?.(); this.gameplayStart(); },
      adError:    (err) => {
        console.warn('[SDK] midgame ad error:', err);
        onAudioResume?.();
        this.gameplayStart();
      },
    });
  }

  /**
   * Show a rewarded video ad.
   * Per CrazyGames policy:
   *  - Game audio MUST be muted before the ad.
   *  - `onReward` is only called if the user watches the full ad.
   *  - `gameplayStart()` is called automatically when the ad finishes/errors.
   *
   * @param {()=>void}  onReward       - called if the user completes the ad
   * @param {()=>void}  [onAudioMute]  - called to mute game audio
   * @param {()=>void}  [onAudioResume]- called after ad to restore audio
   */
  showRewardedAd(onReward, onAudioMute, onAudioResume) {
    if (!_sdkReady()) {
      // Dev simulation — reward instantly after a short delay
      console.info('[SDK] showRewardedAd — simulated in dev (instant reward)');
      onAudioMute?.();
      setTimeout(() => { onAudioResume?.(); onReward?.(); }, 800);
      return;
    }

    // Mute audio + pause gameplay before ad starts
    onAudioMute?.();
    this.gameplayStop();

    window.CrazyGames.SDK.ad.requestAd('rewarded', {
      adStarted:  ()    => onAudioMute?.(),
      adFinished: ()    => { onAudioResume?.(); onReward?.(); this.gameplayStart(); },
      adError:    (err) => {
        console.warn('[SDK] rewarded ad error:', err);
        onAudioResume?.();
        this.gameplayStart();
      },
    });
  }

  /**
   * @deprecated Use showRewardedAd() — kept for backwards compatibility.
   * @param {()=>void}  onReward
   * @param {()=>void}  [onAudioMute]
   * @param {()=>void}  [onAudioResume]
   */
  showRewardedVideo(onReward, onAudioMute, onAudioResume) {
    return this.showRewardedAd(onReward, onAudioMute, onAudioResume);
  }

  // ── Adblock detection ───────────────────────────────────────────────────────

  /**
   * Non-blocking adblock detection.
   * @returns {Promise<boolean>}
   */
  async isAdblockEnabled() {
    try {
      if (_sdkReady()) return await window.CrazyGames.SDK.ad.isAdblockEnabled();
    } catch { /* ignore */ }
    return false;
  }
}
