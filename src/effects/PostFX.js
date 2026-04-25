/**
 * PostFX.js
 * EffectComposer post-processing pipeline:
 *   - UnrealBloomPass (neon glow)
 *   - Hooks for impact flash / chromatic aberration pulse
 *
 * Uses three/examples/jsm — no additional npm packages required.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass }     from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass }     from 'three/examples/jsm/postprocessing/OutputPass.js';

// ── Minimal chromatic-aberration shader ──────────────────────────────────────
const ChromaShader = {
  uniforms: {
    tDiffuse:  { value: null },
    /** 0 = no aberration, 1 = max aberration */
    uStrength: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec2 offset = (vUv - 0.5) * uStrength * 0.018;
      float r = texture2D(tDiffuse, vUv + offset).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - offset).b;
      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `,
};

// ── Radial blur shader (nitro / overdrive effect) ─────────────────────────────
const RadialBlurShader = {
  uniforms: {
    tDiffuse:  { value: null },
    /** 0 = off, >0 = zoom-blur amount */
    uStrength: { value: 0.0 },
    /** Normalized screen-space blur origin */
    uCenter:   { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    uniform vec2  uCenter;
    varying vec2 vUv;
    const int SAMPLES = 12;
    void main() {
      if (uStrength < 0.001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      vec2 dir   = vUv - uCenter;
      vec4 col   = vec4(0.0);
      float total = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        float t = float(i) / float(SAMPLES - 1);
        float w = 1.0 - t * 0.65;
        col   += texture2D(tDiffuse, vUv - dir * uStrength * t) * w;
        total += w;
      }
      gl_FragColor = col / total;
    }
  `,
};

// ── Minimal screen-flash / vignette shader ────────────────────────────────────
const FlashShader = {
  uniforms: {
    tDiffuse:   { value: null },
    uFlash:     { value: 0.0 },   // 0–1 white flash amount
    uFlashColor:{ value: new THREE.Color(1, 0.5, 0.1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uFlash;
    uniform vec3 uFlashColor;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(mix(base.rgb, uFlashColor, uFlash), 1.0);
    }
  `,
};

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this._chromaDecay = 0;
    this._flashDecay  = 0;
    this._radialStrength = 0;
    this._radialDuration = 0;
    this._radialAge      = 0;

    const size = new THREE.Vector2();
    renderer.getSize(size);

    this.composer = new EffectComposer(renderer);

    // 1) Base scene render
    this.composer.addPass(new RenderPass(scene, camera));

    // 2) Bloom (neon glow)
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      1.5,   // strength
      0.4,   // radius
      0.2    // threshold – low so emissive surfaces glow
    );
    this.composer.addPass(this.bloom);

    // 3) Chromatic aberration
    this.chromaPass = new ShaderPass(ChromaShader);
    this.chromaPass.uniforms.uStrength.value = 0;
    this.composer.addPass(this.chromaPass);

    // 4) Impact flash
    this.flashPass = new ShaderPass(FlashShader);
    this.flashPass.uniforms.uFlash.value = 0;
    this.composer.addPass(this.flashPass);

    // 5) Radial blur (nitro/overdrive — inactive by default)
    this.radialBlurPass = new ShaderPass(RadialBlurShader);
    this.radialBlurPass.uniforms.uStrength.value = 0;
    this.composer.addPass(this.radialBlurPass);

    // 6) Tone-mapping / output
    this.composer.addPass(new OutputPass());
  }

  /**
   * Trigger an impact flash + chromatic aberration pulse.
   * @param {number} impulse - collision impulse (scales effect strength)
   * @param {THREE.Color} [color] - flash colour (default orange)
   */
  triggerImpactFlash(impulse, color) {
    const strength = Math.min(impulse / 120, 1.0);
    this._chromaDecay = strength * 1.2;
    this._flashDecay  = strength * 0.8;

    if (color) this.flashPass.uniforms.uFlashColor.value.copy(color);
    else this.flashPass.uniforms.uFlashColor.value.set(1, 0.5, 0.1);
  }

  /**
   * Extra chromatic-aberration spike for very heavy hits (> 60 N·s).
   * @param {number} strength  0–1
   */
  triggerChromaticSpike(strength) {
    this._chromaDecay = Math.max(this._chromaDecay, strength * 1.8);
    this.chromaPass.uniforms.uStrength.value = this._chromaDecay;
  }

  /**
   * Trigger a radial-zoom blur for nitro / overdrive activation.
   * @param {number} strength   0–1 blur intensity
   * @param {number} [duration] seconds over which the blur fades out
   */
  triggerRadialBlur(strength, duration = 0.35) {
    this._radialStrength = Math.min(Math.max(strength, 0), 1);
    this._radialDuration = Math.max(duration, 0.05);
    this._radialAge      = 0;
  }

  /**
   * Directly set bloom strength (e.g. for neon overdrive effect).
   * @param {number} strength
   */
  setBloomStrength(strength) {
    this.bloom.strength = strength;
  }

  /**
   * Advance decay timers and render through the composer.
   * @param {number} dt
   */
  update(dt) {
    // Chromatic aberration decay
    this._chromaDecay = Math.max(0, this._chromaDecay - dt * 4);
    this.chromaPass.uniforms.uStrength.value = this._chromaDecay;

    // Flash decay
    this._flashDecay = Math.max(0, this._flashDecay - dt * 6);
    this.flashPass.uniforms.uFlash.value = this._flashDecay;

    // Radial blur decay (quadratic ease-out over _radialDuration)
    if (this._radialAge < this._radialDuration) {
      this._radialAge = Math.min(this._radialAge + dt, this._radialDuration);
      const t = this._radialAge / this._radialDuration;
      this.radialBlurPass.uniforms.uStrength.value =
        this._radialStrength * (1 - t * t) * 0.22;
    } else if (this.radialBlurPass.uniforms.uStrength.value > 0) {
      this.radialBlurPass.uniforms.uStrength.value = 0;
    }
  }

  /** Render one frame through the full post-processing stack. */
  render() {
    this.composer.render();
  }

  /** Resize the composer when the window resizes. */
  resize(w, h) {
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  dispose() {
    this.composer.dispose();
  }
}
