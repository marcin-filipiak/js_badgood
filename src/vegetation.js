import { rand, chance, clamp, hash2, choice, TAU } from "./utils.js?v=20261046-1";

/**
 * Drzewa są częścią symulacji, nie tylko dekoracją. Piorun podpala las,
 * ogień rozprzestrzenia się między koronami, a deszcz kiełkuje nowe sadzonki.
 */
export class Vegetation {
  constructor(game) {
    this.game = game;
    this.map = game.map;
    this.config = game.config.vegetation || {};
    this.theme = game.config.theme;
    this.trees = [];
    this.byId = new Map();
    this.stumps = [];
    this.nextId = 1;
    this.rainTimer = 0;
    this._buildInitial();
  }

  _buildInitial() {
    const map = this.map;
    const forestDensity = this.config.forestDensity ?? 0.72;
    const grassDensity = this.config.grassDensity ?? 0.028;

    for (let tx = 2; tx < map.width - 2; tx++) {
      const row = map.surfaceRow(tx);
      const ch = map.tileAt(tx, row);
      const forest = ch === "f";
      const grass = ch === "#";
      if (!forest && !grass) continue;
      const density = forest ? forestDensity : grassDensity;
      if (hash2(tx, 91, 5) > density) continue;
      this._addTree(this._makeTree(tx, row, 1, forest), false);
    }
    this.trees.sort((a, b) => a.y - b.y);
  }

  _makeTree(tx, row, growth, forest) {
    const ts = this.map.tileSize;
    const theme = this.theme;
    const type = forest && hash2(tx, 3, 8) < 0.55 ? "pine" : "leaf";
    const scale = forest ? rand(0.7, 1.25) : rand(0.5, 0.85);

    return {
      id: this.nextId++,
      tx,
      x: (tx + rand(0.2, 0.8)) * ts,
      y: row * ts + 1,
      h: (type === "pine" ? rand(52, 100) : rand(46, 86)) * scale,
      w: (type === "pine" ? rand(18, 30) : rand(22, 34)) * scale,
      type,
      phase: rand(0, TAU),
      hue: hash2(tx, 17, 2),
      canopy: forest ? choice(theme.tree.pine) : choice(theme.tree.leaf),
      lean: rand(-0.06, 0.06),
      growth: clamp(growth, 0.04, 1),
      flourish: 0,
      burning: false,
      burnTimer: 0,
      burnDuration: 0,
      firePhase: rand(0, TAU),
      emitTimer: 0,
      spreadTimer: 0,
      felled: false,
      falling: false,
      fallTimer: 0,
      fallDuration: 0,
      fallAngle: 0,
      fallDir: 1,
      gust: 0,
      gustDir: 1,
      reservedBy: null,
    };
  }

  _addTree(tree, sort = true) {
    this.trees.push(tree);
    this.byId.set(tree.id, tree);
    if (sort) this.trees.sort((a, b) => a.y - b.y);
  }

  getTree(id) {
    return this.byId.get(id) || null;
  }

  /** Najbliższe odpowiednio wysokie drzewo, którego nikt jeszcze nie ścina. */
  findFellableTree(worldX, maxDistance, minHeight) {
    let best = null;
    let bestScore = Infinity;
    for (const tree of this.trees) {
      if (tree.felled || tree.falling || tree.burning) continue;
      if (tree.reservedBy != null) continue;
      if ((tree.growth ?? 1) < 0.35) continue;
      const height = tree.h * (0.18 + 0.82 * clamp(tree.growth ?? 1, 0.04, 1));
      if (height < minHeight) continue;
      const d = Math.abs(tree.x - worldX);
      if (d > maxDistance) continue;
      const score = d + rand(0, this.map.tileSize * 6);
      if (score < bestScore) {
        bestScore = score;
        best = tree;
      }
    }
    return best;
  }

  /** Ścina drzewo: pień przewraca się, a po chwili zostaje tylko pniak. */
  fellTree(tree, direction = 1) {
    if (!tree || tree.felled || tree.burning) return false;
    tree.felled = true;
    tree.falling = true;
    tree.fallTimer = 0;
    tree.fallDuration = rand(0.7, 1.1);
    tree.fallDir = direction >= 0 ? 1 : -1;
    tree.fallAngle = 0;
    tree.reservedBy = null;
    return true;
  }

  /** Karczowanie placu pod fundament. Nie daje drewna, tylko usuwa drzewa. */
  clearTreesNear(worldX, radiusPx) {
    let cleared = 0;
    for (const tree of this.trees) {
      if (tree.felled || tree.falling || tree.burning) continue;
      if (Math.abs(tree.x - worldX) > radiusPx) continue;
      const dir = tree.x < worldX ? -1 : 1;
      if (this.fellTree(tree, dir)) cleared++;
      if (cleared >= 10) break;
    }
    return cleared;
  }

  get maxTrees() {
    return this.config.maxTrees ?? 420;
  }

  get saplingSeconds() {
    return this.config.saplingGrowthSeconds ?? 16;
  }

