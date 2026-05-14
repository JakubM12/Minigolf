const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlayText = document.getElementById("overlay-text");
const overlayButton = document.getElementById("overlay-button");
const startButton = document.getElementById("start-button");
const singleModeButton = document.getElementById("single-mode-button");
const duoModeButton = document.getElementById("duo-mode-button");
const muteButton = document.getElementById("mute-button");
const volumeSlider = document.getElementById("volume-slider");

const levelLabel = document.getElementById("level-label");
const playerLabel = document.getElementById("player-label");
const strokesLabel = document.getElementById("strokes-label");
const playerOneTotalLabel = document.getElementById("player-one-total-label");
const playerTwoTotalLabel = document.getElementById("player-two-total-label");
const playerTwoCard = document.getElementById("player-two-card");

const COURSE_BOUNDS = { x: 60, y: 60, width: 840, height: 420 };
const BALL_RADIUS = 10;
const HOLE_RADIUS = 16;
const HOLE_CAPTURE_RADIUS = 26;
const GRASS_FRICTION = 0.984;
const ICE_FRICTION = 0.997;
const SAND_FRICTION = 0.932;
const STOP_THRESHOLD = 0.06;
const BOUNCE_DAMPING = 0.88;
const MAX_DRAG = 140;
const POWER_SCALE = 0.155;
const HOLE_CAPTURE_SPEED = 4.6;
const SHAKE_DURATION = 16;
const SHAKE_STRENGTH = 4;
const HOLE_ZOOM_DURATION = 92;
const HOLE_ZOOM_SCALE = 1.75;
const MAX_TRAIL_POINTS = 18;
const MAX_SAND_PARTICLES = 36;
const HOLE_TRANSITION_DURATION = 32;
const COLLISION_SOUND_COOLDOWN_MS = 90;

class AudioManager {
  constructor(soundMap) {
    this.masterVolume = 0.7;
    this.muted = false;
    this.sounds = new Map();
    this.activeInstances = new Map();
    this.audioContext = null;
    this.masterGain = null;

    for (const [name, config] of Object.entries(soundMap)) {
      const audio = new Audio(config.src);
      audio.preload = "auto";
      audio.loop = Boolean(config.loop);
      audio.volume = this.getVolumeFor(config.volume ?? 1);
      this.sounds.set(name, { ...config, audio, audioBuffer: null, bufferPromise: null });
      this.activeInstances.set(name, new Set());
    }
  }

