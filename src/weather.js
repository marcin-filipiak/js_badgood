import { rand, clamp } from "./utils.js?v=20261046-1";

export class RainCloud {
  constructor(game, x, groundY, power) {
    this.game = game;
    this.x = x;
    this.groundY = groundY;
    const waterCfg = game.config.water || {};
    this.radius = (power.radius || 8) * game.map.tileSize;
    this.duration = power.duration || 16;
    this.life = this.duration;
    // Poziom siły deszczu zmienia ilość wody i to, czy robi szkody.
    // Domyślnie 3, żeby bezpośrednie wywołania (testy, stare zapisy)
    // zachowywały dawną, niszczycielską ulewę.
    this.strength = clamp(Math.round(power.strength ?? 3), 1, 3);
    const volumeScale =
      waterCfg.rainVolumePerStrength?.[this.strength - 1] ?? 1;
    this.volumePerSecond =
      (waterCfg.rainVolumePerSecond ?? 0.34) * volumeScale;
    this.damage =
      waterCfg.rainDamagePerStrength?.[this.strength - 1] ??
      (this.strength > 1 ? this.strength - 1 : 0);
    this.y = Math.max(60, groundY - 340);
    this.seed = rand(0, 1000);
    this.drift = rand(-5, 5);
    this.intensity = 0;
    this.done = false;
    this.flash = 0;
  }

  get active() {
    return this.life > 0;
  }

  update(dt) {
    this.life -= dt;
    this.flash = Math.max(0, this.flash - dt);
    const progress = 1 - this.life / this.duration;
    const fadeIn = clamp(progress / 0.12, 0, 1);
    const fadeOut = clamp(this.life / 1.8, 0, 1);
    this.intensity = Math.min(fadeIn, fadeOut);

    this.x += this.drift * dt;
    if (this.life > 0.15) {
      this.game.water.addRain(
        this.x,
        this.radius,
        this.volumePerSecond * this.intensity,
        dt
      );
      // Lekki deszcz nawilża glebę i wspomaga wzrost, nie topiąc pól.
      this.game.crops?.rainAt(
        this.x,
        this.radius,
        this.intensity,
        dt,
        this.strength
      );
    }
    if (this.life <= 0) this.done = true;
  }

  containsX(x) {
    return Math.abs(x - this.x) <= this.radius * 1.05;
  }
}

export class Weather {
  constructor(game) {
    this.game = game;
    this.clouds = [];
    this.rainIntensity = 0;
    this.flash = 0;
  }

  spawnRain(worldX, groundY, power) {
    const cloud = new RainCloud(this.game, worldX, groundY, power);
    cloud.flash = 1;
    this.clouds.push(cloud);
    return cloud;
  }

  update(dt) {
    for (const cloud of this.clouds) cloud.update(dt);
    this.clouds = this.clouds.filter((c) => !c.done);
    this.rainIntensity = 0;
    for (const cloud of this.clouds) {
      this.rainIntensity = Math.max(this.rainIntensity, cloud.intensity);
    }
    this.flash = Math.max(0, this.flash - dt);
  }

  /** Największa intensywność deszczu nad danym punktem (0..1). */
  rainIntensityAt(x) {
    let intensity = 0;
    for (const cloud of this.clouds) {
      if (cloud.containsX(x)) intensity = Math.max(intensity, cloud.intensity);
    }
    return intensity;
  }

  /** Ile szkód wyrządza deszcz w danym punkcie (0 = tylko kałuże). */
  rainDamageAt(x) {
    let damage = 0;
    for (const cloud of this.clouds) {
      if (cloud.containsX(x)) {
        damage = Math.max(damage, cloud.intensity * (cloud.damage || 0));
      }
    }
    return damage;
  }

  isRainingAt(x) {
    return this.rainDamageAt(x) > 0.5;
  }

  /** Do delikatnego przyciemnienia nieba. */
  get cover() {
    if (!this.clouds.length) return 0;
    let v = 0;
    for (const c of this.clouds) {
      const weight = 0.55 + (c.strength || 1) * 0.15;
      v = Math.max(v, c.intensity * weight);
    }
    return v;
  }
}
