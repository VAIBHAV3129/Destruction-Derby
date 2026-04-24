/**
 * AudioManager.js
 * Web Audio API based sound system.
 *
 * Features:
 *  - Positional-ish gain/panning tied to world positions
 *  - Dynamic impact layering (metal snap + low thud)
 *  - EngineAudio class with BiquadFilter pitch response to speed
 *  - Ambient power hum with glitch on large explosion
 *  - Procedural laser-spark oscillator
 */

// ── Reusable scratch ──────────────────────────────────────────────────────────
const _MAX_DIST = 60; // metres — beyond this, audio is inaudible

export class AudioManager {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.masterGain = null;

    /** Listener world position (set each frame) */
    this.listenerPos = { x: 0, y: 0, z: 0 };

    /** @type {EngineAudio|null} */
    this.engine = null;

    /** @type {AmbientHum|null} */
    this.ambient = null;
  }

  /**
   * Must be called from a user-gesture handler (click/keydown) to resume
   * the AudioContext on browsers that require it.
   */
  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8;
    this.masterGain.connect(this.ctx.destination);

    this.engine  = new EngineAudio(this.ctx, this.masterGain);
    this.ambient = new AmbientHum(this.ctx, this.masterGain);
  }

  /** Resume context after browser suspension. */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /**
   * Calculate gain [0,1] and panning [-1,1] based on source distance from listener.
   * @param {{x:number,y:number,z:number}} sourcePos
   * @returns {{gain:number, pan:number}}
   */
  _spatialize(sourcePos) {
    const dx = sourcePos.x - this.listenerPos.x;
    const dz = sourcePos.z - this.listenerPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const gain = Math.max(0, 1 - dist / _MAX_DIST);
    // Simple left/right panning from horizontal angle
    const pan  = Math.max(-1, Math.min(1, dx / (_MAX_DIST * 0.5)));
    return { gain, pan };
  }

  /**
   * Play a layered metal-impact sound.
   * @param {number} force      - collision impulse magnitude
   * @param {string} [material] - 'metal'|'concrete'|'default'
   * @param {{x,y,z}} [pos]    - world position
   */
  playImpactSound(force, material = 'metal', pos = null) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const { gain: spatGain, pan } = pos ? this._spatialize(pos) : { gain: 1, pan: 0 };

    if (spatGain < 0.01) return;

    const vol = Math.min(force / 80, 1.0) * spatGain;

    // ── Low-frequency thud ────────────────────────────────────────────────
    this._syntheticImpact(now, {
      freq:       material === 'concrete' ? 60 : 80,
      gain:       vol * 0.6,
      duration:   0.18,
      filterType: 'lowpass',
      filterFreq: 200,
      pan,
    });

    // ── High-frequency metal snap ─────────────────────────────────────────
    this._syntheticImpact(now, {
      freq:       material === 'concrete' ? 1200 : 1800,
      gain:       vol * 0.35,
      duration:   0.08,
      filterType: 'bandpass',
      filterFreq: 3000,
      pan,
    });

    // ── Mechanical voxel-shed snap (only for heavy impacts) ───────────────
    if (force > 50) {
      this._syntheticImpact(now + 0.04, {
        freq:       4500,
        gain:       vol * 0.2,
        duration:   0.05,
        filterType: 'highpass',
        filterFreq: 3500,
        pan,
      });
      if (this.ambient) this.ambient.glitch();
    }
  }

  /**
   * Synthesise a percussive click/thud using a brief noise burst + envelope.
   * @private
   */
  _syntheticImpact(startTime, { freq, gain, duration, filterType, filterFreq, pan }) {
    const ctx = this.ctx;

    // Noise buffer (0.25s should be ample for any impact)
    const bufLen  = Math.ceil(ctx.sampleRate * 0.25);
    const buffer  = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data    = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src  = ctx.createBufferSource();
    src.buffer = buffer;

    const bpf = ctx.createBiquadFilter();
    bpf.type            = filterType;
    bpf.frequency.value = filterFreq;
    bpf.Q.value         = 1.5;

    const env  = ctx.createGain();
    env.gain.setValueAtTime(gain, startTime);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    const panner  = ctx.createStereoPanner();
    panner.pan.value = pan;

    src.connect(bpf);
    bpf.connect(env);
    env.connect(panner);
    panner.connect(this.masterGain);

    src.start(startTime);
    src.stop(startTime + duration + 0.01);
  }

  /**
   * Procedurally generate a "laser spark" sound using an oscillator.
   * No audio file needed.
   * @param {{x,y,z}} [pos]
   */
  playLaserSpark(pos = null) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const { gain: spatGain, pan } = pos ? this._spatialize(pos) : { gain: 1, pan: 0 };
    if (spatGain < 0.01) return;

    // Descending sine sweep: 3 kHz → 800 Hz over 0.12 s
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(3000, now);
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.12);

    // Add a little noise for the "spark" texture
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(2500, now);
    osc2.frequency.linearRampToValueAtTime(400, now + 0.08);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.18 * spatGain, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

    const env2 = ctx.createGain();
    env2.gain.setValueAtTime(0.06 * spatGain, now);
    env2.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;

    osc.connect(env);
    osc2.connect(env2);
    env.connect(panner);
    env2.connect(panner);
    panner.connect(this.masterGain);

    osc.start(now);  osc.stop(now + 0.15);
    osc2.start(now); osc2.stop(now + 0.10);
  }

  /**
   * Update listener position (call from main loop with camera/player position).
   * @param {{x,y,z}} pos
   */
  setListenerPosition(pos) {
    this.listenerPos = pos;
  }

  /**
   * Update engine audio (call from main loop).
   * @param {number} speed - vehicle speed m/s
   */
  updateEngine(speed) {
    if (this.engine) this.engine.update(speed);
  }

  dispose() {
    if (this.engine)  this.engine.dispose();
    if (this.ambient) this.ambient.dispose();
    if (this.ctx)     this.ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * EngineAudio — continuous mechanical hum with BiquadFilter pitch-response.
 */
export class EngineAudio {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination
   */
  constructor(ctx, destination) {
    this.ctx = ctx;

    // Oscillator stack: fundamental + harmonic
    this._osc1 = ctx.createOscillator();
    this._osc1.type = 'sawtooth';
    this._osc1.frequency.value = 55; // ~idle RPM hum

    this._osc2 = ctx.createOscillator();
    this._osc2.type = 'square';
    this._osc2.frequency.value = 110;

    // BiquadFilter — simulate resonant engine body
    this._filter = ctx.createBiquadFilter();
    this._filter.type = 'bandpass';
    this._filter.frequency.value = 200;
    this._filter.Q.value = 3;

    const gain = ctx.createGain();
    gain.gain.value = 0.06;

    this._osc1.connect(this._filter);
    this._osc2.connect(this._filter);
    this._filter.connect(gain);
    gain.connect(destination);

    this._osc1.start();
    this._osc2.start();
  }

  /**
   * Adjust pitch and filter cutoff based on speed.
   * @param {number} speed - m/s
   */
  update(speed) {
    const clampedSpeed = Math.max(0, Math.min(speed, 50));
    const t = clampedSpeed / 50; // 0–1

    // RPM mapping: idle 55 Hz → peak 220 Hz
    const freq = 55 + t * 165;
    const now  = this.ctx.currentTime;
    this._osc1.frequency.setTargetAtTime(freq,       now, 0.1);
    this._osc2.frequency.setTargetAtTime(freq * 2,   now, 0.1);
    this._filter.frequency.setTargetAtTime(150 + t * 3000, now, 0.1);
  }

  dispose() {
    this._osc1.stop();
    this._osc2.stop();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * AmbientHum — background power hum with glitch on large explosions.
 */
class AmbientHum {
  constructor(ctx, destination) {
    this.ctx = ctx;

    this._osc = ctx.createOscillator();
    this._osc.type = 'sine';
    this._osc.frequency.value = 50;

    this._gain = ctx.createGain();
    this._gain.gain.value = 0.025;

    this._osc.connect(this._gain);
    this._gain.connect(destination);
    this._osc.start();
  }

  /** Briefly stutter the hum frequency on large explosions. */
  glitch() {
    const now = this.ctx.currentTime;
    this._osc.frequency.setValueAtTime(50,  now);
    this._osc.frequency.setValueAtTime(120, now + 0.03);
    this._osc.frequency.setValueAtTime(30,  now + 0.07);
    this._osc.frequency.setValueAtTime(50,  now + 0.12);
  }

  dispose() {
    this._osc.stop();
  }
}