  async unlock() {
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioContext = new AudioContextClass();
        this.masterGain = this.audioContext.createGain();
        this.masterGain.connect(this.audioContext.destination);
        this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
      }
    }

    if (this.audioContext?.state === "suspended") {
      await this.audioContext.resume().catch(() => {});
    }

    const decodeTasks = [];
    for (const [name, sound] of this.sounds.entries()) {
      if (sound.useBuffer) {
        decodeTasks.push(this.prepareBufferSound(name));
      }
    }
    await Promise.all(decodeTasks);
  }

  preloadAll() {
    const tasks = [];
    for (const sound of this.sounds.values()) {
      const { audio } = sound;
      audio.load();
      tasks.push(new Promise((resolve) => {
        const cleanup = () => {
          audio.removeEventListener("canplaythrough", onReady);
          audio.removeEventListener("error", onReady);
        };
        const onReady = () => {
          cleanup();
          resolve();
        };
        audio.addEventListener("canplaythrough", onReady, { once: true });
        audio.addEventListener("error", onReady, { once: true });
      }));

      if (sound.useBuffer) {
        sound.bufferPromise = fetch(sound.src)
          .then((response) => response.arrayBuffer())
          .catch(() => null);
      }
    }
    return Promise.all(tasks);
  }

  async prepareBufferSound(name) {
    const sound = this.sounds.get(name);
    if (!sound || !sound.useBuffer || sound.audioBuffer || !this.audioContext) {
      return sound?.audioBuffer ?? null;
    }

    try {
      const arrayBuffer = sound.bufferPromise ? await sound.bufferPromise : await fetch(sound.src).then((response) => response.arrayBuffer());
      if (!arrayBuffer) {
        return null;
      }
      sound.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
      sound.detectedStartOffset = this.detectTransientOffset(sound.audioBuffer, sound.startOffset ?? 0);
      return sound.audioBuffer;
    } catch {
      return null;
    }
  }

  detectTransientOffset(audioBuffer, fallbackOffset = 0) {
    if (!audioBuffer.numberOfChannels) {
      return fallbackOffset;
    }

    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const minSearchSamples = Math.min(channelData.length, Math.floor(sampleRate * 0.4));
    const floor = 0.012;
    const transient = 0.045;

    let detectedIndex = -1;
    for (let index = 0; index < minSearchSamples; index += 1) {
      const amplitude = Math.abs(channelData[index]);
      if (amplitude >= transient) {
        detectedIndex = Math.max(0, index - Math.floor(sampleRate * 0.004));
        break;
      }
      if (detectedIndex === -1 && amplitude >= floor) {
        detectedIndex = Math.max(0, index - Math.floor(sampleRate * 0.002));
      }
    }

    if (detectedIndex === -1) {
      return fallbackOffset;
    }

    return Math.max(fallbackOffset, detectedIndex / sampleRate);
  }

  getVolumeFor(baseVolume) {
    return this.muted ? 0 : Math.max(0, Math.min(1, baseVolume * this.masterVolume));
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.value = muted ? 0 : this.masterVolume;
    }
    for (const { audio, volume } of this.sounds.values()) {
      audio.volume = this.getVolumeFor(volume ?? 1);
    }
    for (const [name, instances] of this.activeInstances.entries()) {
      for (const instance of instances) {
        instance.volume = this.getVolumeFor(instance._baseVolume ?? 1);
      }
    }
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setMasterVolume(value) {
    this.masterVolume = Math.max(0, Math.min(1, value));
    if (this.masterGain && !this.muted) {
      this.masterGain.gain.value = this.masterVolume;
    }
    this.setMuted(this.muted);
  }

  async playSound(name, volume = 1, options = {}) {
    const sound = this.sounds.get(name);
    if (!sound) {
      return null;
    }

    if (sound.useBuffer) {
      const buffer = sound.audioBuffer || await this.prepareBufferSound(name);
      if (buffer && this.audioContext && this.masterGain) {
        const source = this.audioContext.createBufferSource();
        const gainNode = this.audioContext.createGain();
        source.buffer = buffer;
        source.playbackRate.value = options.playbackRate ?? 1;
        gainNode.gain.value = this.muted ? 0 : (sound.volume ?? 1) * volume;
        source.connect(gainNode);
        gainNode.connect(this.masterGain);
        source.onended = () => {
          source.disconnect();
          gainNode.disconnect();
        };
        const startOffset = Math.max(
          0,
          Math.min(
            options.startOffset ?? sound.detectedStartOffset ?? sound.startOffset ?? 0,
            Math.max(0, buffer.duration - 0.01)
          )
        );
        source.start(0, startOffset);
        return source;
      }
    }

    if (sound.loop) {
      const loopAudio = sound.audio;
      loopAudio._baseVolume = (sound.volume ?? 1) * volume;
      loopAudio.volume = this.getVolumeFor(loopAudio._baseVolume);
      loopAudio.playbackRate = options.playbackRate ?? 1;
      const playPromise = loopAudio.paused ? loopAudio.play() : Promise.resolve();
      if (playPromise?.catch) {
        playPromise.catch(() => {});
      }
      return loopAudio;
    }

    if (options.preferBaseInstance) {
      const baseAudio = sound.audio;
      baseAudio._baseVolume = (sound.volume ?? 1) * volume;
      baseAudio.volume = this.getVolumeFor(baseAudio._baseVolume);
      baseAudio.playbackRate = options.playbackRate ?? 1;
      if (options.restart !== false) {
        try {
          baseAudio.currentTime = 0;
        } catch {}
      }
      const playPromise = baseAudio.play();
      if (playPromise?.catch) {
        playPromise.catch(() => {});
      }
      return baseAudio;
    }

    const instance = sound.audio.cloneNode();
    instance._baseVolume = (sound.volume ?? 1) * volume;
    instance.volume = this.getVolumeFor(instance._baseVolume);
    instance.playbackRate = options.playbackRate ?? 1;
    instance.currentTime = 0;

    const instances = this.activeInstances.get(name);
    instances.add(instance);

    const cleanup = () => {
      instance.pause();
      instance.src = "";
      instance.removeAttribute("src");
      instance.load();
      instances.delete(instance);
      instance.removeEventListener("ended", cleanup);
      instance.removeEventListener("error", cleanup);
    };

    instance.addEventListener("ended", cleanup, { once: true });
    instance.addEventListener("error", cleanup, { once: true });

    const playPromise = instance.play();
    if (playPromise?.catch) {
      playPromise.catch(cleanup);
    }
    return instance;
  }

  stopSound(name) {
    const sound = this.sounds.get(name);
    if (!sound) {
      return;
    }

    sound.audio.pause();
    sound.audio.currentTime = 0;
  }
}

const audioManager = new AudioManager({
  putt: { src: "putt.wav", volume: 0.95, useBuffer: true, startOffset: 0.002 },
  wall: { src: "wall.wav", volume: 0.9 },
  hole: { src: "hole.wav", volume: 0.92 },
  sand: { src: "sand.wav", volume: 0.55, loop: true }
});

audioManager.preloadAll().catch(() => {});

