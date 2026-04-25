/**
 * main.js
 * Entry point for Neon Debris: Voxel Derby
 *
 * Bootstrap order:
 *  1. Sitelock check
 *  2. Loading screen
 *  3. Three.js renderer / camera / scene (black + neon grid floor)
 *  4. PhysicsManager (async Rapier init)
 *  5. PostFX composer
 *  6. GarageManager + Vehicle + VoxelVehicle (apply saved upgrades)
 *  7. FXManager — sparks, voxel trails, ghost trail
 *  8. LevelManager + LevelLoader
 *  9. CrazyGamesSDK + AudioManager + GarageUI
 * 10. RAF main loop with fixed-step physics + frame-budget guard
 */

import * as THREE from 'three';
import { PhysicsManager }             from './physics/PhysicsManager.js';
import { Vehicle }                    from './vehicles/Vehicle.js';
import { VoxelVehicle }               from './vehicles/VoxelVehicle.js';
import { PostFX }                     from './effects/PostFX.js';
import { FXManager }                  from './effects/FXManager.js';
import { AudioManager }               from './audio/AudioManager.js';
import { LevelManager, VEHICLE_TIERS } from './game/ProgressionSystem.js';
import { LevelLoader }                from './game/LevelLoader.js';
import { GarageManager }              from './game/GarageManager.js';
import { GarageUI }                   from './ui/GarageUI.js';
import { runSitelock, CrazyGamesSDK } from './game/CrazyGamesSDK.js';
import { isSaveIncognito }            from './persistence/saveSchema.js';
import './ui/garage.css';

// ── Sitelock: block unauthorised domains immediately ──────────────────────────
runSitelock();

// ── Frame budget guard ────────────────────────────────────────────────────────
const FRAME_BUDGET_MS = 12;

// ── HUD references ─────────────────────────────────────────────────────────────
const hudLevel    = document.getElementById('hud-level');
const hudScrap    = document.getElementById('hud-scrap');
const hudVoxels   = document.getElementById('hud-voxels');
const hudDest     = document.getElementById('hud-dest');
const hudProgress = document.getElementById('hud-progress-bar');
const loadingEl   = document.getElementById('loading-screen');
const loadingBar  = document.getElementById('loading-bar');
const loadingTxt  = document.getElementById('loading-text');

function setLoadingProgress(pct, msg) {
  if (loadingBar) loadingBar.style.width = pct + '%';
  if (loadingTxt) loadingTxt.textContent = msg;
}

// ── Camera shake state ────────────────────────────────────────────────────────
let _shakeIntensity = 0;
let _shakeDecay     = 0;

// ── Hit-stop state ────────────────────────────────────────────────────────────
let _hitStopFrames = 0;

// ── Pause / gameplay session state ────────────────────────────────────────────
let _paused          = false;
let _gameplayStarted = false;

// ── Shared impact context (set before processImpact, read in onVoxelDetached) ─
let _currentImpulse = 0;

// ── Pause overlay helper ──────────────────────────────────────────────────────
function _updatePauseOverlay() {
  const el = document.getElementById('pause-overlay');
  if (el) el.classList.toggle('visible', _paused);
}

// ── Mobile controls setup ─────────────────────────────────────────────────────
function _setupMobileControls(keys) {
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const mcEl = document.getElementById('mobile-controls');
  if (isTouchDevice && mcEl) mcEl.classList.add('visible');

  const bindBtn = (id, code) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', e => {
      e.preventDefault();
      keys[code] = true;
      el.classList.add('pressed');
    }, { passive: false });
    const release = e => {
      if (e) e.preventDefault();
      keys[code] = false;
      el.classList.remove('pressed');
    };
    el.addEventListener('touchend',   release, { passive: false });
    el.addEventListener('touchcancel', release);
  };

  bindBtn('mc-drive', 'KeyW');
  bindBtn('mc-brake', 'Space');
  bindBtn('mc-left',  'ArrowLeft');
  bindBtn('mc-right', 'ArrowRight');
}

