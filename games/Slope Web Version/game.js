(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
  const padScore = (n) => String(Math.max(0, Math.floor(n))).padStart(3, "0");
  const BALL_RADIUS = 0.78;
  const TUNNEL_CENTER_LIFT = 0.72;

  const DEFAULTS = Object.freeze({
    difficulty: "classic",
    startSpeed: 24,
    maxSpeed: 58,
    acceleration: 0.72,
    trackWidth: 11.8,
    obstacleDensity: 1,
    seed: "",
    sensitivity: 1,
    fov: 68,
    renderMode: "auto",
    glow: false,
    reducedMotion: false,
    sfxVolume: 0.6,
    muted: false
  });

  const PROFILES = {
    chill: { speed: 0.84, max: 0.82, accel: 0.72, width: 1.16, density: 0.7, gaps: 0.7 },
    classic: { speed: 1, max: 1, accel: 1, width: 1, density: 1, gaps: 1 },
    brutal: { speed: 1.08, max: 1.18, accel: 1.3, width: 0.9, density: 1.35, gaps: 1.25 }
  };

  const FIDELITY_VERSION = 3;

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem("slope-vector-settings") || "{}");
      if (saved.fidelityVersion !== FIDELITY_VERSION) return { ...DEFAULTS };
      delete saved.fidelityVersion;
      return { ...DEFAULTS, ...saved };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  const settings = loadSettings();
  let best = Number(localStorage.getItem("slope-vector-best") || 0);

  const QUALITY_LEVELS = [
    { dpr: 1, drawDistance: 200, cityDistance: 160, cityStride: 4, streaks: 0, glow: false, buildingGrid: 6 },
    { dpr: 1, drawDistance: 260, cityDistance: 205, cityStride: 3, streaks: 0, glow: true, buildingGrid: 9 },
    { dpr: 1.25, drawDistance: 330, cityDistance: 270, cityStride: 2, streaks: 0, glow: true, buildingGrid: 12 }
  ];
  const perf = { level: 1, renderEma: 8, lastAdjust: 0, frames: 0 };

  function selectedQualityLevel() {
    if (settings.renderMode === "performance") return 0;
    if (settings.renderMode === "crisp") return 2;
    if (settings.renderMode === "balanced") return 1;
    return perf.level;
  }

  function renderQuality() {
    return QUALITY_LEVELS[selectedQualityLevel()];
  }

  const canvas = $("#gameCanvas");
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  let W = innerWidth;
  let H = innerHeight;
  let DPR = 1;
  let backgroundLayer = null;

  const ui = {
    app: $("#app"),
    menu: $("#menuScreen"),
    pause: $("#pauseScreen"),
    over: $("#overScreen"),
    settings: $("#settingsModal"),
    how: $("#howModal"),
    hud: $("#hud"),
    score: $("#scoreValue"),
    best: $("#bestValue"),
    menuBest: $("#menuBest"),
    speed: $("#speedValue"),
    speedFill: $("#speedFill"),
    pauseScore: $("#pauseScore"),
    pauseSpeed: $("#pauseSpeed"),
    finalScore: $("#finalScore"),
    bestCallout: $("#bestCallout"),
    crashReason: $("#crashReason"),
    sound: $("#soundBtn"),
    toast: $("#toast")
  };

  function resize() {
    W = innerWidth;
    H = innerHeight;
    DPR = Math.min(devicePixelRatio || 1, W < 720 ? 1 : renderQuality().dpr);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    rebuildBackground();
  }
  addEventListener("resize", resize, { passive: true });
  resize();

  function hashSeed(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function freshSeed() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let value = "";
    const n = (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
    const random = makeRng(n);
    for (let i = 0; i < 6; i++) value += alphabet[Math.floor(random() * alphabet.length)];
    return value;
  }

  class AudioEngine {
    constructor() {
      this.context = null;
      this.sfxGain = null;
      this.started = false;
    }

    start() {
      if (this.started) {
        this.context?.resume();
        this.apply();
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.context = new AC();
      this.sfxGain = this.context.createGain();
      this.sfxGain.connect(this.context.destination);
      this.started = true;
      this.apply();
    }

    apply() {
      if (!this.started) return;
      const mute = settings.muted ? 0 : 1;
      this.sfxGain.gain.setTargetAtTime(settings.sfxVolume * 0.22 * mute, this.context.currentTime, 0.03);
    }

    effect(kind) {
      if (!this.started || settings.muted || settings.sfxVolume <= 0) return;
      const t = this.context.currentTime;
      const osc = this.context.createOscillator();
      const gain = this.context.createGain();
      osc.connect(gain).connect(this.sfxGain);
      if (kind === "crash") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(170, t);
        osc.frequency.exponentialRampToValueAtTime(34, t + 0.48);
        gain.gain.setValueAtTime(0.8, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        osc.start(t); osc.stop(t + 0.52);
      } else if (kind === "boost") {
        osc.type = "square";
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(480, t + 0.16);
        gain.gain.setValueAtTime(0.18, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.start(t); osc.stop(t + 0.2);
      } else if (kind === "near") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(760, t);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        osc.start(t); osc.stop(t + 0.1);
      } else {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(260, t);
        osc.frequency.exponentialRampToValueAtTime(420, t + 0.055);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        osc.start(t); osc.stop(t + 0.08);
      }
    }
  }

  const audio = new AudioEngine();

  const game = {
    state: "menu",
    time: 0,
    runTime: 0,
    lastTime: performance.now(),
    runStartZ: 0,
    score: 0,
    speed: 0,
    boostLatch: false,
    launchLatch: false,
    deathTimer: 0,
    reason: "COLLISION",
    activeSeed: "",
    shake: 0,
    ballRotation: 0,
    hudNext: 0,
    player: { x: 0, y: BALL_RADIUS, z: 0, vx: 0, vy: 0, grounded: true },
    input: { left: false, right: false, touch: 0 },
    world: null,
    particles: []
  };

  function profile() {
    return PROFILES[settings.difficulty] || PROFILES.classic;
  }

  function createWorld(attract = false) {
    const activeSeed = attract ? "VECTOR" : (settings.seed.trim().toUpperCase() || freshSeed());
    game.activeSeed = activeSeed;
    const random = makeRng(hashSeed(activeSeed));
    game.world = {
      random,
      segments: [],
      obstacles: [],
      city: [],
      genZ: -42,
      genX: 0,
      genY: 2,
      curve: 0,
      bank: 0,
      section: 0,
      patternQueue: [],
      scoreIndex: 0,
      lastObstacleZ: -100,
      chunk: 0,
      nextMaintenanceZ: 0
    };
    extendWorld(470, true);
  }

  function randRange(a, b) {
    return a + (b - a) * game.world.random();
  }

  function pickFamily(options) {
    return options[Math.floor(game.world.random() * options.length)];
  }

  function refillPatternQueue() {
    const world = game.world;
    world.section++;
    const baseCount = world.section === 1 ? 1 : world.section === 2 ? 2 : world.section === 3 ? 3 : 4;
    const count = clamp(Math.round(baseCount * settings.obstacleDensity * profile().density), 1, 6);
    const early = pickFamily(world.scoreIndex < 50 ? ["rng", "slantLeft", "slantRight", "straight"] : ["rng", "slantLeft", "slantRight"]);
    world.patternQueue.push(...Array(count).fill(early));
    if (world.section >= 2) {
      const middle = pickFamily(world.scoreIndex < 50 ? ["treblock", "tunnel", "snake"] : ["treblock", "tunnel"]);
      world.patternQueue.push(...Array(count).fill(middle));
    }
    if (world.section >= 3) {
      const late = pickFamily(["hor", "verts"]);
      world.patternQueue.push(...Array(count).fill(late));
    }
    world.patternQueue.push("speedTunnel");
  }

  function addObstacle(z, width, forcedPattern = null) {
    const world = game.world;
    const r = world.random;
    const laneGap = width * .27;
    const make = (lane, options = {}) => world.obstacles.push({
      z,
      offset: lane * laneGap,
      w: options.w || Math.min(2.1, width * .235),
      d: options.d || 1.65 + r() * 1.15,
      h: options.h || 2.6 + r() * 1.8,
      baseOffset: options.baseOffset || 0,
      moving: Boolean(options.moving),
      vertical: Boolean(options.vertical),
      delay: options.delay ?? 0,
      amp: options.amp ?? (options.moving ? width * .24 : 0),
      verticalAmp: options.verticalAmp || 7.2,
      phase: options.phase ?? r() * Math.PI * 2,
      activeAt: null,
      passed: false
    });

    const pattern = forcedPattern || (r() < .42 ? "single" : r() < .64 ? "pair" : r() < .76 ? "gate" : r() < .87 ? "moving" : "overhead");
    if (pattern === "pair") {
      const opening = Math.floor(r() * 3) - 1;
      [-1, 0, 1].forEach((lane) => { if (lane !== opening) make(lane); });
    } else if (pattern === "gate") {
      make(-1.16, { w: width * .205, h: 4.4, d: 1.75 });
      make(1.16, { w: width * .205, h: 4.4, d: 1.75 });
    } else if (pattern === "edgePair") {
      make(-1, { w: Math.min(2.2, width * .245), h: 3.8, d: 2.25 });
      make(1, { w: Math.min(2.2, width * .245), h: 3.8, d: 2.25 });
    } else if (pattern === "center") {
      make(0, { w: Math.min(2.55, width * .28), h: 4.35, d: 2.5 });
    } else if ((pattern === "moving" || pattern === "hor") && z > 150) {
      const w = Math.min(3.35, width * .36);
      make(0, { moving: true, delay: r() * 3, amp: width * .5 - w * .52, w, h: 3.75, d: 2.2 });
    } else if (pattern === "verts") {
      make(-1, { vertical: true, delay: 0, verticalAmp: 7.2, w: Math.min(2.1, width * .235), h: 2.7, d: 2 });
      make(0, { vertical: true, delay: 3, verticalAmp: 7.2, w: Math.min(2.1, width * .235), h: 2.7, d: 2 });
      make(1, { vertical: true, delay: 6, verticalAmp: 7.2, w: Math.min(2.1, width * .235), h: 2.7, d: 2 });
    } else if (pattern === "overhead") {
      const lane = Math.floor(r() * 3) - 1;
      make(lane, { baseOffset: 2.45, h: 1.7, d: 1.7, w: Math.min(1.75, width * .22) });
      if (r() > .48) make(-lane || 1, { h: 2.35, d: 1.7 });
    } else {
      make(Math.floor(r() * 3) - 1);
    }
  }

  function extendWorld(toZ, initial = false) {
    const world = game.world;
    const p = profile();
    while (world.genZ < toZ) {
      world.chunk++;
      const safeStart = world.genZ < 66;
      const widthBase = settings.trackWidth * p.width;
      let kind = "normal";
      if (!safeStart) {
        if (!world.patternQueue.length) refillPatternQueue();
        kind = world.patternQueue.shift();
        world.scoreIndex++;
      }
      const platformScore = world.scoreIndex;
      const cells = safeStart ? 10
        : kind === "treblock" ? 18
          : kind === "snake" ? 11
            : kind === "straight" ? 10
              : kind === "speedTunnel" || kind === "tunnel" ? 9
                : kind === "rng" || kind === "hor" || kind === "verts" ? 9
                  : 8;
      const chunkOffset = safeStart ? 0 : kind === "slantLeft" ? -1.15 : kind === "slantRight" ? 1.15 : randRange(-1.45, 1.45);

      if (safeStart) world.curve = 0;
      else {
        const targetCurve = kind === "snake" ? randRange(-.11, .11) : randRange(-.035, .035);
        world.curve = lerp(world.curve, targetCurve, .7);
        if (Math.abs(world.genX) > 14) world.curve = -Math.sign(world.genX) * Math.abs(world.curve || .04);
      }

      const slope = safeStart ? -.085 : randRange(-.135, -.068);
      const bankTarget = kind === "slantLeft" ? -3.45 : kind === "slantRight" ? 3.45 : 0;
      const chunkStartBank = world.bank;

      for (let i = 0; i < cells; i++) {
        const z0 = world.genZ;
        const z1 = z0 + 3;
        const x0 = world.genX;
        const curvePulse = !safeStart && i === 0
          ? chunkOffset / 3
          : kind === "snake"
            ? world.curve * .2 + Math.sin((i - 1) / Math.max(1, cells - 2) * Math.PI * 2) * .34
            : world.curve * .22;
        const x1 = x0 + curvePulse * 3;
        const y0 = world.genY;
        const launch = ["straight", "snake", "tunnel", "speedTunnel"].includes(kind) && i === cells - 1;
        const y1 = y0 + (launch ? .25 : slope) * 3;
        const gap = !safeStart && i === 0;
        const tunnel = kind === "tunnel" || kind === "speedTunnel";
        const speedTunnel = kind === "speedTunnel";
        const thin = kind === "straight" || kind === "snake";
        const tunnelRadius = tunnel ? widthBase * .54 : 0;
        const width = tunnel
          ? tunnelRadius * 1.32
          : thin ? widthBase * .68
            : kind.startsWith("slant") ? widthBase * 1.14 : widthBase;
        const boost = speedTunnel && i > 0;
        const bankEase0 = Math.sin(Math.PI * clamp(i / Math.max(1, cells - 1), 0, 1));
        const bankEase1 = Math.sin(Math.PI * clamp((i + 1) / Math.max(1, cells - 1), 0, 1));
        const bank0 = lerp(chunkStartBank, bankTarget, bankEase0);
        const bank1 = lerp(chunkStartBank, bankTarget, bankEase1);
        world.segments.push({
          z0, z1, x0, x1, y0, y1, width, gap, tunnel, tunnelRadius, speedTunnel, boost, launch, bank0, bank1, splitGap: 0,
          scoreIndex: platformScore,
          tunnelStart: tunnel && i === 1,
          tunnelEnd: tunnel && i === cells - 1,
          tunnelFrame: tunnel && (i === 1 || i === Math.floor(cells * .55) || i === cells - 1),
          chunkKind: kind,
          chunkId: world.chunk,
          cellIndex: i
        });

        if (!safeStart && !gap && !tunnel) {
          let forced = null;
          if (kind === "rng" && i === Math.floor(cells * .5)) forced = "single";
          else if (kind === "treblock" && (i === 2 || i === 16)) forced = "edgePair";
          else if (kind === "treblock" && i === 7) forced = "center";
          else if (kind === "hor" && i === 4) forced = "hor";
          else if (kind === "verts" && i === Math.floor(cells * .5)) forced = "verts";
          if (forced) {
            addObstacle(z0 + 1.5, width, forced);
            world.lastObstacleZ = z0;
          }
        }

        if (i % 2 === 0) {
          for (const side of [-1, 1]) {
            if (world.random() < .9) {
              world.city.push({
                x: x0 + side * randRange(11.5, 26),
                z: z0 + randRange(-2, 4),
                y: y0 - randRange(6, 15),
                w: randRange(3.5, 8.5),
                d: randRange(4, 9.5),
                h: randRange(14, 42)
              });
            }
          }
        }

        world.genZ = z1;
        world.genX = x1;
        world.genY = y1;
      }
      world.bank = 0;
    }
  }

  function segmentAt(z) {
    const segments = game.world?.segments || [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (z >= s.z0 && z < s.z1) return s;
    }
    return null;
  }

  function sampleTrack(segment, z) {
    if (!segment) return { x: 0, y: -999, bank: 0 };
    const t = clamp((z - segment.z0) / (segment.z1 - segment.z0), 0, 1);
    return {
      x: lerp(segment.x0, segment.x1, t),
      y: lerp(segment.y0, segment.y1, t),
      bank: lerp(segment.bank0 || 0, segment.bank1 || 0, t)
    };
  }

  function surfaceY(segment, z, x) {
    const track = sampleTrack(segment, z);
    return track.y + track.bank * clamp((x - track.x) / Math.max(1, segment.width), -.5, .5);
  }

  function resetRun() {
    createWorld(false);
    const p = profile();
    game.runStartZ = 0;
    game.runTime = 0;
    game.score = 0;
    game.speed = settings.startSpeed * p.speed;
    game.deathTimer = 0;
    game.shake = 0;
    game.boostLatch = false;
    game.launchLatch = false;
    game.hudNext = 0;
    game.particles.length = 0;
    const start = sampleTrack(segmentAt(0), 0);
    Object.assign(game.player, { x: start.x, y: start.y + BALL_RADIUS, z: 0, vx: 0, vy: -1, grounded: true });
    updateHud();
  }

  function startRun() {
    audio.start();
    audio.apply(false);
    resetRun();
    game.state = "playing";
    ui.menu.classList.add("hidden");
    ui.pause.classList.add("hidden");
    ui.over.classList.add("hidden");
    ui.hud.classList.add("visible");
    ui.app.classList.add("run-active");
  }

  function toMenu() {
    game.state = "menu";
    ui.menu.classList.remove("hidden");
    ui.pause.classList.add("hidden");
    ui.over.classList.add("hidden");
    ui.hud.classList.remove("visible");
    ui.app.classList.remove("run-active");
    closeModals();
    createWorld(true);
    const start = sampleTrack(segmentAt(0), 0);
    Object.assign(game.player, { x: start.x, y: start.y + BALL_RADIUS, z: 0, vx: 0, vy: 0, grounded: true });
    game.speed = settings.startSpeed;
    audio.apply(true);
    syncBest();
  }

  function pauseGame() {
    if (game.state !== "playing") return;
    game.state = "paused";
    ui.pauseScore.textContent = padScore(game.score);
    ui.pauseSpeed.textContent = String(Math.round(game.speed * 3.6));
    ui.pause.classList.remove("hidden");
    audio.apply(true);
  }

  function resumeGame() {
    if (game.state !== "paused") return;
    game.state = "playing";
    ui.pause.classList.add("hidden");
    audio.start();
    audio.apply(false);
  }

  function triggerDeath(reason) {
    if (game.state !== "playing") return;
    game.state = "dying";
    game.reason = reason;
    game.deathTimer = 0;
    game.shake = 1;
    audio.effect("crash");
    audio.apply(true);
    const p = game.player;
    const random = game.world.random;
    for (let i = 0; i < 34; i++) {
      game.particles.push({
        x: p.x + randRange(-0.18, 0.18), y: p.y + randRange(-0.18, 0.18), z: p.z + randRange(-0.18, 0.18),
        vx: randRange(-8, 8), vy: randRange(-1, 10), vz: randRange(-6, 7),
        life: randRange(0.45, 1.05), maxLife: 1, size: randRange(0.05, 0.15),
        color: reason === "COLLISION" && random() > 0.35 ? "#ff3652" : "#22ff78"
      });
    }
  }

  function showGameOver() {
    game.state = "over";
    const oldBest = best;
    if (game.score > best) {
      best = game.score;
      localStorage.setItem("slope-vector-best", String(best));
    }
    ui.finalScore.textContent = padScore(game.score);
    ui.bestCallout.textContent = game.score > oldBest ? "NEW BEST // PERSONAL RECORD" : `BEST // ${padScore(best)}`;
    ui.crashReason.textContent = game.reason === "FALL" ? "SIGNAL LOST // VOID" : "SIGNAL LOST // COLLISION";
    ui.over.classList.remove("hidden");
    ui.hud.classList.remove("visible");
    ui.app.classList.remove("run-active");
    syncBest();
  }

  function obstacleAge(o) {
    return o.activeAt === null ? -o.delay : game.runTime - o.activeAt - o.delay;
  }

  function obstacleX(o) {
    const s = segmentAt(o.z);
    const center = sampleTrack(s, o.z).x;
    if (!o.moving) return center + o.offset;
    const age = obstacleAge(o);
    if (age <= 0) return center + o.offset - o.amp;
    const cycle = (age / 3) % 2;
    const progress = cycle <= 1 ? cycle : 2 - cycle;
    return center + o.offset - o.amp + o.amp * 2 * progress;
  }

  function obstacleLift(o) {
    if (!o.vertical) return 0;
    const age = obstacleAge(o);
    if (age <= 0) return 0;
    const cycle = (age % 4) / 4;
    const lift = cycle < .5 ? cycle * 2 : (1 - cycle) * 2;
    return lift * o.verticalAmp;
  }

  function sphereIntersectsBox(x, y, z, radius, bx, by, bz, width, height, depth) {
    const closestX = clamp(x, bx - width * .5, bx + width * .5);
    const closestY = clamp(y, by, by + height);
    const closestZ = clamp(z, bz - depth * .5, bz + depth * .5);
    const dx = x - closestX;
    const dy = y - closestY;
    const dz = z - closestZ;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  }

  function updatePlaying(dt) {
    const p = game.player;
    const pr = profile();
    game.runTime += dt;
    const priorX = p.x;
    const priorY = p.y;
    const priorZ = p.z;
    const steer = clamp((game.input.right ? 1 : 0) - (game.input.left ? 1 : 0) + game.input.touch, -1, 1);
    const targetVx = steer * 12.8 * settings.sensitivity * (0.82 + game.speed / 92);
    p.vx = lerp(p.vx, targetVx, ease(7.6, dt));
    if (!steer) p.vx *= Math.pow(0.18, dt);
    p.x += p.vx * dt;

    const max = settings.maxSpeed * pr.max;
    game.speed = Math.min(max, game.speed + settings.acceleration * pr.accel * dt);
    p.z += game.speed * dt;
    game.ballRotation += game.speed * dt * 1.65;

    for (const o of game.world.obstacles) {
      if (o.activeAt === null && p.z >= o.z - 125) o.activeAt = game.runTime;
    }

    const seg = segmentAt(p.z);
    const track = sampleTrack(seg, p.z);
    const radius = BALL_RADIUS;
    const lateral = Math.abs(p.x - track.x);
    const outsideSplit = !seg?.splitGap || lateral >= seg.splitGap * .5 + radius * .18;
    const overSurface = seg && !seg.gap && outsideSplit && lateral <= seg.width * .5 - radius * .12;
    const trackY = overSurface ? surfaceY(seg, p.z, p.x) : track.y;

    if (p.grounded) {
      if (overSurface) {
        p.y = trackY + radius;
        p.vy = ((seg.y1 - seg.y0) / (seg.z1 - seg.z0)) * game.speed;
      } else {
        p.grounded = false;
      }
    } else {
      p.vy -= 19.5 * dt;
      p.y += p.vy * dt;
      if (overSurface && p.vy <= 0 && p.y <= trackY + radius + 0.24 && p.y > trackY - 1.3) {
        p.grounded = true;
        p.y = trackY + radius;
        audio.effect("ui");
      }
    }

    if (p.grounded && seg?.launch && overSurface && p.z > seg.z1 - .72 && !game.launchLatch) {
      p.grounded = false;
      p.vy = 4.7;
      game.launchLatch = true;
    } else if (!seg?.launch) {
      game.launchLatch = false;
    }

    if (seg?.boost && overSurface) {
      game.speed = Math.min(max, game.speed + 5.2 * dt);
      if (!game.boostLatch) {
        game.boostLatch = true;
        audio.effect("boost");
      }
    } else {
      game.boostLatch = false;
    }

    const referenceY = seg ? track.y : (segmentAt(p.z + 2) ? sampleTrack(segmentAt(p.z + 2), p.z + 2).y : p.y + 1);
    if (p.y < referenceY - 8.5) triggerDeath("FALL");

    for (const o of game.world.obstacles) {
      if (o.z + o.d * .5 + radius < priorZ || o.z - o.d * .5 - radius > p.z) continue;
      const ox = obstacleX(o);
      const os = segmentAt(o.z);
      const base = surfaceY(os, o.z, ox) + (o.baseOffset || 0) + obstacleLift(o);
      const travel = Math.max(.0001, p.z - priorZ);
      const t = clamp((o.z - priorZ) / travel, 0, 1);
      const ballX = lerp(priorX, p.x, t);
      const ballY = lerp(priorY, p.y, t);
      const ballZ = lerp(priorZ, p.z, t);
      if (sphereIntersectsBox(ballX, ballY, ballZ, radius, ox, base, o.z, o.w, o.h, o.d)) {
        triggerDeath("COLLISION");
        break;
      }
    }

    for (const o of game.world.obstacles) {
      if (!o.passed && o.z < p.z - 1.2) {
        o.passed = true;
        const clearance = Math.abs(p.x - obstacleX(o)) - o.w * 0.5;
        if (clearance < 1.05) {
          audio.effect("near");
          game.shake = Math.max(game.shake, 0.16);
        }
      }
    }

    game.score = Math.max(game.score, seg?.scoreIndex || 0);
    if (p.z >= game.world.nextMaintenanceZ) {
      extendWorld(p.z + 460);
      trimWorld();
      game.world.nextMaintenanceZ = p.z + 18;
    }
    if (game.time >= game.hudNext) {
      updateHud();
      game.hudNext = game.time + 0.1;
    }
  }

  function trimWorld() {
    const cutoff = game.player.z - 35;
    const world = game.world;
    while (world.segments.length && world.segments[0].z1 < cutoff) world.segments.shift();
    world.obstacles = world.obstacles.filter((o) => o.z > cutoff);
    world.city = world.city.filter((b) => b.z + b.d > cutoff - 15);
  }

  function updateDying(dt) {
    game.deathTimer += dt;
    game.shake = Math.max(0, game.shake - dt * 0.85);
    game.ballRotation += game.speed * dt;
    if (game.reason === "FALL") {
      game.player.vy -= 20 * dt;
      game.player.y += game.player.vy * dt;
      game.player.z += game.speed * dt * 0.28;
    }
    for (const particle of game.particles) {
      particle.vy -= 13 * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      particle.life -= dt;
    }
    game.particles = game.particles.filter((particle) => particle.life > 0);
    if (game.deathTimer >= 0.78) showGameOver();
  }

  function updateHud() {
    ui.score.textContent = String(Math.floor(game.score));
    ui.best.textContent = padScore(Math.max(best, game.score));
    ui.speed.textContent = String(Math.round(game.speed * 3.6));
    const min = settings.startSpeed * profile().speed;
    const max = settings.maxSpeed * profile().max;
    ui.speedFill.style.width = `${clamp((game.speed - min) / Math.max(1, max - min), 0.06, 1) * 100}%`;
  }

  function syncBest() {
    ui.best.textContent = padScore(best);
    ui.menuBest.textContent = padScore(best);
  }

  const V = {
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
    cross: (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }),
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
    norm: (a) => {
      const len = Math.hypot(a.x, a.y, a.z) || 1;
      return { x: a.x / len, y: a.y / len, z: a.z / len };
    }
  };

  const camera = { pos: { x: 0, y: 4, z: -10 }, forward: null, right: null, up: null, focal: 600 };

  function updateCamera() {
    const p = game.player;
    camera.pos.x = p.x;
    camera.pos.y = p.y + 4.8;
    camera.pos.z = p.z - 7.05;
    const target = { x: p.x, y: p.y - .78, z: p.z + 14.5 };
    camera.forward = V.norm(V.sub(target, camera.pos));
    camera.right = V.norm(V.cross({ x: 0, y: 1, z: 0 }, camera.forward));
    camera.up = V.cross(camera.forward, camera.right);
    camera.focal = H * 0.5 / Math.tan(settings.fov * Math.PI / 360);
  }

  const PROJ_A = new Float64Array(3);
  const PROJ_B = new Float64Array(3);
  const PROJ_C = new Float64Array(3);
  const PROJ_D = new Float64Array(3);
  const BOX_PROJ = new Float64Array(24);
  const BOX_EDGES = new Uint8Array([0,1, 1,2, 2,3, 3,0, 4,5, 5,6, 6,7, 7,4, 0,4, 1,5, 2,6, 3,7]);

  function projectInto(x, y, z, out) {
    const dx = x - camera.pos.x;
    const dy = y - camera.pos.y;
    const dz = z - camera.pos.z;
    const depth = dx * camera.forward.x + dy * camera.forward.y + dz * camera.forward.z;
    if (depth < 0.22) return false;
    const scale = camera.focal / depth;
    out[0] = W * 0.5 + (dx * camera.right.x + dy * camera.right.y + dz * camera.right.z) * scale;
    out[1] = H * 0.49 - (dx * camera.up.x + dy * camera.up.y + dz * camera.up.z) * scale;
    out[2] = depth;
    return true;
  }

  function project(point) {
    if (!projectInto(point.x, point.y, point.z, PROJ_A)) return null;
    return { x: PROJ_A[0], y: PROJ_A[1], depth: PROJ_A[2] };
  }

  function appendLine(path, x1, y1, z1, x2, y2, z2) {
    if (!projectInto(x1, y1, z1, PROJ_A) || !projectInto(x2, y2, z2, PROJ_B)) return;
    path.moveTo(PROJ_A[0], PROJ_A[1]);
    path.lineTo(PROJ_B[0], PROJ_B[1]);
  }

  function appendQuad(path, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
    if (!projectInto(ax, ay, az, PROJ_A) || !projectInto(bx, by, bz, PROJ_B) ||
        !projectInto(cx, cy, cz, PROJ_C) || !projectInto(dx, dy, dz, PROJ_D)) return;
    path.moveTo(PROJ_A[0], PROJ_A[1]);
    path.lineTo(PROJ_B[0], PROJ_B[1]);
    path.lineTo(PROJ_C[0], PROJ_C[1]);
    path.lineTo(PROJ_D[0], PROJ_D[1]);
    path.closePath();
  }

  function projectBoxPoint(index, x, y, z) {
    if (!projectInto(x, y, z, PROJ_A)) return false;
    const offset = index * 3;
    BOX_PROJ[offset] = PROJ_A[0];
    BOX_PROJ[offset + 1] = PROJ_A[1];
    BOX_PROJ[offset + 2] = PROJ_A[2];
    return true;
  }

  function projectBox(x, y, z, w, h, d) {
    const x0 = x - w * 0.5;
    const x1 = x + w * 0.5;
    const z0 = z - d * 0.5;
    const z1 = z + d * 0.5;
    const y1 = y + h;
    return projectBoxPoint(0,x0,y,z0) && projectBoxPoint(1,x1,y,z0) &&
      projectBoxPoint(2,x1,y1,z0) && projectBoxPoint(3,x0,y1,z0) &&
      projectBoxPoint(4,x0,y,z1) && projectBoxPoint(5,x1,y,z1) &&
      projectBoxPoint(6,x1,y1,z1) && projectBoxPoint(7,x0,y1,z1);
  }

  function appendBoxFace(path, a, b, c, d) {
    path.moveTo(BOX_PROJ[a * 3], BOX_PROJ[a * 3 + 1]);
    path.lineTo(BOX_PROJ[b * 3], BOX_PROJ[b * 3 + 1]);
    path.lineTo(BOX_PROJ[c * 3], BOX_PROJ[c * 3 + 1]);
    path.lineTo(BOX_PROJ[d * 3], BOX_PROJ[d * 3 + 1]);
    path.closePath();
  }

  function appendBoxEdges(path) {
    for (let i = 0; i < BOX_EDGES.length; i += 2) {
      const a = BOX_EDGES[i] * 3;
      const b = BOX_EDGES[i + 1] * 3;
      path.moveTo(BOX_PROJ[a], BOX_PROJ[a + 1]);
      path.lineTo(BOX_PROJ[b], BOX_PROJ[b + 1]);
    }
  }

  function appendBoxEdge(path, a, b) {
    appendScreenLine(path, BOX_PROJ[a * 3], BOX_PROJ[a * 3 + 1], BOX_PROJ[b * 3], BOX_PROJ[b * 3 + 1]);
  }

  function appendVisibleBoxEdges(path, showLeft) {
    appendBoxEdge(path, 0, 1);
    appendBoxEdge(path, 1, 2);
    appendBoxEdge(path, 2, 3);
    appendBoxEdge(path, 3, 0);
    if (showLeft) {
      appendBoxEdge(path, 0, 4);
      appendBoxEdge(path, 4, 7);
      appendBoxEdge(path, 7, 3);
    } else {
      appendBoxEdge(path, 1, 5);
      appendBoxEdge(path, 5, 6);
      appendBoxEdge(path, 6, 2);
    }
  }

  function appendScreenLine(path, ax, ay, bx, by) {
    path.moveTo(ax, ay);
    path.lineTo(bx, by);
  }

  function appendBoxFaceGrid(path, a, b, c, d, columns, rows) {
    const ax = BOX_PROJ[a * 3], ay = BOX_PROJ[a * 3 + 1];
    const bx = BOX_PROJ[b * 3], by = BOX_PROJ[b * 3 + 1];
    const cx = BOX_PROJ[c * 3], cy = BOX_PROJ[c * 3 + 1];
    const dx = BOX_PROJ[d * 3], dy = BOX_PROJ[d * 3 + 1];
    for (let i = 1; i < columns; i++) {
      const t = i / columns;
      appendScreenLine(path, lerp(ax,bx,t), lerp(ay,by,t), lerp(dx,cx,t), lerp(dy,cy,t));
    }
    for (let i = 1; i < rows; i++) {
      const t = i / rows;
      appendScreenLine(path, lerp(ax,dx,t), lerp(ay,dy,t), lerp(bx,cx,t), lerp(by,cy,t));
    }
  }

  function appendRing(path, cx, floorY, z, radius, steps = 18) {
    let started = false;
    const centerY = floorY + radius * TUNNEL_CENTER_LIFT;
    for (let i = 0; i <= steps; i++) {
      const angle = -Math.PI * .5 + i / steps * Math.PI * 2;
      if (!projectInto(cx + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius, z, PROJ_A)) {
        started = false;
        continue;
      }
      if (!started) path.moveTo(PROJ_A[0], PROJ_A[1]);
      else path.lineTo(PROJ_A[0], PROJ_A[1]);
      started = true;
    }
  }

  function rebuildBackground() {
    const bw = 2;
    const bh = 2;
    backgroundLayer = document.createElement("canvas");
    backgroundLayer.width = bw;
    backgroundLayer.height = bh;
    const bgCtx = backgroundLayer.getContext("2d", { alpha: false });
    bgCtx.fillStyle = "#000000";
    bgCtx.fillRect(0, 0, bw, bh);
  }

  function drawBackground() {
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    if (backgroundLayer) ctx.drawImage(backgroundLayer, 0, 0, W, H);
    else {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawSpeedStreaks(q) {
    if (settings.reducedMotion || game.state !== "playing" || q.streaks === 0) return;
    const amount = clamp((game.speed - 30) / 35, 0, 1);
    if (amount <= 0) return;
    const path = new Path2D();
    const cx = W * .5;
    const cy = H * .43;
    const minSide = Math.min(W, H);
    for (let i = 0; i < q.streaks; i++) {
      const angle = (i * 2.399 + game.time * .08) % (Math.PI * 2);
      const radius = minSide * (.18 + ((i * .173 + game.time * .06) % .5));
      const len = 12 + amount * 40;
      path.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      path.lineTo(cx + Math.cos(angle) * (radius + len), cy + Math.sin(angle) * (radius + len));
    }
    ctx.strokeStyle = `rgba(79,255,145,${0.055 * amount})`;
    ctx.lineWidth = 1;
    ctx.stroke(path);
  }

  function drawCity(q) {
    const bandCount = selectedQualityLevel() === 0 ? 10 : selectedQualityLevel() === 1 ? 18 : 22;
    const bands = Array.from({ length: bandCount }, () => ({
      faces: new Path2D(), grids: new Path2D(), edges: new Path2D(), count: 0
    }));
    const city = game.world.city;
    const near = game.player.z - 10;
    const far = game.player.z + q.cityDistance;
    for (let i = city.length - 1; i >= 0; i--) {
      const b = city[i];
      if (b.z > far) continue;
      if (b.z + b.d < near) break;
      if (i % q.cityStride !== 0) continue;
      if (!projectBox(b.x, b.y, b.z, b.w, b.h, b.d)) continue;
      const bandIndex = clamp(Math.floor((b.z - near) / Math.max(1, far - near) * bandCount), 0, bandCount - 1);
      const band = bands[bandIndex];
      const showLeft = b.x > camera.pos.x;
      appendBoxFace(band.faces, 0,1,2,3);
      if (showLeft) appendBoxFace(band.faces, 0,4,7,3);
      else appendBoxFace(band.faces, 1,5,6,2);
      appendVisibleBoxEdges(band.edges, showLeft);
      const verticals = Math.max(3, Math.min(q.buildingGrid, Math.round(b.w / 1.1)));
      const floors = Math.max(5, Math.min(q.buildingGrid * 2, Math.round(b.h / 1.65)));
      appendBoxFaceGrid(band.grids, 0,1,2,3, verticals, floors);
      if (showLeft) appendBoxFaceGrid(band.grids, 0,4,7,3, Math.max(3, Math.round(b.d / 1.3)), floors);
      else appendBoxFaceGrid(band.grids, 1,5,6,2, Math.max(3, Math.round(b.d / 1.3)), floors);
      band.count++;
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    for (let i = bandCount - 1; i >= 0; i--) {
      const band = bands[i];
      if (!band.count) continue;
      ctx.fillStyle = "#000000";
      ctx.fill(band.faces);
      ctx.strokeStyle = "#009f23";
      ctx.lineWidth = selectedQualityLevel() === 0 ? .65 : .9;
      ctx.stroke(band.grids);
      ctx.strokeStyle = "#00c72a";
      ctx.lineWidth = 1.2;
      ctx.stroke(band.edges);
    }
  }

  function drawTrack(q) {
    const batches = [];
    let batch = null;
    const segments = game.world.segments;
    const near = game.player.z - 13;
    const far = game.player.z + q.drawDistance;

    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (s.z0 > far) continue;
      if (s.z1 < near) break;
      if (s.gap) continue;
      const groupKey = s.tunnel ? `${s.chunkId}:${s.cellIndex}` : String(s.chunkId);
      if (!batch || batch.groupKey !== groupKey) {
        batch = {
          groupKey,
          chunkId: s.chunkId,
          tops: new Path2D(),
          sideFaces: new Path2D(),
          tunnelShell: new Path2D(),
          tunnelLong: new Path2D(),
          trackGrids: [new Path2D(), new Path2D(), new Path2D(), new Path2D()],
          trackEdges: [new Path2D(), new Path2D(), new Path2D(), new Path2D()],
          tunnelFrames: new Path2D()
        };
        batches.push(batch);
      }
      const { tops, sideFaces, tunnelShell, tunnelLong, trackGrids, trackEdges, tunnelFrames } = batch;
      const ahead = s.z0 - game.player.z;
      const lineBand = ahead < 18 ? 0 : ahead < 48 ? 1 : ahead < 110 ? 2 : 3;
      const grid = trackGrids[lineBand];
      const edges = trackEdges[lineBand];
      const half = s.width * .5;
      const ax = s.x0 - half, bx = s.x0 + half;
      const dx = s.x1 - half, cx = s.x1 + half;
      const y0L = s.y0 - (s.bank0 || 0) * .5;
      const y0R = s.y0 + (s.bank0 || 0) * .5;
      const y1L = s.y1 - (s.bank1 || 0) * .5;
      const y1R = s.y1 + (s.bank1 || 0) * .5;

      if (s.splitGap) {
        const inner0L = s.x0 - s.splitGap * .5;
        const inner0R = s.x0 + s.splitGap * .5;
        const inner1L = s.x1 - s.splitGap * .5;
        const inner1R = s.x1 + s.splitGap * .5;
        const iy0L = s.y0 - (s.bank0 || 0) * s.splitGap / (s.width * 2);
        const iy0R = s.y0 + (s.bank0 || 0) * s.splitGap / (s.width * 2);
        const iy1L = s.y1 - (s.bank1 || 0) * s.splitGap / (s.width * 2);
        const iy1R = s.y1 + (s.bank1 || 0) * s.splitGap / (s.width * 2);
        appendQuad(tops, ax,y0L,s.z0, inner0L,iy0L,s.z0, inner1L,iy1L,s.z1, dx,y1L,s.z1);
        appendQuad(tops, inner0R,iy0R,s.z0, bx,y0R,s.z0, cx,y1R,s.z1, inner1R,iy1R,s.z1);
        appendQuad(sideFaces, inner0L,iy0L,s.z0, inner1L,iy1L,s.z1, inner1L,iy1L-.42,s.z1, inner0L,iy0L-.42,s.z0);
        appendQuad(sideFaces, inner0R,iy0R,s.z0, inner1R,iy1R,s.z1, inner1R,iy1R-.42,s.z1, inner0R,iy0R-.42,s.z0);
        appendLine(edges, ax,y0L,s.z0, inner0L,iy0L,s.z0);
        appendLine(edges, inner0R,iy0R,s.z0, bx,y0R,s.z0);
        appendLine(edges, inner0L,iy0L,s.z0, inner1L,iy1L,s.z1);
        appendLine(edges, inner0R,iy0R,s.z0, inner1R,iy1R,s.z1);
        const leftMid0 = lerp(ax, inner0L, .5), leftMid1 = lerp(dx, inner1L, .5);
        const rightMid0 = lerp(inner0R, bx, .5), rightMid1 = lerp(inner1R, cx, .5);
        appendLine(grid, leftMid0, lerp(y0L,iy0L,.5)+.01,s.z0, leftMid1,lerp(y1L,iy1L,.5)+.01,s.z1);
        appendLine(grid, rightMid0,lerp(iy0R,y0R,.5)+.01,s.z0, rightMid1,lerp(iy1R,y1R,.5)+.01,s.z1);
      } else {
        appendQuad(tops, ax,y0L,s.z0, bx,y0R,s.z0, cx,y1R,s.z1, dx,y1L,s.z1);
        appendLine(edges, ax,y0L,s.z0, bx,y0R,s.z0);
        appendLine(grid,
          lerp(ax,bx,.333),lerp(y0L,y0R,.333)+.01,s.z0,
          lerp(dx,cx,.333),lerp(y1L,y1R,.333)+.01,s.z1);
        appendLine(grid,
          lerp(ax,bx,.667),lerp(y0L,y0R,.667)+.01,s.z0,
          lerp(dx,cx,.667),lerp(y1L,y1R,.667)+.01,s.z1);
      }

      appendQuad(sideFaces, ax,y0L,s.z0, dx,y1L,s.z1, dx,y1L-.42,s.z1, ax,y0L-.42,s.z0);
      appendQuad(sideFaces, bx,y0R,s.z0, cx,y1R,s.z1, cx,y1R-.42,s.z1, bx,y0R-.42,s.z0);
      appendLine(edges, ax,y0L,s.z0, dx,y1L,s.z1);
      appendLine(edges, bx,y0R,s.z0, cx,y1R,s.z1);

      if (s.tunnelFrame) {
        appendRing(tunnelFrames, s.x0, s.y0, s.z0, s.tunnelRadius, selectedQualityLevel() === 0 ? 14 : 20);
      }
      if (s.tunnel) {
        const steps = selectedQualityLevel() === 0 ? 10 : 14;
        const radius = s.tunnelRadius;
        const center0Y = s.y0 + radius * TUNNEL_CENTER_LIFT;
        const center1Y = s.y1 + radius * TUNNEL_CENTER_LIFT;
        for (let ring = 0; ring < steps; ring++) {
          const a0 = -Math.PI * .5 + ring / steps * Math.PI * 2;
          const a1 = -Math.PI * .5 + (ring + 1) / steps * Math.PI * 2;
          const x0a = s.x0 + Math.cos(a0) * radius;
          const y0a = center0Y + Math.sin(a0) * radius;
          const x0b = s.x0 + Math.cos(a1) * radius;
          const y0b = center0Y + Math.sin(a1) * radius;
          const x1a = s.x1 + Math.cos(a0) * radius;
          const y1a = center1Y + Math.sin(a0) * radius;
          const x1b = s.x1 + Math.cos(a1) * radius;
          const y1b = center1Y + Math.sin(a1) * radius;
          appendQuad(tunnelShell, x0a,y0a,s.z0, x0b,y0b,s.z0, x1b,y1b,s.z1, x1a,y1a,s.z1);
          if (ring % 3 === 0) appendLine(tunnelLong, x0a,y0a,s.z0, x1a,y1a,s.z1);
        }
      }
    }

    const gridWidths = [3.2, 2.25, 1.45, .72];
    const edgeWidths = [4.15, 2.85, 1.7, .88];
    ctx.globalAlpha = 1;
    for (const platform of batches) {
      const { tops, sideFaces, tunnelShell, tunnelLong, trackGrids, trackEdges, tunnelFrames } = platform;
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#000000";
      ctx.fill(tunnelShell);
      ctx.fill(sideFaces);
      ctx.fill(tops);

      for (let band = 3; band >= 0; band--) {
        ctx.strokeStyle = "#00d329";
        ctx.lineWidth = gridWidths[band];
        ctx.stroke(trackGrids[band]);
      }
      ctx.strokeStyle = "#009d22";
      ctx.lineWidth = 1;
      ctx.stroke(tunnelLong);

      ctx.strokeStyle = "#00e62c";
      if (settings.glow && q.glow) {
        ctx.shadowColor = "#00e62c";
        ctx.shadowBlur = 1;
      }
      for (let band = 3; band >= 0; band--) {
        ctx.lineWidth = edgeWidths[band];
        ctx.stroke(trackEdges[band]);
      }
      ctx.shadowBlur = 0;

      ctx.strokeStyle = "#00dc2a";
      ctx.lineWidth = 1.7;
      ctx.stroke(tunnelFrames);
    }
    ctx.globalAlpha = 1;
  }

  function drawTunnelBricks(q) {
    const near = game.player.z - 7;
    const far = game.player.z + Math.min(q.drawDistance, 230);
    const segments = game.world.segments;

    ctx.globalAlpha = 1;
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (s.z0 > far) continue;
      if (s.z0 < near) break;
      if (!s.speedTunnel || s.cellIndex % 3 !== 2) continue;
      for (const side of [-1, 1]) {
        const x = s.x0 + side * s.tunnelRadius * .72;
        const y = s.y0 + 1.25 + (Math.floor(s.cellIndex / 3) % 2) * .75;
        if (!projectBox(x, y, s.z0 + 1.2, .82, .78, 1.5)) continue;
        const showLeft = x > camera.pos.x;
        const faces = new Path2D();
        const lines = new Path2D();
        appendBoxFace(faces, 0,1,2,3);
        if (showLeft) appendBoxFace(faces, 0,4,7,3);
        else appendBoxFace(faces, 1,5,6,2);
        appendVisibleBoxEdges(lines, showLeft);

        // Complete each brick back-to-front so its solid black faces occlude
        // every red line belonging to bricks farther down the course.
        ctx.fillStyle = "#000000";
        ctx.fill(faces);
        ctx.strokeStyle = "#dc0b18";
        ctx.lineWidth = 1.4;
        ctx.stroke(lines);
      }
    }
  }

  function drawObstacles(q) {
    const obstacles = game.world.obstacles;
    const near = game.player.z - 8;
    const far = game.player.z + Math.min(q.drawDistance, 300);

    ctx.globalAlpha = 1;
    if (settings.glow && q.glow) {
      ctx.shadowColor = "#dc0b18";
      ctx.shadowBlur = 1;
    }
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      if (o.z > far) continue;
      if (o.z < near) break;
      const ox = obstacleX(o);
      const base = surfaceY(segmentAt(o.z), o.z, ox) + .02 + (o.baseOffset || 0) + obstacleLift(o);
      if (!projectBox(ox, base, o.z, o.w, o.h, o.d)) continue;
      const showLeft = ox > camera.pos.x;
      const faces = new Path2D();
      const grids = new Path2D();
      const edges = new Path2D();
      appendBoxFace(faces, 3,2,6,7);
      appendBoxFace(faces, 0,1,2,3);
      if (showLeft) appendBoxFace(faces, 0,4,7,3);
      else appendBoxFace(faces, 1,5,6,2);
      appendVisibleBoxEdges(edges, showLeft);
      appendBoxEdge(edges, 3,7);
      appendBoxEdge(edges, 7,6);
      appendBoxEdge(edges, 6,2);
      const rows = Math.max(1, Math.round(o.h / 2));
      appendBoxFaceGrid(grids, 0,1,2,3, 2, rows);
      if (showLeft) appendBoxFaceGrid(grids, 0,4,7,3, 2, rows);
      else appendBoxFaceGrid(grids, 1,5,6,2, 2, rows);

      // A block is one opaque draw unit. Rendering its fill and lines before
      // advancing to the next nearer block restores true depth occlusion.
      ctx.fillStyle = "#000000";
      ctx.fill(faces);
      ctx.strokeStyle = "#9f0711";
      ctx.lineWidth = .9;
      ctx.stroke(grids);
      ctx.strokeStyle = "#dc0b18";
      ctx.lineWidth = 1.75;
      ctx.stroke(edges);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  function drawBall(q) {
    if (game.state === "dying" && game.reason === "COLLISION" && game.deathTimer > .12) return;
    const p = project(game.player);
    if (!p) return;
    const radius = Math.max(4, camera.focal * BALL_RADIUS / p.depth);

    ctx.save();
    if (settings.glow && q.glow) {
      ctx.shadowColor = "#00e62c";
      ctx.shadowBlur = Math.min(2, radius * .03);
    }
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.clip();
    ctx.translate(p.x, p.y);
    ctx.rotate(game.ballRotation * .022);
    ctx.strokeStyle = "#00e62c";
    ctx.lineWidth = Math.max(1.55, radius * .043);
    ctx.beginPath();
    ctx.moveTo(0, -radius * 1.03);
    ctx.bezierCurveTo(-radius * .12, -radius * .55, -radius * .12, radius * .55, 0, radius * 1.03);
    ctx.moveTo(0, -radius * 1.03);
    ctx.bezierCurveTo(-radius * .72, -radius * .48, -radius * .72, radius * .48, 0, radius * 1.03);
    ctx.moveTo(0, -radius * 1.03);
    ctx.bezierCurveTo(radius * .72, -radius * .48, radius * .72, radius * .48, 0, radius * 1.03);
    ctx.moveTo(radius * 1.04, 0);
    ctx.ellipse(0, 0, radius * 1.04, radius * .27, 0, 0, Math.PI * 2);
    ctx.moveTo(radius * .83, -radius * .38);
    ctx.ellipse(0, -radius * .38, radius * .83, radius * .16, 0, 0, Math.PI * 2);
    ctx.moveTo(radius * .83, radius * .38);
    ctx.ellipse(0, radius * .38, radius * .83, radius * .16, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = "#00e62c";
    ctx.lineWidth = Math.max(1.75, radius * .047);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawParticles(q) {
    const glow = settings.glow && q.glow;
    for (const particle of game.particles) {
      const p = project(particle);
      if (!p) continue;
      const size = Math.max(1, camera.focal * particle.size / p.depth);
      ctx.globalAlpha = clamp(particle.life / .45, 0, 1);
      ctx.fillStyle = particle.color;
      if (glow) {
        ctx.shadowColor = particle.color;
        ctx.shadowBlur = 5;
      }
      ctx.fillRect(p.x - size, p.y - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  function render() {
    if (!game.world) return;
    const q = renderQuality();
    updateCamera();
    drawBackground();
    drawSpeedStreaks(q);
    drawCity(q);
    drawTrack(q);
    drawTunnelBricks(q);
    drawObstacles(q);
    drawParticles(q);
    drawBall(q);
  }

  function updateAutoQuality(now, renderCost) {
    perf.renderEma += (renderCost - perf.renderEma) * .045;
    perf.frames++;
    if (settings.renderMode !== "auto" || game.state !== "playing" || perf.frames < 90 || now - perf.lastAdjust < 2400) return;
    let next = perf.level;
    if (perf.renderEma > 11.5 && perf.level > 0) next--;
    else if (perf.renderEma < 5.8 && perf.level < 2 && now - perf.lastAdjust > 6500) next++;
    if (next !== perf.level) {
      perf.level = next;
      perf.lastAdjust = now;
      perf.frames = 0;
      resize();
    }
  }

  function frame(now) {
    const dt = Math.min((now - game.lastTime) / 1000, .034);
    game.lastTime = now;
    game.time += dt;
    game.shake = Math.max(0, game.shake - dt * .7);
    if (game.state === "playing") updatePlaying(dt);
    else if (game.state === "dying") updateDying(dt);
    else game.ballRotation += dt * 7;
    const renderStart = performance.now();
    render();
    updateAutoQuality(now, performance.now() - renderStart);
    requestAnimationFrame(frame);
  }

  let toastTimer = 0;
  function showToast(message) {
    clearTimeout(toastTimer);
    ui.toast.textContent = message;
    ui.toast.classList.add("show");
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 1600);
  }

  function closeModals() {
    ui.settings.classList.add("hidden");
    ui.how.classList.add("hidden");
  }

  function openSettings() {
    if (game.state === "playing") pauseGame();
    updateSettingsUI();
    ui.settings.classList.remove("hidden");
    audio.effect("ui");
  }

  function closeSettings() {
    saveSettings();
    ui.settings.classList.add("hidden");
    audio.apply(game.state !== "playing");
  }

  function openHow() {
    ui.how.classList.remove("hidden");
    audio.effect("ui");
  }

  function saveSettings() {
    localStorage.setItem("slope-vector-settings", JSON.stringify({ ...settings, fidelityVersion: FIDELITY_VERSION }));
    ui.sound.classList.toggle("muted", settings.muted);
  }

  function formatSetting(name, value) {
    if (name === "sensitivity" || name === "obstacleDensity") return `${Number(value).toFixed(2)}×`;
    if (name === "fov") return `${value}°`;
    if (name === "sfxVolume") return `${Math.round(value * 100)}%`;
    if (name === "acceleration") return Number(value).toFixed(2);
    if (name === "trackWidth") return Number(value).toFixed(1);
    return String(value);
  }

  function updateSettingsUI() {
    $$('[data-setting]').forEach((input) => {
      const key = input.dataset.setting;
      if (input.type === "checkbox") input.checked = Boolean(settings[key]);
      else input.value = settings[key];
      const output = $(`[data-for="${key}"]`);
      if (output) output.value = formatSetting(key, settings[key]);
    });
    ui.sound.classList.toggle("muted", settings.muted);
  }

  $$('[data-setting]').forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.setting;
      if (input.type === "checkbox") settings[key] = input.checked;
      else if (input.type === "range") settings[key] = Number(input.value);
      else settings[key] = input.value;
      const output = $(`[data-for="${key}"]`);
      if (output) output.value = formatSetting(key, settings[key]);
      if (key.includes("Volume")) audio.apply(game.state !== "playing");
      if (key === "renderMode") {
        if (settings.renderMode === "auto") perf.level = 1;
        perf.frames = 0;
        perf.renderEma = 8;
        perf.lastAdjust = performance.now();
        resize();
      }
      saveSettings();
    });
  });

  $("#startBtn").addEventListener("click", startRun);
  $("#retryBtn").addEventListener("click", startRun);
  $("#restartBtn").addEventListener("click", startRun);
  $("#resumeBtn").addEventListener("click", resumeGame);
  $("#pauseBtn").addEventListener("click", pauseGame);
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsQuickBtn").addEventListener("click", openSettings);
  $("#pauseSettingsBtn").addEventListener("click", openSettings);
  $("#overSettingsBtn").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsDone").addEventListener("click", closeSettings);
  $("#howBtn").addEventListener("click", openHow);
  $("#howClose").addEventListener("click", () => ui.how.classList.add("hidden"));
  $("#howDone").addEventListener("click", () => ui.how.classList.add("hidden"));
  $("#pauseMenuBtn").addEventListener("click", toMenu);
  $("#overMenuBtn").addEventListener("click", toMenu);
  $("#menuLogo").addEventListener("click", () => { if (game.state !== "menu") toMenu(); });

  $("#resetSettings").addEventListener("click", () => {
    Object.assign(settings, DEFAULTS);
    perf.level = 1;
    perf.frames = 0;
    perf.renderEma = 8;
    perf.lastAdjust = performance.now();
    resize();
    updateSettingsUI();
    saveSettings();
    audio.apply(game.state !== "playing");
    showToast("DEFAULT CONFIGURATION RESTORED");
  });

  ui.sound.addEventListener("click", () => {
    settings.muted = !settings.muted;
    saveSettings();
    if (!settings.muted) audio.start();
    audio.apply(game.state !== "playing");
    showToast(settings.muted ? "AUDIO // MUTED" : "AUDIO // ONLINE");
  });

  function isModalOpen() {
    return !ui.settings.classList.contains("hidden") || !ui.how.classList.contains("hidden");
  }

  addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    if (["ArrowLeft", "ArrowRight", "Space"].includes(event.code)) event.preventDefault();
    if (event.code === "ArrowLeft" || event.code === "KeyA") game.input.left = true;
    if (event.code === "ArrowRight" || event.code === "KeyD") game.input.right = true;

    if (event.code === "Escape") {
      if (!ui.settings.classList.contains("hidden")) closeSettings();
      else if (!ui.how.classList.contains("hidden")) ui.how.classList.add("hidden");
      else if (game.state === "playing") pauseGame();
      else if (game.state === "paused") resumeGame();
    }
    if (event.code === "KeyP" && !isModalOpen()) {
      if (game.state === "playing") pauseGame(); else if (game.state === "paused") resumeGame();
    }
    if ((event.code === "Enter" || event.code === "Space") && !event.repeat && !isModalOpen()) {
      if (game.state === "menu" || game.state === "over") startRun();
    }
  });

  addEventListener("keyup", (event) => {
    if (event.code === "ArrowLeft" || event.code === "KeyA") game.input.left = false;
    if (event.code === "ArrowRight" || event.code === "KeyD") game.input.right = false;
  });

  let pointerActive = false;
  function updateTouch(event) {
    const rect = canvas.getBoundingClientRect();
    const normalized = ((event.clientX - rect.left) / rect.width - .5) * 2;
    game.input.touch = clamp(normalized * 1.35, -1, 1);
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (game.state !== "playing") return;
    pointerActive = true;
    canvas.setPointerCapture(event.pointerId);
    updateTouch(event);
  });
  canvas.addEventListener("pointermove", (event) => { if (pointerActive) updateTouch(event); });
  canvas.addEventListener("pointerup", () => { pointerActive = false; game.input.touch = 0; });
  canvas.addEventListener("pointercancel", () => { pointerActive = false; game.input.touch = 0; });

  addEventListener("blur", () => { if (game.state === "playing") pauseGame(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && game.state === "playing") pauseGame(); });

  syncBest();
  updateSettingsUI();
  createWorld(true);
  const intro = sampleTrack(segmentAt(0), 0);
  Object.assign(game.player, { x: intro.x, y: intro.y + BALL_RADIUS, z: 0 });
  requestAnimationFrame(frame);
})();