const levels = [
  {
    ballStart: { x: 150, y: 270 },
    hole: { x: 790, y: 270 },
    walls: [{ x: 585, y: 190, width: 18, height: 150 }],
    sand: [
      { x: 300, y: 175, width: 100, height: 90 },
      { x: 660, y: 100, width: 140, height: 80 }
    ],
    ice: []
  },
  {
    ballStart: { x: 120, y: 410 },
    hole: { x: 830, y: 120 },
    walls: [
      { x: 230, y: 320, width: 220, height: 16 },
      { x: 500, y: 190, width: 16, height: 150 },
      { x: 740, y: 180, width: 95, height: 16 }
    ],
    sand: [
      { x: 285, y: 120, width: 130, height: 75 },
      { x: 585, y: 80, width: 95, height: 125 }
    ],
    ice: [{ x: 640, y: 250, width: 145, height: 75 }]
  },
  {
    ballStart: { x: 130, y: 140 },
    hole: { x: 800, y: 410 },
    walls: [
      { x: 240, y: 200, width: 16, height: 210 },
      { x: 410, y: 360, width: 16, height: 90 },
      { x: 580, y: 150, width: 16, height: 190 }
    ],
    sand: [
      { x: 340, y: 90, width: 115, height: 85 },
      { x: 705, y: 320, width: 110, height: 70 }
    ],
    ice: [{ x: 455, y: 205, width: 105, height: 95 }]
  },
  {
    ballStart: { x: 790, y: 140 },
    hole: { x: 150, y: 395 },
    walls: [
      { x: 240, y: 130, width: 430, height: 16 },
      { x: 240, y: 130, width: 16, height: 200 },
      { x: 240, y: 336, width: 290, height: 16 },
      { x: 540, y: 240, width: 16, height: 95 }
    ],
    sand: [
      { x: 625, y: 145, width: 105, height: 115 },
      { x: 680, y: 345, width: 120, height: 70 }
    ],
    ice: []
  },
  {
    ballStart: { x: 140, y: 260 },
    hole: { x: 805, y: 258 },
    walls: [
      { x: 255, y: 110, width: 16, height: 280 },
      { x: 420, y: 170, width: 16, height: 250 },
      { x: 255, y: 110, width: 125, height: 16 },
      { x: 420, y: 404, width: 110, height: 16 }
    ],
    sand: [
      { x: 305, y: 225, width: 55, height: 105 },
      { x: 540, y: 120, width: 110, height: 115 },
      { x: 610, y: 270, width: 70, height: 110 }
    ],
    ice: [{ x: 690, y: 175, width: 90, height: 155 }]
  }
];

const state = {
  mode: "single",
  levelIndex: 0,
  strokes: 0,
  activePlayerIndex: 0,
  ball: { x: 0, y: 0, vx: 0, vy: 0 },
  isDragging: false,
  dragStart: null,
  dragCurrent: null,
  isRunning: false,
  completed: false,
  shakeFrames: 0,
  shakeStrength: 0,
  zoomFrames: 0,
  zoomTarget: null,
  pendingHoleAdvance: false,
  transitionFrames: 0,
  pendingOverlay: null,
  lastCollisionSoundAt: 0,
  wasInSand: false,
  frame: 0,
  trail: [],
  sandParticles: [],
  players: [
    { name: "Hráč 1", totalStrokes: 0, holeScore: null },
    { name: "Hráč 2", totalStrokes: 0, holeScore: null }
  ]
};

function getLevel() {
  return levels[state.levelIndex];
}

function getPlayerCount() {
  return state.mode === "duo" ? 2 : 1;
}

function getCurrentPlayer() {
  return state.players[state.activePlayerIndex];
}

function resetBallPosition() {
  const level = getLevel();
  state.ball.x = level.ballStart.x;
  state.ball.y = level.ballStart.y;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.shakeFrames = 0;
  state.shakeStrength = 0;
  state.zoomFrames = 0;
  state.zoomTarget = null;
  state.pendingHoleAdvance = false;
  state.transitionFrames = 0;
  state.pendingOverlay = null;
  state.wasInSand = false;
  state.trail = [];
  state.sandParticles = [];
  audioManager.stopSound("sand");
}

function resetPlayers() {
  for (const player of state.players) {
    player.totalStrokes = 0;
    player.holeScore = null;
  }
}

function loadLevel(index, resetTotals = false) {
  state.levelIndex = index;
  state.strokes = 0;
  state.activePlayerIndex = 0;

  if (resetTotals) {
    resetPlayers();
    state.completed = false;
  }

  for (const player of state.players) {
    player.holeScore = null;
  }

  state.isDragging = false;
  state.dragStart = null;
  state.dragCurrent = null;
  resetBallPosition();
  updateHud();
}

function updateHud() {
  levelLabel.textContent = `${state.levelIndex + 1} / ${levels.length}`;
  playerLabel.textContent = getCurrentPlayer().name;
  strokesLabel.textContent = `${state.strokes}`;
  playerOneTotalLabel.textContent = `${state.players[0].totalStrokes}`;
  playerTwoTotalLabel.textContent = `${state.players[1].totalStrokes}`;
  playerTwoCard.classList.toggle("hidden", state.mode !== "duo");

  singleModeButton.classList.toggle("active", state.mode === "single");
  duoModeButton.classList.toggle("active", state.mode === "duo");
}

function updateAudioUi() {
  muteButton.textContent = audioManager.muted ? "Zapnout zvuk" : "Ztlumit";
  volumeSlider.value = `${Math.round(audioManager.masterVolume * 100)}`;
}

function ensureAmbientPlayback() {
  return audioManager.unlock().catch(() => {});
}

