import { chance, rand, TAU } from "./utils.js?v=20261046-1";

/**
 * Drabiny.
 *
 * Czasem ktoś utknie u podnóża zbyt wysokiej skarpy: skacze, ale nie potrafi
 * się wdrapać. Wtedy idzie do drzewa, ścina je, a z drewna wiąże drabinę.
 * Im wyższa skarpa, tym więcej drzew i dłuższa drabina. Gotowej drabiny mogą
 * potem używać inni ludzie, którzy utknęli w tym samym miejscu.
 */
export class Ladders {
  constructor(game) {
    this.game = game;
    this.map = game.map;
    this.water = game.water;
    this.vegetation = game.vegetation;
    this.population = game.population;
    this.config = game.config.ladders || {};
    this.ladders = [];
    this.sites = [];
    this.byWall = new Map();
    this._nextId = 1;
    this.time = 0;
    this.totalBuilt = 0;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get woodPerTree() {
    return this.config.woodPerTree ?? 1;
  }

  get tilesPerLog() {
    return this.config.tilesPerLog ?? 2;
  }

  get chopSeconds() {
    return this.config.chopSeconds ?? 2.2;
  }

  get buildSeconds() {
    return this.config.buildSeconds ?? 3.2;
  }

  get minTreeHeight() {
    return this.config.minTreeHeight ?? 38;
  }

  get maxHeightTiles() {
    return this.config.maxHeightTiles ?? 10;
  }

  get maxSites() {
    return this.config.maxSites ?? 3;
  }

  get maxLadders() {
    return this.config.maxLadders ?? 80;
  }

  update(dt) {
    this.time += dt;
    // Drabiny płoną jak drzewa: zapalają się blisko ognia i wypalają.
    this._updateLadderFire(dt);
  }

  /**
   * Próbuje wyposażyć osobę w drabinę (albo skorzystać z już stojącej).
   * `climb` to opis ściany: kierunek, kolumna i różnica wysokości.
   */
  tryStart(person, climb) {
    if (!this.enabled || !person || !person.alive) return false;
    if (person.ladderBuild || person.homeBuild || person._climb) return false;

    const plan = this.planFromClimb(person, climb);
    if (!plan) return false;

    // 1. Istniejąca drabina. Może jej użyć każdy — także dziecko, osoba
    //    w panice i w nocy — i w obie strony (w górę lub w dół).
    const existing = this.findLadder(plan);
    if (existing) {
      this.startClimb(person, existing);
      return true;
    }

    // 2. Nowa drabina. W nocy tylko zejście (powrót do domu), dorośli,
    //    bez paniki. Samo użycie gotowej drabiny nie podlega tym limitom.
    if (person.isNight && !climb?.descent) return false;
    if (person.panicTimer > 0) return false;
    if (person.ageYears < (this.config.minAge ?? 12)) return false;

    // Ktoś już buduje drabinę pod tą samą ścianą — nie stawiajcie drugiej.
    if (this.findSite(plan) || this.findPlanned(plan, person)) {
      person._trapCooldown = Math.min(
        this.config.retrySeconds ?? 6,
        2.5
      );
      return false;
    }

    if (this.sites.length >= this.maxSites) return false;

    person.ladderBuild = plan;
    if (!this.assignTree(person, plan)) {
      // Wokół skarpy nie ma ani jednego drzewa na tym samym poziomie.
      // W takiej sytuacji drabina powstaje z gałęzi i korzeni: wolniej,
      // ale zawsze. Inaczej osoba uwięziona pod urwiskiem nie zbuduje
      // jej nigdy i będzie w kółko próbować podskoków.
      plan.gather = true;
      if (!this.beginSite(person)) {
        person.ladderBuild = null;
        return false;
      }
    }
    return true;
  }

  /**
   * Awaryjne rozpoczęcie placu budowy bez drewna z drzewa. Używane, gdy
   * w zasięgu nie ma już żadnego drzewa na tym samym poziomie.
   */
  beginGather(person, plan) {
    if (!plan) return false;
    plan.treeId = null;
    plan.gather = true;
    return this.beginSite(person);
  }

  /** Sprawdza, czy ściana nadal jest na tyle wysoka, by potrzebna była drabina. */
  planFromClimb(person, climb) {
    if (climb && climb.descent) {
      const ts = this.map.tileSize;
      const dir = climb.dir >= 0 ? 1 : -1;
      const footRow = Math.round(person.y / ts);
      const wallTx = climb.wallTx;
      if (wallTx == null || wallTx < 2 || wallTx >= this.map.width - 2) return null;
      const topTx = wallTx - dir;
      if (topTx < 1 || topTx >= this.map.width - 1) return null;
      const topRow = this.map.surfaceRow(topTx);
      const bottomRow = this.map.surfaceRow(wallTx);
      const heightTiles = bottomRow - topRow;
      if (heightTiles < 2 || heightTiles > this.maxHeightTiles) return null;
      const lowTx = wallTx;
      if (Math.abs(topTx - Math.floor(person.x / ts)) > 2) return null;
      const baseY = topRow * ts;
      const targetY = bottomRow * ts;
      const x = dir > 0 ? wallTx * ts - 2 : (wallTx + 1) * ts + 2;
      return {
        dir,
        wallTx,
        highTx: topTx,
        topRow,
        footRow: bottomRow,
        heightTiles,
        x,
        topX: (wallTx + 0.5) * ts,
        baseY,
        topY: targetY,
        wood: 0,
        woodRequired: this.woodForHeight(heightTiles),
        treeId: null,
        siteId: null,
        startedAt: this.time,
        descent: true,
      };
    }
    if (!climb || climb.dir == null) return null;
    const ts = this.map.tileSize;
    const dir = climb.dir >= 0 ? 1 : -1;
    const footRow = Math.round(person.y / ts);
    const wallTx = climb.wallTx;
    if (wallTx == null || wallTx < 1 || wallTx >= this.map.width - 1) {
      return null;
    }

    const topRow = this.map.surfaceRow(wallTx);
    const heightTiles = footRow - topRow;
    if (heightTiles < 2 || heightTiles > this.maxHeightTiles) return null;

    const lowTx = wallTx - dir;
    if (Math.abs(lowTx - Math.floor(person.x / ts)) > 2) return null;
    const lowRow = this.map.surfaceRow(lowTx);
    if (Math.abs(lowRow - footRow) > 1) return null;

    const x = dir > 0 ? wallTx * ts - 2 : (wallTx + 1) * ts + 2;
    return {
      dir,
      wallTx,
      highTx: wallTx,
      topRow,
      footRow,
      heightTiles,
      x,
      topX: (wallTx + 0.5) * ts,
      baseY: footRow * ts,
      topY: topRow * ts,
      wood: 0,
      woodRequired: this.woodForHeight(heightTiles),
      treeId: null,
      siteId: null,
      startedAt: this.time,
    };
  }

  woodForHeight(heightTiles) {
    return Math.max(1, Math.ceil(heightTiles / this.tilesPerLog));
  }

  /** Drabina stojąca przy tej samej ścianie (z tolerancją jednego kafelka). */
  findLadder(plan) {
    const ts = this.map.tileSize;
    const highTx = plan.highTx ?? plan.wallTx;
    for (const ladder of this.ladders) {
      if (ladder.burning) continue;
      // Drabina zbudowana w jedną stronę służy też do przejścia w drugą,
      // więc nie porównujemy flagi `descent` — liczy się ta sama ściana.
      const ladderHigh = ladder.highTx ?? ladder.wallTx;
      if (Math.abs(ladderHigh - highTx) > 1) continue;
      if (Math.abs(ladder.topRow - plan.topRow) > 1) continue;
      if (Math.abs((ladder.heightTiles ?? 0) - plan.heightTiles) > 1) continue;
      if (Math.abs(ladder.x - plan.x) > ts * 2.5) continue;
      return ladder;
    }
    return null;
  }

  /** Plac budowy przy tej samej ścianie. */
  findSite(plan) {
    const ts = this.map.tileSize;
    const highTx = plan.highTx ?? plan.wallTx;
    for (const site of this.sites) {
      const siteHigh = site.highTx ?? site.wallTx;
      if (Math.abs(siteHigh - highTx) > 1) continue;
      if (Math.abs(site.topRow - plan.topRow) > 1) continue;
      if (Math.abs((site.heightTiles ?? 0) - plan.heightTiles) > 1) continue;
      if (Math.abs(site.baseY - plan.baseY) > ts * 1.5 &&
          Math.abs(site.topY - plan.topY) > ts * 1.5) continue;
      return site;
    }
    return null;
  }

  /** Ktoś inny już planuje drabinę pod tą samą ścianą (jeszcze nie ma placu). */
  findPlanned(plan, person) {
    const ts = this.map.tileSize;
    const highTx = plan.highTx ?? plan.wallTx;
    for (const other of this.population.people) {
      if (other === person || !other.alive) continue;
      const build = other.ladderBuild;
      if (!build) continue;
      const buildHigh = build.highTx ?? build.wallTx;
      if (Math.abs(buildHigh - highTx) > 1) continue;
      if (Math.abs(build.topRow - plan.topRow) > 1) continue;
      if (Math.abs((build.heightTiles ?? 0) - plan.heightTiles) > 1) continue;
      return build;
    }
    return null;
  }

  /** Najbliższe drzewo na tym samym poziomie, do którego da się dojść pieszo. */
  assignTree(person, plan) {
    const tree = this._findTree(person);
    if (!tree) return false;

    tree.reservedBy = person.id;
    plan.treeId = tree.id;
    person._chopTimer = 0;
    person.state = "ladderChop";
    person.stateTimer = 0;
    person.targetX = tree.x;
    person.partnerTarget = null;
    return true;
  }

  _findTree(person) {
    const ts = this.map.tileSize;
    const radius = (this.config.treeSearchTiles ?? 32) * ts;
    let best = null;
    let bestDist = Infinity;

    for (const tree of this.vegetation.trees) {
      if (tree.felled || tree.falling || tree.burning) continue;
      if (tree.reservedBy != null) continue;
      if ((tree.growth ?? 1) < 0.35) continue;
      const height =
        tree.h * (0.18 + 0.82 * Math.min(1, tree.growth ?? 1));
      if (height < this.minTreeHeight) continue;
      const dist = Math.abs(tree.x - person.x);
      if (dist > radius || dist >= bestDist) continue;
      if (!this._walkableSameLevel(person, tree.x)) continue;
      best = tree;
      bestDist = dist;
    }
    return best;
  }

  /** Czy między osobą a celem teren nie wymaga wspinaczki (różnica do 1 kafelka). */
  _walkableSameLevel(person, targetX) {
    const ts = this.map.tileSize;
    const fromTx = Math.floor(person.x / ts);
    const toTx = Math.floor(targetX / ts);
    const step = Math.sign(toTx - fromTx) || 1;
    let prev = this.map.surfaceRow(fromTx);
    if (fromTx === toTx) return this.water.columnInfo(toTx).depth <= ts * 0.4;

    for (let tx = fromTx + step; ; tx += step) {
      if (tx < 1 || tx >= this.map.width - 1) return false;
      const row = this.map.surfaceRow(tx);
      if (Math.abs(row - prev) > 1) return false;
      if (this.water.columnInfo(tx).depth > ts * 0.4) return false;
      prev = row;
      if (tx === toTx) break;
    }
    return true;
  }

  /** Wznawia przerwaną (np. nocą) pracę nad drabiną. */
  resume(person) {
    const plan = person.ladderBuild;
    if (!plan || person.isNight) return false;

    if (plan.siteId != null) {
      const site = this.getSite(plan.siteId);
      if (site) {
        person.state = "ladderBuild";
        person.targetX = site.x;
        return true;
      }
      plan.siteId = null;
    }

    // Plac budowy bez drewna z drzewa (gałęzie) wznawiamy od razu.
    if (plan.gather) return this.beginSite(person);

    if (plan.wood >= plan.woodRequired) {
      return this.beginSite(person);
    }

    if (plan.treeId != null) {
      const tree = this.vegetation.getTree(plan.treeId);
      if (tree && !tree.felled && !tree.falling && !tree.burning) {
        person._chopTimer = 0;
        person.state = "ladderChop";
        person.targetX = tree.x;
        return true;
      }
      plan.treeId = null;
    }

    if (this.assignTree(person, plan)) return true;
    // Drzewa się skończyły — dokańczamy z gałęzi, zamiast porzucać projekt.
    return this.beginGather(person, plan);
  }

  /** Budowniczy zanosi drewno pod skarpę i zaczyna wiązać drabinę. */
  beginSite(person) {
    const plan = person.ladderBuild;
    if (!plan) return false;

    const site = {
      id: this._nextId++,
      x: plan.x,
      baseY: plan.baseY,
      topY: plan.topY,
      topX: plan.topX,
      topRow: plan.topRow,
      wallTx: plan.wallTx,
      highTx: plan.highTx ?? plan.wallTx,
      dir: plan.dir,
      heightTiles: plan.heightTiles,
      progress: 0,
      wood: plan.wood,
      seed: rand(0, 1000),
      descent: !!plan.descent,
      gather: !!plan.gather,
    };
    this.sites.push(site);
    plan.siteId = site.id;
    person._needsLadder = false;
    person.state = "ladderBuild";
    person.targetX = site.x;
    person.partnerTarget = null;

    this.game.effects.burst(site.x, site.baseY - 2, "#9a7640", 10, {
      speed: 22,
      life: 0.8,
      size: 1.8,
      gravity: 120,
    });
    return true;
  }

  completeSite(site, person) {
    const index = this.sites.indexOf(site);
    if (index >= 0) this.sites.splice(index, 1);
    if (!person || !person.alive) return null;

    const ladder = {
      id: this._nextId++,
      x: site.x,
      baseY: site.baseY,
      topY: site.topY,
      topX: site.topX,
      topRow: site.topRow,
      wallTx: site.wallTx,
      highTx: site.highTx ?? site.wallTx,
      dir: site.dir,
      heightTiles: site.heightTiles,
      seed: site.seed,
      descent: !!site.descent,
      gather: !!site.gather,
      builtDay: this.game.day,
      burning: false,
    };
    this.ladders.push(ladder);
    this.byWall.set(`${ladder.wallTx}:${ladder.topRow}`, ladder);
    this.totalBuilt++;
    if (this.ladders.length > this.maxLadders) {
      const removed = this.ladders.shift();
      if (removed) this.byWall.delete(`${removed.wallTx}:${removed.topRow}`);
    }

    this.game.effects.burst(site.x, site.baseY - site.heightTiles * 6, "#c9a46b", 12, {
      speed: 28,
      life: 0.9,
      size: 1.8,
      gravity: 90,
    });

    this.game.ui.toast(
      site.gather
        ? `<strong>${person.name}</strong> spina drabinę z gałęzi pod skarpą.`
        : site.descent
          ? `<strong>${person.name}</strong> spuszcza drabinę w dół skarpy.`
          : `<strong>${person.name}</strong> stawia drabinę pod zbyt wysoką skarpą.`,
      ""
    );

    this.startClimb(person, ladder);
    return ladder;
  }

  /** Wciąga osobę po drabinie na drugi koniec — w górę albo w dół. */
  startClimb(person, ladder) {
    if (!person || !person.alive || !ladder) return false;
    const ts = this.map.tileSize;
    // Drabina ma dwa końce. Idziemy zawsze na ten, przy którym osoby nie ma,
    // dzięki czemu ta sama drabina służy do wejścia i do zejścia.
    const nearBase =
      Math.abs(person.y - ladder.baseY) <= Math.abs(person.y - ladder.topY);
    const toBase = !nearBase;
    const toX = toBase ? ladder.x : ladder.topX;
    const toY = toBase ? ladder.baseY : ladder.topY;
    const tiles = Math.max(2, Math.abs(ladder.baseY - ladder.topY) / ts);
    person._climb = {
      t: 0,
      duration: Math.max(0.6, 0.45 + tiles * 0.13),
      fromX: person.x,
      fromY: person.y,
      toX,
      toY,
      ladderId: ladder.id,
    };
    person.ladderBuild = null;
    person._needsLadder = false;
    person.state = "climb";
    person.stateTimer = 0;
    person.targetX = null;
    person.partnerTarget = null;
    person.moveDir = 0;
    person.vx = 0;
    person.vy = 0;
    person.sleepIndoors = false;
    person.facing = toX >= person.x ? 1 : -1;
    person._chopTimer = 0;
    return true;
  }

  getSite(id) {
    return this.sites.find((site) => site.id === id) || null;
  }

  /** Przerywa pracę: zwalnia drzewo i usuwa plac budowy. */
  cancelProject(person, options = {}) {
    const plan = person.ladderBuild;
    if (!plan) return;
    if (plan.treeId != null) {
      const tree = this.vegetation.getTree(plan.treeId);
      if (tree && tree.reservedBy === person.id) tree.reservedBy = null;
    }
    if (plan.siteId != null) this._removeSite(plan.siteId);
    person.ladderBuild = null;
    person._chopTimer = 0;
    if (person.state === "ladderChop" || person.state === "ladderBuild") {
      person.state = "idle";
      person.stateTimer = rand(0.6, 1.8);
      person.targetX = null;
      person.moveDir = 0;
    }
    if (!options.silent) {
      person._trapCooldown = options.cooldown ?? this.config.retrySeconds ?? 6;
    }
  }

  /** Śmierć lub zniknięcie osoby: zwalnia jej drzewo i plac budowy. */
  release(person) {
    if (person.ladderBuild) this.cancelProject(person, { silent: true });
    person._climb = null;
  }

  /** Ladder fire handling: ignited when within range of burning trees (or buildings). */
  _igniteLadder(ladder) {
    if (!ladder || ladder.burning) return false;
    ladder.burning = true;
    ladder.burnTimer = 0;
    ladder.burnDuration = rand(2.4, 4.8);
    ladder.firePhase = rand(0, TAU);
    this.game.effects?.burst?.(ladder.x, ladder.baseY, Math.random() < 0.5 ? "#ffb347" : "#ff6a2a", 14, {
      speed: 24,
      life: 0.8,
      size: 1.9,
      gravity: -40,
      type: "flame",
      spread: TAU,
    });
    return true;
  }

  _updateLadderFire(dt) {
    const ts = this.map.tileSize;
    const radius = (this.config.woodPerTree || 1) * ts * 0 ? 0 : ts * 2.2;
    // effective radius from a burning source (tree, etc.)
    const burnSourceRadius = ts * 2.4;
    const burningTrees = this.vegetation?.trees?.filter((t) => t.burning) || [];
    // nearby crop fires? ignore for now; trees only.

    for (let i = this.ladders.length - 1; i >= 0; i--) {
      const ladder = this.ladders[i];
      if (!ladder) continue;
      if (!ladder.burning) {
        let nearFire = false;
        for (const t of burningTrees) {
          if (Math.abs(t.x - ladder.x) <= burnSourceRadius && Math.abs(t.y - ladder.baseY) <= ts * 4.2) {
            nearFire = true;
            break;
          }
        }
        if (nearFire) this._igniteLadder(ladder);
        // If not ignited, skip; otherwise fall through to tick.
        if (!ladder.burning) continue;
      }

      ladder.burnTimer += dt;
      ladder.firePhase = (ladder.firePhase || 0) + dt * 0.6;
      if (ladder.burnTimer >= ladder.burnDuration) {
        // burn out -> remove from use
        for (const person of this.population.people) {
          if (person._climb && person._climb.ladderId === ladder.id) {
            person._climb = null;
            person.state = "idle";
            person.stateTimer = rand(0.5, 1.5);
            person.targetX = null;
            person._needsLadder = false;
          }
        }
        this.game.effects?.burst?.(ladder.x, ladder.baseY, "#5b4a3e", 12, {
          speed: 16, life: 1.6, size: 3, gravity: -25, type: "smoke", spread: TAU,
        });
        this.byWall.delete(`${ladder.wallTx}:${ladder.topRow}`);
        this.ladders.splice(i, 1);
      }
    }
  }

  _removeSite(siteId) {
    const index = this.sites.findIndex((site) => site.id === siteId);
    if (index < 0) return;
    const site = this.sites[index];
    this.sites.splice(index, 1);
    this.game.effects.burst(site.x, site.baseY - 2, "#8a7c68", 6, {
      speed: 16,
      life: 0.7,
      size: 1.5,
      gravity: 100,
    });
  }
}