// ── Main bootstrap ────────────────────────────────────────────────────────────
async function main() {
  setLoadingProgress(5, 'Initializing renderer…');

  // ── Renderer ─────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace  = THREE.SRGBColorSpace;
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  document.getElementById('canvas-container').appendChild(renderer.domElement);

  // ── Scene ─────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // ── Camera ────────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 8, -18);
  camera.lookAt(0, 0, 0);

  // ── Lighting ──────────────────────────────────────────────────────────────
  const ambient = new THREE.AmbientLight(0x001428, 0.15);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(8, 20, 10);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far  = 100;
  dirLight.shadow.camera.left = dirLight.shadow.camera.bottom = -30;
  dirLight.shadow.camera.right= dirLight.shadow.camera.top    =  30;
  scene.add(dirLight);

  // Neon point lights
  const neonA = new THREE.PointLight(0x00f0ff, 3, 40);
  neonA.position.set(-8, 3, 0);
  scene.add(neonA);
  const neonB = new THREE.PointLight(0x8800ff, 2, 30);
  neonB.position.set(8, 3, 0);
  scene.add(neonB);

  setLoadingProgress(20, 'Building scene…');

  // ── Neon grid floor ───────────────────────────────────────────────────────
  _buildGridFloor(scene);

  setLoadingProgress(35, 'Initializing physics…');

  // ── Physics ───────────────────────────────────────────────────────────────
  const physics = new PhysicsManager();
  await physics.init();

  // Static ground plane
  const groundBody = physics.createStaticBody({ x: 0, y: 0, z: 0 });
  physics.addBoxCollider(groundBody, { x: 60, y: 0.1, z: 60 }, 0.75, 0.1);

  setLoadingProgress(55, 'Building vehicle…');

  // ── Garage / progression ──────────────────────────────────────────────────
  const garageManager = new GarageManager();
  const levelManager  = new LevelManager();

  // ── Vehicle ───────────────────────────────────────────────────────────────
  const tierConfig = VEHICLE_TIERS[garageManager.selectedCar] ?? VEHICLE_TIERS.bruiser;
  const vehicle    = new Vehicle(physics, {
    mass:             tierConfig.mass,
    engineForce:      tierConfig.engineForce,
    brakeForce:       tierConfig.brakeForce,
    maxSteerAngle:    tierConfig.maxSteerAngle,
    lateralStiffness: tierConfig.lateralStiffness,
    suspension:       tierConfig.suspension,
  });
  vehicle.init({ x: 0, y: 2, z: 0 });

  // ── Voxel car ─────────────────────────────────────────────────────────────
  const voxelCar = new VoxelVehicle(physics, scene, {
    gridW: tierConfig.voxelGrid.w,
    gridH: tierConfig.voxelGrid.h,
    gridD: tierConfig.voxelGrid.d,
  });

  // Apply all saved upgrades (engine power, armor density, explosive force)
  garageManager.applyAllUpgrades({ vehicle, voxelVehicle: voxelCar });

  setLoadingProgress(70, 'Loading effects…');

  // ── Post-processing ───────────────────────────────────────────────────────
  const postFX = new PostFX(renderer, scene, camera);

  // ── FX Manager ────────────────────────────────────────────────────────────
  const fxManager = new FXManager(scene, postFX);

  // Wire shed-voxel → FXManager trail + secondary spark burst
  voxelCar.onVoxelDetached = (getPos) => {
    const p    = getPos();
    const wPos = p ? new THREE.Vector3(p.x, p.y, p.z) : new THREE.Vector3();
    fxManager.onVoxelDetached(wPos, _currentImpulse, getPos);
  };

  // ── Collision: voxel shedding + FX + audio ────────────────────────────────
  physics.onCollision(vehicle.body.handle, (otherHandle, started, impulse) => {
    if (!started || impulse < 5) return;

    const vehiclePos  = vehicle.getPosition();
    const vehicleQuat = vehicle.getQuaternion();

    // Approximate hit position at vehicle front
    const hitPos = vehiclePos.clone().add(
      new THREE.Vector3(0, 0, 2).applyQuaternion(vehicleQuat)
    );

    // Expose impulse to onVoxelDetached closure before calling processImpact
    _currentImpulse = impulse;
    const detached = voxelCar.processImpact(hitPos, vehiclePos, vehicleQuat, impulse);

    if (detached > 0) {
      // 20 % scrap chance per shed voxel
      let scrapGained = 0;
      for (let i = 0; i < detached; i++) {
        if (Math.random() < 0.20) scrapGained++;
      }
      if (scrapGained > 0) garageManager.addScrap(scrapGained);

      levelManager.recordDestruction(detached);
    }

    // FX: sparks + flash + chromatic aberration
    const linVel = vehicle.body.linvel();
    fxManager.onImpact(hitPos, impulse, linVel);

    // Audio
    audioManager.playImpactSound(impulse, 'metal', vehiclePos);

    if (impulse > 50) {
      audioManager.playLaserSpark(hitPos);
      _hitStopFrames  = 3;
      _shakeIntensity = Math.min(impulse / 40, 2.5);
      _shakeDecay     = 0;
    }
  });

  // ── Level loader ──────────────────────────────────────────────────────────
  const levelLoader = new LevelLoader(physics, scene);
  levelLoader.load(0, levelManager.environment, scene);

  levelManager.onLevelComplete(() => {
    console.info('[LevelManager] Level complete! Advancing…');
    levelManager.nextLevel();
    levelLoader.load(levelManager.levelNumber - 1, levelManager.environment, scene);
  });

  // ── CrazyGames SDK ────────────────────────────────────────────────────────
  const sdk = new CrazyGamesSDK();

  // ── Audio (initialised on first user interaction) ─────────────────────────
  const audioManager = new AudioManager();
  const initAudio = async () => {
    await audioManager.init();
  };
  window.addEventListener('keydown', initAudio, { once: true });
  window.addEventListener('click',   initAudio, { once: true });
  window.addEventListener('touchstart', initAudio, { once: true });

  // ── Garage UI ─────────────────────────────────────────────────────────────
  const garageUI = new GarageUI(garageManager, {
    onOpen: () => {
      _paused = true;
      sdk.gameplayStop();
    },
    onClose: () => {
      _paused = false;
      if (_gameplayStarted) sdk.gameplayStart();
    },
    onScrapDoubler: (done) => {
      sdk.showRewardedVideo(
        // onReward: credit +500 scrap and refresh the UI
        () => { garageManager.addScrap(500); done(); },
        // onAudioMute
        () => { if (audioManager.masterGain) audioManager.masterGain.gain.value = 0; },
        // onAudioResume
        () => { if (audioManager.masterGain) audioManager.masterGain.gain.value = 0.8; },
      );
    },
    onCloudSave: () => garageManager.cloudSave(),
    live: { vehicle, voxelVehicle: voxelCar },
  });

  // Garage open button
  document.getElementById('garage-open-btn')
    ?.addEventListener('click', () => garageUI.open());

  // Incognito warning
  if (isSaveIncognito()) {
    const el = document.getElementById('incognito-warning');
    if (el) el.classList.add('visible');
  }

  setLoadingProgress(100, 'Ready!');
  setTimeout(() => { if (loadingEl) loadingEl.style.display = 'none'; }, 400);

  // ── Input handling ─────────────────────────────────────────────────────────
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    audioManager.resume();

    if (e.code === 'KeyG' || e.code === 'Tab') {
      e.preventDefault();
      garageUI.isOpen ? garageUI.close() : garageUI.open();
    } else if (e.code === 'Escape') {
      if (garageUI.isOpen) {
        garageUI.close();
      } else {
        _paused = !_paused;
        _updatePauseOverlay();
        if (_paused) sdk.gameplayStop();
        else if (_gameplayStarted) sdk.gameplayStart();
      }
    } else if (e.code === 'KeyP') {
      if (!garageUI.isOpen) {
        _paused = !_paused;
        _updatePauseOverlay();
        if (_paused) sdk.gameplayStop();
        else if (_gameplayStarted) sdk.gameplayStart();
      }
    }
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  // ── Mobile controls ────────────────────────────────────────────────────────
  _setupMobileControls(keys);

  // Pause overlay buttons
  document.getElementById('pause-resume-btn')?.addEventListener('click', () => {
    _paused = false;
    _updatePauseOverlay();
    if (_gameplayStarted) sdk.gameplayStart();
  });
  document.getElementById('pause-garage-btn')?.addEventListener('click', () => {
    _paused = false;
    _updatePauseOverlay();
    garageUI.open();
  });

  // ── Camera tracking offset (scratch) ──────────────────────────────────────
  const camOffset = new THREE.Vector3(0, 7, -16);
  const camLookAt = new THREE.Vector3();
  const _camPos   = new THREE.Vector3();

  // ── Main loop ──────────────────────────────────────────────────────────────
  let lastTime = performance.now();

  function loop() {
    requestAnimationFrame(loop);

    const frameStart = performance.now();
    const dt = Math.min((frameStart - lastTime) / 1000, 0.05); // cap at 50 ms
    lastTime = frameStart;

    // ── Hit-stop: pause physics/logic for N frames ─────────────────────
    if (_hitStopFrames > 0) {
      _hitStopFrames--;
      postFX.update(dt);
      postFX.render();
      return;
    }

    // ── Game pause ────────────────────────────────────────────────────
    if (_paused) {
      postFX.render();
      return;
    }

    // ── Control inputs ────────────────────────────────────────────────
    vehicle.controls.throttle =
      (keys['ArrowUp']   || keys['KeyW']) ? 1 : 0;
    vehicle.controls.brake    =
      (keys['ArrowDown'] || keys['KeyS'] || keys['Space']) ? 1 : 0;

    const leftHeld  = keys['ArrowLeft']  || keys['KeyA'];
    const rightHeld = keys['ArrowRight'] || keys['KeyD'];
    vehicle.controls.steer =
      leftHeld && !rightHeld ?  1 :
      rightHeld && !leftHeld ? -1 : 0;

    // ── Signal SDK gameplay start on first drive input ────────────────
    if (!_gameplayStarted &&
        (vehicle.controls.throttle > 0 || vehicle.controls.steer !== 0)) {
      _gameplayStarted = true;
      sdk.gameplayStart();
    }

    // ── Vehicle physics update (apply suspension + drive forces) ──────
    vehicle.update(dt);

    // ── Physics step ──────────────────────────────────────────────────
    physics.update(dt);

    // ── Sync vehicle mesh ────────────────────────────────────────────
    const vPos  = vehicle.getPosition();
    const vQuat = vehicle.getQuaternion();
    voxelCar.syncToBody(vPos, vQuat);
    voxelCar.update(dt);

    // ── Level loader tick ─────────────────────────────────────────────
    levelLoader.update(dt);

    // ── FX update (sparks, voxel trails, ghost trail) ─────────────────
    fxManager.update(dt, vPos, vQuat, vehicle.getSpeed());

    // ── Camera follow ────────────────────────────────────────────────
    const targetCamPos = _camPos.copy(camOffset)
      .applyQuaternion(vQuat)
      .add(vPos);

    camera.position.lerp(targetCamPos, 0.08);
    camLookAt.copy(vPos).add(new THREE.Vector3(0, 1, 0));
    camera.lookAt(camLookAt);

    // ── Camera shake ──────────────────────────────────────────────────
    if (_shakeIntensity > 0.01) {
      _shakeDecay += dt;
      const fade = Math.max(0, 1 - _shakeDecay * 3);
      const amp  = _shakeIntensity * fade;
      camera.position.x += (Math.random() - 0.5) * amp;
      camera.position.y += (Math.random() - 0.5) * amp * 0.5;
      if (fade <= 0) _shakeIntensity = 0;
    }

    // ── Audio listener position ───────────────────────────────────────
    audioManager.setListenerPosition(vPos);
    audioManager.updateEngine(vehicle.getSpeed());

    // ── HUD update (throttled to every ~6 frames) ─────────────────────
    if (Math.random() < 0.16) {
      if (hudLevel)    hudLevel.textContent    = levelManager.levelNumber;
      if (hudScrap)    hudScrap.textContent    = garageManager.scrap;
      if (hudVoxels)   hudVoxels.textContent   = voxelCar.getLiveVoxelCount();
      if (hudDest)     hudDest.textContent     = Math.floor(levelManager.objectiveProgress * 100) + '%';
      if (hudProgress) hudProgress.style.width = (levelManager.objectiveProgress * 100).toFixed(1) + '%';
    }

    // ── Post-FX and render ────────────────────────────────────────────
    postFX.update(dt);
    postFX.render();

    // ── Frame budget guard ────────────────────────────────────────────
    const elapsed = performance.now() - frameStart;
    if (elapsed > FRAME_BUDGET_MS) {
      console.warn(`[Profiler] Frame exceeded ${FRAME_BUDGET_MS}ms budget: ${elapsed.toFixed(1)}ms`);
    }
  }

  loop();

  // ── Resize handler ────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    postFX.resize(w, h);
  });
}