function showOverlay(title, text, buttonLabel) {
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  overlayButton.textContent = buttonLabel;
  overlay.classList.remove("hidden");
}

function queueOverlay(title, text, buttonLabel, transitionFrames = HOLE_TRANSITION_DURATION) {
  state.pendingOverlay = { title, text, buttonLabel };
  state.transitionFrames = transitionFrames;
  if (transitionFrames === 0) {
    flushPendingOverlay();
  }
}

function flushPendingOverlay() {
  if (!state.pendingOverlay) {
    return;
  }

  const { title, text, buttonLabel } = state.pendingOverlay;
  state.pendingOverlay = null;
  showOverlay(title, text, buttonLabel);
}

function hideOverlay() {
  overlay.classList.add("hidden");
}

function startGame() {
  ensureAmbientPlayback();
  state.isRunning = true;
  loadLevel(0, true);
  hideOverlay();
}

function applyHoleResult() {
  const currentPlayer = getCurrentPlayer();
  currentPlayer.holeScore = state.strokes;
  currentPlayer.totalStrokes += state.strokes;
}

function advanceAfterHole() {
  applyHoleResult();

  if (state.mode === "duo" && state.activePlayerIndex === 0) {
    state.activePlayerIndex = 1;
    state.strokes = 0;
    resetBallPosition();
    updateHud();
    state.isRunning = false;
    queueOverlay(
      "Střídání hráčů",
      "Hráč 1 dohrál jamku. Teď hraje Hráč 2 stejný level ze stejné startovní pozice.",
      "Pokračovat"
    );
    return;
  }

  const nextIndex = state.levelIndex + 1;
  if (nextIndex >= levels.length) {
    finishGame();
    return;
  }

  loadLevel(nextIndex);
  state.isRunning = false;

  if (state.mode === "duo") {
    queueOverlay(
      `Level ${nextIndex + 1}`,
      "Oba hráči dohráli jamku. Pokračujte na další level a zkuste udržet co nejnižší skóre.",
      "Pokračovat"
    );
  } else {
    queueOverlay(
      `Level ${nextIndex + 1}`,
      "Jamka padla. Pokračuj do dalšího levelu a zkus udržet nízký počet ran.",
      "Pokračovat"
    );
  }
}

function finishGame() {
  state.isRunning = false;
  state.completed = true;

  if (state.mode === "duo") {
    const playerOne = state.players[0];
    const playerTwo = state.players[1];
    const winnerText =
      playerOne.totalStrokes === playerTwo.totalStrokes
        ? "Je to remíza."
        : playerOne.totalStrokes < playerTwo.totalStrokes
          ? "Vyhrál Hráč 1."
          : "Vyhrál Hráč 2.";

    showOverlay(
      "Hotovo",
      `Hráč 1: ${playerOne.totalStrokes} ran. Hráč 2: ${playerTwo.totalStrokes} ran. ${winnerText}`,
      "Hrát znovu"
    );
    return;
  }

  showOverlay(
    "Dokončeno",
    `Dokončil jsi hru za ${state.players[0].totalStrokes} ran. Klikni a zahraj si všech 5 jamek znovu.`,
    "Hrát znovu"
  );
}

function getPointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

function ballIsMoving() {
  return Math.hypot(state.ball.vx, state.ball.vy) > STOP_THRESHOLD;
}

function pointInBall(point) {
  return Math.hypot(point.x - state.ball.x, point.y - state.ball.y) <= BALL_RADIUS + 10;
}

function hitBall() {
  const dx = state.dragStart.x - state.dragCurrent.x;
  const dy = state.dragStart.y - state.dragCurrent.y;
  const dragDistance = Math.min(MAX_DRAG, Math.hypot(dx, dy));
  if (dragDistance < 6) {
    return;
  }

  const angle = Math.atan2(dy, dx);
  const power = dragDistance * POWER_SCALE;
  state.ball.vx = Math.cos(angle) * power;
  state.ball.vy = Math.sin(angle) * power;
  state.strokes += 1;
  audioManager.playSound("putt", 1, { startOffset: 0.028 });
  updateHud();
}

function triggerShake(intensity = SHAKE_STRENGTH) {
  state.shakeFrames = SHAKE_DURATION;
  state.shakeStrength = intensity;
}

function triggerHoleZoom(target) {
  state.zoomFrames = HOLE_ZOOM_DURATION;
  state.zoomTarget = { x: target.x, y: target.y };
}

function playCollisionSound(impactSpeed) {
  const now = performance.now();
  if (now - state.lastCollisionSoundAt < COLLISION_SOUND_COOLDOWN_MS) {
    return;
  }

  state.lastCollisionSoundAt = now;
  const normalizedImpact = Math.max(0.2, Math.min(1, impactSpeed / 8.5));
  const playbackRate = 0.92 + Math.random() * 0.18;
  audioManager.playSound("wall", 0.35 + normalizedImpact * 0.65, { playbackRate });
}