  /** Podpala drzewa w promieniu uderzenia. Zwraca liczbę nowych pożarów. */
  igniteAt(worldX, worldY, radiusPx = 0) {
    const ts = this.map.tileSize;
    const radius = Math.max(
      radiusPx * 1.7,
      (this.config.lightningIgniteRadius ?? 3.2) * ts
    );
    let count = 0;

    for (const tree of this.trees) {
      if (tree.burning || tree.felled) continue;
      if (Math.abs(tree.x - worldX) > radius) continue;
      if (Math.abs(tree.y - worldY) > ts * 4.2) continue;
      if (this._ignite(tree)) count++;
    }
    return count;
  }

  _ignite(tree) {
    if (tree.burning) return false;
    tree.burning = true;
    tree.burnTimer = 0;
    tree.burnDuration = rand(
      this.config.burnSecondsMin ?? 2.8,
      this.config.burnSecondsMax ?? 5.4
    );
    tree.firePhase = rand(0, TAU);
    tree.emitTimer = 0;
    tree.spreadTimer = rand(0.2, 0.5);
    return true;
  }

  update(dt) {
    this._updateGrowth(dt);
    this._updateFire(dt);
    this._updateRain(dt);
    this._updateFalling(dt);
  }

  _updateFalling(dt) {
    for (let i = this.trees.length - 1; i >= 0; i--) {
      const tree = this.trees[i];
      if (!tree.falling) continue;
      tree.fallTimer += dt;
      const total = Math.max(0.001, tree.fallDuration);
      const t = clamp(tree.fallTimer / total, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      tree.fallAngle = tree.fallDir * (Math.PI / 2) * eased;
      if (t < 1) continue;

      this.trees.splice(i, 1);
      this.byId.delete(tree.id);
      this.stumps.push({
        x: tree.x,
        y: tree.y,
        r: Math.max(2.4, tree.w * 0.14),
        h: Math.max(3, tree.w * 0.1),
        seed: tree.hue ?? 0,
      });
      if (this.stumps.length > 140) this.stumps.shift();
    }
  }

  _updateGrowth(dt) {
    const rate = dt / this.saplingSeconds;
    const decay = dt / (this.config.rainFlourishDecaySeconds ?? 30);
    const gustDecay = dt * 2.4;
    for (const tree of this.trees) {
      if (tree.burning || tree.felled) continue;
      if (tree.flourish > 0) tree.flourish = Math.max(0, tree.flourish - decay);
      if (tree.gust > 0) tree.gust = Math.max(0, tree.gust - gustDecay);
      if (tree.growth < 1) tree.growth = Math.min(1, tree.growth + rate);
    }
  }

  /**
   * Podmuch wiatru: drzewa się uginają, a przy silnym wichrze mogą runąć.
   * Zwraca liczbę przewróconych drzew.
   */
  windAt(worldX, worldY, radius, strength, dt, dir = 1) {
    const ts = this.map.tileSize;
    let fallen = 0;
    for (const tree of this.trees) {
      if (tree.felled || tree.falling || tree.burning) continue;
      const dx = tree.x - worldX;
      if (Math.abs(dx) > radius) continue;
      if (Math.abs(tree.y - worldY) > ts * 4.2) continue;

      const falloff = 1 - Math.abs(dx) / Math.max(1, radius);
      tree.gust = Math.min(
        1.3,
        (tree.gust || 0) + dt * (0.9 + strength * 1.1) * (0.45 + falloff * 0.55) * 2.2
      );
      tree.gustDir = dir;

      if (
        strength >= 2 &&
        chance(
          dt *
            (this.game.config.wind?.treeFallChancePerSecond ?? 0.02) *
            (strength - 1) *
            (0.4 + falloff * 0.6)
        )
      ) {
        if (this.fellTree(tree, dir)) {
          fallen++;
          this.game.effects.burst(tree.x, tree.y - tree.h * 0.35, "#6f9a44", 8, {
            speed: 32,
            life: 1.2,
            size: 1.8,
            gravity: 70,
            type: "leaf",
          });
        }
      }
    }
    return fallen;
  }

  _updateFire(dt) {
    for (let i = this.trees.length - 1; i >= 0; i--) {
      const tree = this.trees[i];
      if (!tree.burning) continue;

      tree.burnTimer += dt;
      tree.emitTimer -= dt;
      if (tree.emitTimer <= 0) {
        tree.emitTimer = rand(0.05, 0.13);
        this._emitFire(tree);
      }

      tree.spreadTimer -= dt;
      if (tree.spreadTimer <= 0) {
        tree.spreadTimer = rand(0.28, 0.55);
        this._spreadFire(tree);
      }

      if (tree.burnTimer >= tree.burnDuration) {
        this._burnOut(tree);
        this.trees.splice(i, 1);
      }
    }
  }

  _emitFire(tree) {
    const height = tree.h * (0.2 + 0.8 * tree.growth);
    const x = tree.x + rand(-tree.w * 0.45, tree.w * 0.45);
    const y = tree.y - rand(0.05, 0.95) * height;

    this.game.effects.burst(x, y, chance(0.5) ? "#ffb347" : "#ff6a2a", 1, {
      speed: 14,
      life: 0.65,
      size: 2.2,
      gravity: -45,
      type: "flame",
      spread: TAU,
    });
    if (chance(0.2)) {
      this.game.effects.burst(x, y, "#4c4038", 1, {
        speed: 8,
        life: 1.7,
        size: 3,
        gravity: -25,
        type: "smoke",
        spread: TAU,
      });
    }
  }

  _spreadFire(source) {
    const ts = this.map.tileSize;
    const radius = (this.config.fireSpreadRadius ?? 1.7) * ts;
    const spreadChance = this.config.fireSpreadChance ?? 0.24;

    for (const tree of this.trees) {
      if (tree === source || tree.burning || tree.felled) continue;
      if (Math.abs(tree.x - source.x) > radius) continue;
      if (Math.abs(tree.y - source.y) > ts * 2.2) continue;
      if (chance(spreadChance)) this._ignite(tree);
    }

    // Ogień z koron potrafi przeskoczyć na dach chaty.
    this.game.housing?.igniteAt(source.x, source.y, radius, {
      chance: this.game.config.housing?.treeIgniteChance ?? 0.08,
    });

    // Rozżarzone iskry padają też na pola uprawne.
    this.game.crops?.igniteAt(source.x, source.y, radius + ts, {
      chance: 0.22,
    });
  }

  _burnOut(tree) {
    this.byId.delete(tree.id);
    const height = tree.h * (0.2 + 0.8 * tree.growth);
    this.game.effects.burst(tree.x, tree.y - height * 0.3, "#ff9d3c", 18, {
      speed: 70,
      life: 0.9,
      size: 2.4,
      gravity: 140,
      type: "flame",
    });
    this.game.effects.burst(tree.x, tree.y - height * 0.2, "#5b4a3e", 12, {
      speed: 24,
      life: 1.8,
      size: 3.2,
      gravity: -30,
      type: "smoke",
    });
    this.game.effects.decals.push({
      x: tree.x,
      y: tree.y,
      w: tree.w * 2.2,
      h: tree.w * 0.7,
      rotation: rand(-0.2, 0.2),
      life: 20,
      maxLife: 20,
      type: "scorch",
    });
    if (this.game.effects.decals.length > 40) this.game.effects.decals.shift();
  }

  _updateRain(dt) {
    const clouds = this.game.weather?.clouds;
    if (!clouds || !clouds.length) return;

    this.rainTimer += dt;
    const interval = this.config.rainSproutInterval ?? 0.35;
    if (this.rainTimer < interval) return;
    const step = this.rainTimer;
    this.rainTimer = 0;

    for (const cloud of clouds) {
      if (cloud.intensity <= 0.12) continue;
      this._rainGrow(cloud, step);

      if (this.trees.length >= this.maxTrees) continue;
      const p = (this.config.rainSproutChancePerSecond ?? 1.1) * step * cloud.intensity;
      if (chance(Math.min(1, p))) this._sprout(cloud);
    }
  }

  _rainGrow(cloud, dt) {
    const boost = (this.config.rainGrowthMultiplier ?? 2.5) - 1;
    const flourishRate =
      (dt / (this.config.rainFlourishSeconds ?? 8)) * (cloud.intensity ?? 1);
    const rate = (dt / this.saplingSeconds) * boost;

    for (const tree of this.trees) {
      if (tree.burning || tree.felled) continue;
      if (Math.abs(tree.x - cloud.x) > cloud.radius) continue;
      tree.flourish = Math.min(1, tree.flourish + flourishRate);
      if (tree.growth < 1) tree.growth = Math.min(1, tree.growth + rate);
    }
  }

  _sprout(cloud) {
    const ts = this.map.tileSize;
    const radiusTiles = cloud.radius / ts;

    for (let attempt = 0; attempt < 10; attempt++) {
      const tx = Math.round(cloud.x / ts + rand(-radiusTiles, radiusTiles));
      if (tx < 2 || tx >= this.map.width - 2) continue;

      const row = this.map.surfaceRow(tx);
      const ch = this.map.tileAt(tx, row);
      if (ch !== "#" && ch !== "f") continue;

      const sameTile = this.trees.filter((t) => t.tx === tx && !t.felled);
      if (sameTile.length >= 2) continue;

      const tree = this._makeTree(tx, row, 0.06, ch === "f");
      if (sameTile.length > 0) {
        // Sadzonka wyrasta obok starego drzewa, nie dokładnie w nim.
        const center = (tx + 0.5) * ts;
        tree.x = sameTile[0].x < center ? center + ts * 0.32 : center - ts * 0.32;
      }
      this._addTree(tree);
      this.game.effects.burst(tree.x, tree.y - 3, "#9be28e", 7, {
        speed: 18,
        life: 1.1,
        size: 1.8,
        gravity: -18,
        type: "dot",
      });

      if (!cloud._vegetationNotified) {
        cloud._vegetationNotified = true;
        this.game.ui.toast("Ziemia pije deszcz. Drzewa zaczynają rosnąć.", "birth");
      }
      return tree;
    }
    return null;
  }
}
