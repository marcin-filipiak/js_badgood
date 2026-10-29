import { rand, chance, clamp, TAU } from "./utils.js?v=20261046-1";

export class Effects {
  constructor(game) {
    this.game = game;
    this.particles = [];
    this.bolts = [];
    this.decals = [];
    this.ripples = [];
  }

  burst(x, y, color, count = 10, opts = {}) {
    const {
      speed = 40,
      life = 1,
      size = 2,
      gravity = 120,
      spread = TAU,
      angle = 0,
      drag = 0.985,
      type = "dot",
    } = opts;
    for (let i = 0; i < count; i++) {
      const a = angle + rand(-spread / 2, spread / 2);
      const v = rand(speed * 0.25, speed);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        gravity,
        drag,
        life: rand(life * 0.5, life),
        maxLife: life,
        size: rand(size * 0.6, size * 1.5),
        color,
        type,
      });
    }
    this._limit();
  }

  drown(x, y, height) {
    const water = this.game.config.theme.water;
    this.burst(x, y, water.surface, 12, {
      speed: 22,
      life: 1.8,
      size: 2.2,
      gravity: -28,
      type: "bubble",
      spread: Math.PI * 2,
    });
    this.splash(x, y + height * 0.45, 8);
  }

  quake(x, y, radius, mode = "dig", level = 1) {
    const dust = this.game.config.theme.soil?.[1] || "#755233";
    this.burst(x, y - 2, dust, 32 + level * 9, {
      speed: 76 + level * 14,
      life: 1.25,
      size: 3.4,
      gravity: mode === "dig" ? 150 : -40,
      spread: TAU,
      type: "dot",
    });
    this.burst(x, y, "#5a4029", 22 + level * 4, {
      speed: 130 + level * 16,
      life: 0.85,
      size: 2.8,
      gravity: 360,
      spread: TAU,
      type: "dot",
    });
    if (mode === "fill") {
      this.burst(x, y - radius * 0.25, dust, 16 + level * 4, {
        speed: 40,
        life: 0.9,
        size: 2.6,
        gravity: -24,
        spread: TAU,
      });
    }
    this.ripples.push({
      x,
      y: y - 1,
      r: 0,
      maxR: radius * 1.5,
      life: 0.75,
      maxLife: 0.75,
      type: "shock",
      color: "196, 164, 118",
    });
    this._limit();
  }

  splash(x, y, count = 10) {
    const water = this.game.config.theme.water;
    this.burst(x, y, water.shallow, count, {
      speed: 55,
      life: 0.7,
      size: 1.6,
      gravity: 340,
      angle: -Math.PI / 2,
      spread: Math.PI * 1.1,
      type: "dot",
    });
  }

  lightning(x, y, radius, strength = 1) {
    const level = clamp(Math.round(strength), 1, 3);
    const startY = y - 900;
    const points = [];
    const startOffset = rand(-120, 120);
    const segments = 12 + level * 3;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const taper = 1 - t * 0.72;
      // Naprzemienne zygzaki dają wyraźny, złamany kształt pioruna.
      const zig = (i % 2 === 0 ? -1 : 1) * rand(6, 28) * taper;
      const tx = x + startOffset * (1 - t) + zig;
      const ty = startY + (y - startY) * t + rand(-7, 7) * taper;
      points.push({ x: tx, y: ty });
    }
    points[0] = { x: x + startOffset, y: startY };
    points[points.length - 1] = { x, y };

    const branches = [];
    for (let b = 0; b < 3 + level; b++) {
      const idx = Math.floor(rand(2, segments - 2));
      const origin = points[idx];
      const dir = (chance(0.5) ? -1 : 1) * rand(24, 90);
      branches.push([
        { x: origin.x, y: origin.y },
        { x: origin.x + dir * 0.45 + rand(-8, 8), y: origin.y + rand(28, 65) },
        { x: origin.x + dir + rand(-10, 10), y: origin.y + rand(80, 155) },
      ]);
    }

    this.bolts.push({ points, branches, x, y, radius, life: 0.55, maxLife: 0.55, seed: Math.random() });
    this.burst(x, y - 4, "#ffe8a8", 24 + level * 8, {
      speed: 150 + level * 22,
      life: 0.9,
      size: 2.4,
      gravity: 420,
      angle: -Math.PI / 2,
      spread: Math.PI,
      type: "spark",
    });
    this.burst(x, y - 10, "#ffffff", 8 + level * 3, {
      speed: 80,
      life: 0.5,
      size: 2,
      gravity: 100,
      type: "dot",
    });

    // Ślad wypalenia.
    this.decals.push({
      x,
      y,
      w: radius * 2.4,
      h: radius * 0.7,
      rotation: rand(-0.2, 0.2),
      life: 30,
      maxLife: 30,
      type: "scorch",
    });
    if (this.decals.length > 30) this.decals.shift();

    this.ripples.push({ x, y, r: 0, maxR: radius * 1.4, life: 0.6, maxLife: 0.6, type: "shock" });
  }

  update(dt) {
    const particles = this.particles;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      this.bolts[i].life -= dt;
      if (this.bolts[i].life <= 0) this.bolts.splice(i, 1);
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.life -= dt;
      if (d.life <= 0) this.decals.splice(i, 1);
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.life -= dt;
      r.r = (1 - r.life / r.maxLife) * r.maxR;
      if (r.life <= 0) this.ripples.splice(i, 1);
    }
  }

  _limit() {
    if (this.particles.length > 650) {
      this.particles.splice(0, this.particles.length - 650);
    }
  }
}