function updateSandSound(inSand, speed) {
  const sandVolume = 0.2 + Math.max(0, Math.min(1, speed / 6.5)) * 0.45;

  if (inSand) {
    audioManager.playSound("sand", sandVolume);
    state.wasInSand = true;
    return;
  }

  if (state.wasInSand) {
    audioManager.stopSound("sand");
    state.wasInSand = false;
  }
}

function updateTrail() {
  const speed = Math.hypot(state.ball.vx, state.ball.vy);
  if (speed > 0.2) {
    state.trail.push({
      x: state.ball.x,
      y: state.ball.y,
      life: 1
    });
  }

  if (state.trail.length > MAX_TRAIL_POINTS) {
    state.trail.splice(0, state.trail.length - MAX_TRAIL_POINTS);
  }

  for (const point of state.trail) {
    point.life *= 0.92;
  }

  state.trail = state.trail.filter((point) => point.life > 0.08);
}

function spawnSandParticles() {
  if (state.sandParticles.length >= MAX_SAND_PARTICLES) {
    return;
  }

  const angle = Math.random() * Math.PI * 2;
  const speed = 1.2 + Math.random() * 2.1;
  state.sandParticles.push({
    x: state.ball.x + (Math.random() - 0.5) * BALL_RADIUS,
    y: state.ball.y + (Math.random() - 0.5) * BALL_RADIUS,
    vx: Math.cos(angle) * speed - state.ball.vx * 0.22,
    vy: Math.sin(angle) * speed - state.ball.vy * 0.22,
    life: 22 + Math.random() * 14,
    size: 2.4 + Math.random() * 3.4
  });
}

function updateSandParticles() {
  for (const particle of state.sandParticles) {
    particle.x += particle.vx;
    particle.y += particle.vy;
    particle.vx *= 0.96;
    particle.vy *= 0.96;
    particle.life -= 1;
  }

  state.sandParticles = state.sandParticles.filter((particle) => particle.life > 0);
}

function circleRectCollision(circle, rect) {
  const closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.width));
  const closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.height));
  const dx = circle.x - closestX;
  const dy = circle.y - closestY;

  return {
    collided: dx * dx + dy * dy <= BALL_RADIUS * BALL_RADIUS,
    closestX,
    closestY
  };
}

function resolveWallCollisions() {
  const level = getLevel();
  const minX = COURSE_BOUNDS.x + BALL_RADIUS;
  const maxX = COURSE_BOUNDS.x + COURSE_BOUNDS.width - BALL_RADIUS;
  const minY = COURSE_BOUNDS.y + BALL_RADIUS;
  const maxY = COURSE_BOUNDS.y + COURSE_BOUNDS.height - BALL_RADIUS;
  let collided = false;
  let maxImpactSpeed = 0;

  if (state.ball.x < minX) {
    maxImpactSpeed = Math.max(maxImpactSpeed, Math.abs(state.ball.vx));
    state.ball.x = minX;
    state.ball.vx *= -BOUNCE_DAMPING;
    collided = true;
  } else if (state.ball.x > maxX) {
    maxImpactSpeed = Math.max(maxImpactSpeed, Math.abs(state.ball.vx));
    state.ball.x = maxX;
    state.ball.vx *= -BOUNCE_DAMPING;
    collided = true;
  }

  if (state.ball.y < minY) {
    maxImpactSpeed = Math.max(maxImpactSpeed, Math.abs(state.ball.vy));
    state.ball.y = minY;
    state.ball.vy *= -BOUNCE_DAMPING;
    collided = true;
  } else if (state.ball.y > maxY) {
    maxImpactSpeed = Math.max(maxImpactSpeed, Math.abs(state.ball.vy));
    state.ball.y = maxY;
    state.ball.vy *= -BOUNCE_DAMPING;
    collided = true;
  }

  for (const wall of level.walls) {
    const collision = circleRectCollision(state.ball, wall);
    if (!collision.collided) {
      continue;
    }

    const overlapX = BALL_RADIUS - Math.abs(state.ball.x - collision.closestX);
    const overlapY = BALL_RADIUS - Math.abs(state.ball.y - collision.closestY);
    maxImpactSpeed = Math.max(maxImpactSpeed, Math.hypot(state.ball.vx, state.ball.vy));

    if (overlapX < overlapY) {
      state.ball.x += state.ball.x < collision.closestX ? -overlapX : overlapX;
      state.ball.vx *= -BOUNCE_DAMPING;
      state.ball.vy *= 0.98;
    } else {
      state.ball.y += state.ball.y < collision.closestY ? -overlapY : overlapY;
      state.ball.vy *= -BOUNCE_DAMPING;
      state.ball.vx *= 0.98;
    }
    collided = true;
  }

  if (collided) {
    triggerShake();
    playCollisionSound(maxImpactSpeed);
  }
}

