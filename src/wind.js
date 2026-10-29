import { chance, choice, clamp, rand } from "./utils.js?v=20261046-1";

/**
 * Wiatr: podmuch ma środek, promień, czas życia i siłę 1–3.
 * Co klatkę szarpie drzewami, łamie zboże, napiera na ludzi i — gdy jest
 * dość silny — zrywa dachy oraz zwiewa całe chaty. Lekki wiaterek potrafi
 * też okazyjnie zerwać komuś ubranie.
 */
export class WindSystem {
  constructor(game) {
    this.game = game;
    this.config = game.config.wind || {};
    this.gusts = [];
    this._toastCooldown = 0;
  }

  get active() {
    return this.gusts.length > 0;
  }

  spawn(worldX, groundY, power, level = 1) {
    const ts = this.game.map.tileSize;
    const radiusScale = 1 + (level - 1) * (power.radiusPerStrength ?? 0.34);
    const durationScale = 1 + (level - 1) * (power.durationPerStrength ?? 0.28);
    const gust = {
      x: worldX,
      y: groundY,
      radius: power.radius * ts * radiusScale,
      duration: power.duration * durationScale,
      life: power.duration * durationScale,
      strength: level,
      dir: chance(0.5) ? 1 : -1,
      seed: rand(0, 1000),
      age: 0,
      intensity: 0,
      emitTimer: 0,
    };
    this.gusts.push(gust);
    return gust;
  }

  /** Najsilniejszy podmuch w danym punkcie (0..1) — używane przez renderer. */
  intensityAt(x, y = null) {
    let value = 0;
    for (const gust of this.gusts) {
      if (Math.abs(gust.x - x) > gust.radius) continue;
      if (y != null && Math.abs(gust.y - y) > this.game.map.tileSize * 3) continue;
      value = Math.max(value, gust.intensity);
    }
    return value;
  }

  update(dt) {
    this._toastCooldown = Math.max(0, this._toastCooldown - dt);
    const ts = this.game.map.tileSize;

    for (let i = this.gusts.length - 1; i >= 0; i--) {
      const gust = this.gusts[i];
      gust.age += dt;
      gust.life -= dt;
      gust.intensity = clamp(
        Math.min(gust.age / 0.35, gust.life / 1.1),
        0,
        1
      );
      if (gust.life <= 0) {
        this.gusts.splice(i, 1);
        continue;
      }

      const strength = gust.strength;
      const intensity = gust.intensity;

      // Liście i pył niesione przez podmuch.
      gust.emitTimer -= dt;
      if (gust.emitTimer <= 0) {
        const leafRate =
          (this.config.leafRate ?? 14) * (0.7 + strength * 0.35);
        gust.emitTimer = rand(0.7, 1.25) / leafRate;
        this._emit(gust);
      }

      // Ludzie: wiatr napiera, a silny podmuch potrafi ich przestraszyć.
      for (const person of this.game.population?.people || []) {
        if (!person.alive) continue;
        const dx = person.x - gust.x;
        if (Math.abs(dx) > gust.radius * 0.95) continue;
        if (person.y < gust.y - ts * 6 || person.y > gust.y + ts * 1.5) continue;
        if (person.sleepIndoors) continue;

        const falloff = 1 - Math.abs(dx) / Math.max(1, gust.radius);
        person.windPush = clamp(
          person.windPush +
            gust.dir *
              (this.config.pushPerStrength ?? 17) *
              3 *
              strength *
              intensity *
              (0.35 + falloff * 0.65) *
              dt,
          -90,
          90
        );

        if (
          strength >= 2 &&
          person.state !== "shame" &&
          person.state !== "reclothe" &&
          person.state !== "drown" &&
          person.state !== "sleep" &&
          person.panicTimer <= 0 &&
          chance(dt * (this.config.panicChancePerSecond ?? 0.12) * (strength - 1) * intensity)
        ) {
          person.panicTimer = rand(2.5, 5.5);
        }

        this._maybeStrip(person, gust, dt);
      }

      this.game.vegetation?.windAt(
        gust.x,
        gust.y,
        gust.radius,
        strength,
        dt * intensity,
        gust.dir
      );
      this.game.crops?.windAt(
        gust.x,
        gust.y,
        gust.radius,
        strength,
        dt * intensity,
        gust.dir
      );
      this.game.housing?.windAt(
        gust.x,
        gust.y,
        gust.radius,
        strength,
        dt * intensity,
        gust.dir
      );
    }
  }

  /** Lekki wiaterek może zerwać ubranie; silny robi to nieco częściej. */
  _maybeStrip(person, gust, dt) {
    if (person.stripped || person.stripCooldown > 0) return;
    if (person.ageYears < (this.config.stripMinAge ?? 16)) return;
    if (person.sleepIndoors || person.inWater) return;
    if (
      person.state === "sleep" ||
      person.state === "drown" ||
      person.state === "climb" ||
      person.state === "shame" ||
      person.state === "reclothe"
    ) {
      return;
    }

    const rate =
      (this.config.stripChancePerSecond ?? 0.012) *
      (0.9 + 0.3 * (gust.strength - 1)) *
      gust.intensity;
    if (!chance(rate * dt)) return;
    if (!person.stripClothes(this.game)) return;

    if (this._toastCooldown <= 0) {
      this._toastCooldown = 6;
      const word = person.sex === "f" ? "Zawstydzona" : "Zawstydzony";
      this.game.ui.toast(
        `Wiatr zrywa ubranie z <strong>${person.name}</strong>. ${word} ucieka do domu.`,
        "rain"
      );
    }
  }

  _emit(gust) {
    const palette = this.game.config.theme.tree?.leaf || ["#6f9a44", "#8fae5a"];
    const count = 1 + Math.floor(gust.strength * 0.7);
    for (let i = 0; i < count; i++) {
      const x = gust.x + rand(-gust.radius * 0.85, gust.radius * 0.85);
      const y = gust.y - rand(4, 70);
      this.game.effects.burst(x, y, choice(palette), 1, {
        speed: 62 + gust.strength * 26,
        life: rand(0.8, 1.5),
        size: rand(1.3, 2.4),
        gravity: 18,
        drag: 0.992,
        angle: gust.dir > 0 ? 0 : Math.PI,
        spread: 0.42,
        type: "leaf",
      });
    }
    if (chance(0.3)) {
      const x = gust.x + rand(-gust.radius * 0.9, gust.radius * 0.9);
      this.game.effects.burst(x, gust.y - rand(2, 26), "#cbb894", 1, {
        speed: 40 + gust.strength * 18,
        life: rand(0.5, 1),
        size: rand(1, 2),
        gravity: 4,
        drag: 0.99,
        angle: gust.dir > 0 ? 0 : Math.PI,
        spread: 0.5,
        type: "dot",
      });
    }
  }
}