// ── Neon grid floor builder ────────────────────────────────────────────────────
function _buildGridFloor(scene) {
  // Solid dark floor plane
  const floorGeo = new THREE.PlaneGeometry(120, 120);
  const floorMat = new THREE.MeshStandardMaterial({
    color:     0x000812,
    metalness: 0.6,
    roughness: 0.8,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Neon blue grid lines using GridHelper
  const grid = new THREE.GridHelper(120, 60, 0x00f0ff, 0x003a50);
  grid.position.y = 0.01; // slightly above floor to avoid z-fighting
  /** @type {THREE.LineBasicMaterial} */
  const gridMat = /** @type {any} */ (grid.material);
  gridMat.transparent = true;
  gridMat.opacity = 0.55;
  scene.add(grid);

  // Emissive neon accent lines (cross-hair style on floor)
  const accentMat = new THREE.LineBasicMaterial({ color: 0x00f0ff, linewidth: 1 });
  for (let i = -4; i <= 4; i++) {
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(i * 6, 0.02, -60),
      new THREE.Vector3(i * 6, 0.02,  60),
    ]);
    scene.add(new THREE.Line(geom, accentMat));
  }
}

main().catch(err => {
  console.error('[main] Fatal error:', err);
  const loadingTxt = document.getElementById('loading-text');
  if (loadingTxt) loadingTxt.textContent = 'Error: ' + err.message;
});