function updatePhysics() {
  if (!state.isRunning || !ballIsMoving()) {
    updateSandSound(false, 0);
    if (Math.abs(state.ball.vx) < STOP_THRESHOLD) {
      state.ball.vx = 0;
    }
    if (Math.abs(state.ball.vy) < STOP_THRESHOLD) {
      state.ball.vy = 0;
    }
    return;
  }

  state.ball.x += state.ball.vx;
  state.ball.y += state.ball.vy;

  const level = getLevel();
  const inSand = level.sand.some((zone) => circleRectCollision(state.ball, zone).collided);
  const inIce = (level.ice || []).some((zone) => circleRectCollision(state.ball, zone).collided);
  const surfaceSpeed = Math.hypot(state.ball.vx, state.ball.vy);
  if (inSand && surfaceSpeed > 0.4) {
    spawnSandParticles();
  }
  updateSandSound(inSand, surfaceSpeed);
  const friction = inSand ? SAND_FRICTION : inIce ? ICE_FRICTION : GRASS_FRICTION;
  state.ball.vx *= friction;
  state.ball.vy *= friction;

  resolveWallCollisions();

  const distanceToHole = Math.hypot(state.ball.x - level.hole.x, state.ball.y - level.hole.y);
  const speed = Math.hypot(state.ball.vx, state.ball.vy);

  if (distanceToHole < HOLE_CAPTURE_RADIUS && speed < HOLE_CAPTURE_SPEED) {
    triggerHoleZoom(level.hole);
    audioManager.playSound("hole", 0.95);
    state.ball.x = level.hole.x;
    state.ball.y = level.hole.y;
    state.ball.vx = 0;
    state.ball.vy = 0;
    state.isRunning = false;
    state.pendingHoleAdvance = true;
  }
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function drawCourse() {
  const level = getLevel();

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const backdrop = ctx.createLinearGradient(0, 0, 0, canvas.height);
  backdrop.addColorStop(0, "#e1d3b2");
  backdrop.addColorStop(1, "#cbb489");
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const grassGradient = ctx.createLinearGradient(COURSE_BOUNDS.x, COURSE_BOUNDS.y, COURSE_BOUNDS.x, COURSE_BOUNDS.y + COURSE_BOUNDS.height);
  grassGradient.addColorStop(0, "#5ca86b");
  grassGradient.addColorStop(0.45, "#4d9a61");
  grassGradient.addColorStop(1, "#438756");
  ctx.fillStyle = grassGradient;
  roundRect(ctx, COURSE_BOUNDS.x, COURSE_BOUNDS.y, COURSE_BOUNDS.width, COURSE_BOUNDS.height, 28);
  ctx.fill();

  ctx.save();
  roundRect(ctx, COURSE_BOUNDS.x, COURSE_BOUNDS.y, COURSE_BOUNDS.width, COURSE_BOUNDS.height, 28);
  ctx.clip();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 12;
  for (let stripeX = COURSE_BOUNDS.x - 120; stripeX < COURSE_BOUNDS.x + COURSE_BOUNDS.width + 120; stripeX += 140) {
    ctx.beginPath();
    ctx.moveTo(stripeX, COURSE_BOUNDS.y + COURSE_BOUNDS.height);
    ctx.lineTo(stripeX + 160, COURSE_BOUNDS.y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(24, 55, 33, 0.045)";
  ctx.lineWidth = 1.5;
  for (let stripeY = COURSE_BOUNDS.y + 34; stripeY < COURSE_BOUNDS.y + COURSE_BOUNDS.height; stripeY += 62) {
    ctx.beginPath();
    ctx.moveTo(COURSE_BOUNDS.x + 14, stripeY + Math.sin((stripeY + state.frame) * 0.04) * 4);
    ctx.quadraticCurveTo(
      COURSE_BOUNDS.x + COURSE_BOUNDS.width * 0.45,
      stripeY - 10,
      COURSE_BOUNDS.x + COURSE_BOUNDS.width - 16,
      stripeY + Math.cos((stripeY + state.frame) * 0.03) * 4
    );
    ctx.stroke();
  }
  ctx.restore();

  for (const ice of level.ice || []) {
    const iceGradient = ctx.createLinearGradient(ice.x, ice.y, ice.x + ice.width, ice.y + ice.height);
    iceGradient.addColorStop(0, "rgba(222, 245, 248, 0.9)");
    iceGradient.addColorStop(0.5, "rgba(194, 229, 235, 0.82)");
    iceGradient.addColorStop(1, "rgba(173, 214, 224, 0.76)");
    ctx.fillStyle = iceGradient;
    roundRect(ctx, ice.x, ice.y, ice.width, ice.height, 20);
    ctx.fill();

    ctx.strokeStyle = "rgba(241, 253, 255, 0.42)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, ice.x, ice.y, ice.width, ice.height, 20);
    ctx.stroke();

    const shimmerOffset = (state.frame * 1.15) % (ice.width + 80);
    ctx.save();
    roundRect(ctx, ice.x, ice.y, ice.width, ice.height, 20);
    ctx.clip();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(ice.x - 40 + shimmerOffset, ice.y + ice.height);
    ctx.lineTo(ice.x + 20 + shimmerOffset, ice.y);
    ctx.stroke();
    ctx.restore();
  }

  for (const sand of level.sand) {
    const sandGradient = ctx.createLinearGradient(sand.x, sand.y, sand.x, sand.y + sand.height);
    sandGradient.addColorStop(0, "#e3d0a6");
    sandGradient.addColorStop(1, "#d2bb89");
    ctx.fillStyle = sandGradient;
    roundRect(ctx, sand.x, sand.y, sand.width, sand.height, 20);
    ctx.fill();

    ctx.save();
    roundRect(ctx, sand.x, sand.y, sand.width, sand.height, 20);
    ctx.clip();
    ctx.strokeStyle = "rgba(150, 114, 52, 0.055)";
    ctx.lineWidth = 1.4;
    for (let ridge = sand.y + 12; ridge < sand.y + sand.height; ridge += 18) {
      ctx.beginPath();
      ctx.moveTo(sand.x + 8, ridge);
      ctx.quadraticCurveTo(sand.x + sand.width * 0.5, ridge - 6, sand.x + sand.width - 8, ridge + 2);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255, 245, 211, 0.075)";
    for (let speck = 0; speck < 10; speck += 1) {
      const px = sand.x + ((speck * 37) % sand.width);
      const py = sand.y + ((speck * 29) % sand.height);
      ctx.beginPath();
      ctx.arc(px, py, 1.2 + (speck % 3) * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 2;
  ctx.strokeRect(COURSE_BOUNDS.x + 1, COURSE_BOUNDS.y + 1, COURSE_BOUNDS.width - 2, COURSE_BOUNDS.height - 2);

  for (const wall of level.walls) {
    const wallGradient = ctx.createLinearGradient(wall.x, wall.y, wall.x + wall.width, wall.y + wall.height);
    wallGradient.addColorStop(0, "#3b6b4d");
    wallGradient.addColorStop(1, "#2a523c");
    ctx.fillStyle = wallGradient;
    roundRect(ctx, wall.x, wall.y, wall.width, wall.height, 10);
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1.2;
    roundRect(ctx, wall.x + 1, wall.y + 1, wall.width - 2, wall.height - 2, 9);
    ctx.stroke();
  }

  ctx.fillStyle = "#17241b";
  ctx.beginPath();
  ctx.arc(level.hole.x, level.hole.y, HOLE_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#f5f0e7";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(level.hole.x, level.hole.y - 4);
  ctx.lineTo(level.hole.x, level.hole.y - 52);
  ctx.stroke();

  const flagWave = Math.sin(state.frame * 0.045 + level.hole.x * 0.01) * 13;
  ctx.fillStyle = "#f36d4f";
  ctx.beginPath();
  ctx.moveTo(level.hole.x, level.hole.y - 52);
  ctx.quadraticCurveTo(level.hole.x + 15, level.hole.y - 48 + flagWave * 0.22, level.hole.x + 28, level.hole.y - 40 + flagWave * 0.4);
  ctx.lineTo(level.hole.x, level.hole.y - 28);
  ctx.closePath();
  ctx.fill();
}

function drawTrail() {
  for (let index = 0; index < state.trail.length; index += 1) {
    const point = state.trail[index];
    const alpha = (index + 1) / state.trail.length * 0.34 * point.life;
    const radius = BALL_RADIUS * (0.45 + index / state.trail.length * 0.82);
    ctx.fillStyle = `rgba(255, 248, 234, ${alpha})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSandParticles() {
  for (const particle of state.sandParticles) {
    const alpha = Math.min(0.88, particle.life / 22);
    ctx.fillStyle = `rgba(230, 198, 128, ${alpha})`;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(255, 238, 196, ${alpha * 0.45})`;
    ctx.beginPath();
    ctx.arc(particle.x - 0.8, particle.y - 0.8, particle.size * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBall() {
  ctx.fillStyle = "rgba(35, 52, 40, 0.16)";
  ctx.beginPath();
  ctx.ellipse(state.ball.x + 5, state.ball.y + 9, BALL_RADIUS * 1.2, BALL_RADIUS * 0.8, -0.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#fff8ea";
  ctx.beginPath();
  ctx.arc(state.ball.x, state.ball.y, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(36, 49, 39, 0.18)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "rgba(36, 49, 39, 0.12)";
  ctx.beginPath();
  ctx.arc(state.ball.x + 3, state.ball.y + 3, BALL_RADIUS * 0.92, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.beginPath();
  ctx.ellipse(state.ball.x - 3.5, state.ball.y - 4.5, 3.8, 2.5, -0.55, 0, Math.PI * 2);
  ctx.fill();
}

function drawAimGuide() {
  if (!state.isDragging || !state.dragStart || !state.dragCurrent) {
    return;
  }

  const dx = state.dragStart.x - state.dragCurrent.x;
  const dy = state.dragStart.y - state.dragCurrent.y;
  const dragDistance = Math.min(MAX_DRAG, Math.hypot(dx, dy));
  if (dragDistance < 2) {
    return;
  }

  const angle = Math.atan2(dy, dx);
  const indicatorLength = dragDistance * 1.1;
  const endX = state.ball.x + Math.cos(angle) * indicatorLength;
  const endY = state.ball.y + Math.sin(angle) * indicatorLength;

  ctx.strokeStyle = "rgba(255, 248, 234, 0.86)";
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(state.ball.x, state.ball.y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "rgba(201, 108, 74, 0.9)";
  ctx.beginPath();
  ctx.arc(state.dragCurrent.x, state.dragCurrent.y, 8, 0, Math.PI * 2);
  ctx.fill();
}

function drawScene() {
  ctx.save();

  if (state.zoomFrames > 0 && state.zoomTarget) {
    const progress = 1 - state.zoomFrames / HOLE_ZOOM_DURATION;
    const easedProgress = progress * progress * (3 - 2 * progress);
    const zoom = 1 + (HOLE_ZOOM_SCALE - 1) * easedProgress;
    ctx.translate(state.zoomTarget.x, state.zoomTarget.y);
    ctx.scale(zoom, zoom);
    ctx.translate(-state.zoomTarget.x, -state.zoomTarget.y);
  }

  if (state.shakeFrames > 0) {
    const amount = state.shakeStrength * (state.shakeFrames / SHAKE_DURATION);
    const offsetX = (Math.random() - 0.5) * 2 * amount;
    const offsetY = (Math.random() - 0.5) * 2 * amount;
    ctx.translate(offsetX, offsetY);
  }

  drawCourse();
  drawSandParticles();
  drawTrail();
  drawAimGuide();
  drawBall();

  ctx.restore();

  if (state.transitionFrames > 0) {
    const progress = state.transitionFrames / HOLE_TRANSITION_DURATION;
    const eased = progress * progress;
    const veil = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    veil.addColorStop(0, `rgba(245, 238, 221, ${0.34 * eased})`);
    veil.addColorStop(1, `rgba(227, 214, 184, ${0.62 * eased})`);
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (state.shakeFrames > 0) {
    state.shakeFrames -= 1;
  }

  if (state.transitionFrames > 0) {
    state.transitionFrames -= 1;
    if (state.transitionFrames === 0) {
      flushPendingOverlay();
    }
  }

  if (state.zoomFrames > 0) {
    state.zoomFrames -= 1;
    if (state.zoomFrames === 0) {
      state.zoomTarget = null;
      if (state.pendingHoleAdvance) {
        state.pendingHoleAdvance = false;
        advanceAfterHole();
      }
    }
  }
}

function tick() {
  state.frame += 1;
  updatePhysics();
  updateTrail();
  updateSandParticles();
  drawScene();
  window.requestAnimationFrame(tick);
}

function clearDrag() {
  state.isDragging = false;
  state.dragStart = null;
  state.dragCurrent = null;
}

function setMode(mode) {
  if (state.mode === mode) {
    return;
  }

  state.mode = mode;
  loadLevel(0, true);
  state.isRunning = false;
  showOverlay(
    "Minigolf",
    mode === "duo"
      ? "Zapnutý je režim pro dva hráče. Každý hráč odehraje každou jamku zvlášť a hra porovná celkové skóre."
      : "Zapnutý je režim pro jednoho hráče. Klikni na Start a zkus projít všech pět jamek s co nejnižším skóre.",
    "Start"
  );
}

canvas.addEventListener("pointerdown", (event) => {
  if (!state.isRunning || ballIsMoving()) {
    return;
  }

  const pointer = getPointerPosition(event);
  if (!pointInBall(pointer)) {
    return;
  }

  state.isDragging = true;
  state.dragStart = { x: state.ball.x, y: state.ball.y };
  state.dragCurrent = pointer;
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.isDragging) {
    return;
  }
  state.dragCurrent = getPointerPosition(event);
});

canvas.addEventListener("pointerup", () => {
  if (!state.isDragging) {
    return;
  }
  hitBall();
  clearDrag();
});

canvas.addEventListener("pointerleave", () => {
  if (!state.isDragging) {
    return;
  }
  clearDrag();
});

overlayButton.addEventListener("click", async () => {
  await ensureAmbientPlayback();
  if (state.completed) {
    startGame();
    return;
  }

  if (!overlay.classList.contains("hidden") && state.isRunning === false && (state.levelIndex > 0 || state.activePlayerIndex > 0)) {
    state.isRunning = true;
    hideOverlay();
    return;
  }

  startGame();
});

startButton.addEventListener("click", async () => {
  await ensureAmbientPlayback();
  if (!overlay.classList.contains("hidden")) {
    overlayButton.click();
    return;
  }
  state.isRunning = true;
});

singleModeButton.addEventListener("click", () => {
  setMode("single");
});

duoModeButton.addEventListener("click", () => {
  setMode("duo");
});

muteButton.addEventListener("click", () => {
  audioManager.toggleMute();
  updateAudioUi();
});

volumeSlider.addEventListener("input", (event) => {
  const volume = Number(event.target.value) / 100;
  audioManager.setMasterVolume(volume);
  if (audioManager.muted && volume > 0) {
    audioManager.setMuted(false);
  }
  updateAudioUi();
});

loadLevel(0, true);
updateAudioUi();
showOverlay(
  "Minigolf",
  "Klikni na Start a pak táhni myší od míčku pro směr a sílu odpalu. Cílem je dostat míček do jamky na co nejméně ran.",
  "Start"
);
tick();
