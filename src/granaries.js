import { TAU, chance, clamp, rand } from "./utils.js?v=20261046-5";

/**
 * Spichlerze.
 *
 * Drewniane, bez okien, tylko z drzwiami — nieco większe od chaty i kryte
 * podobną słomą. Wieś stawia je, gdy zapasy ziarna przestają się mieścić
 * w tym, co już stoi. Buduje je zwykły dorosły: ścina drzewa, a potem
 * wznosi budynek na równym skrawku ziemi.
 *
 * Ziarno jest rozdzielane między spichlerze po kolei. Gdy któryś spłonie,
 * zostanie zmieciony przez powódź albo zwiany przez huragan, przepada też
 * ziarno, które było w nim zmagazynowane.
 */
export class Granaries {
  constructor(game) {
    this.game = game;
    this.map = game.map;
    this.water = game.water;
    this.vegetation = game.vegetation;
    this.config = game.config.granaries || {};
    this.population = game.population;
    this.granaries = [];
    this.sites = [];
    this.byId = new Map();
    this._nextId = 1;
    this._signalTimer = 0;
    this._announcedNeed = false;
    this.totalBuilt = 0;
    this.totalLost = 0;
    this.totalGrainLost = 0;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get maxGranaries() {
    return this.config.maxGranaries ?? 6;
  }

  get maxSites() {
    return this.config.maxConcurrentBuilds ?? 2;
  }

  get capacity() {
    return Math.max(1, this.config.capacity ?? 120);
  }

  /**
   * Ile ziarna wieś może w ogóle trzymać. Bez spichlerza obowiązuje norma
   * początkowa (próg pierwszego spichlerza). Z gotowymi spichlerzami limit
   * równa się ich łącznej pojemności — place budowy jeszcze nic nie dają.
   */
  get storageLimit() {
    const base = this.firstThreshold;
    if (this.granaries.length === 0) return base;
    return Math.max(base, this.totalCapacity);
  }

  get width() {
    return this.config.width ?? 58;
  }

  get wallHeight() {
    return this.config.wallHeight ?? 31;
  }

  get roofHeight() {
    return this.config.roofHeight ?? 18;
  }

  get woodRequired() {
    return this.config.woodRequired ?? 3;
  }

  get woodPerTree() {
    return this.config.woodPerTree ?? 1;
  }

  get chopSeconds() {
    return this.config.chopSeconds ?? 2.6;
  }

  get buildSeconds() {
    return this.config.buildSeconds ?? 6;
  }

  get rainWashSeconds() {
    return this.config.rainWashSeconds ?? 8;
  }

  get rainWashMinIntensity() {
    return this.config.rainWashMinIntensity ?? 0.5;
  }

  get floodWashDepthTiles() {
    return this.config.floodWashDepthTiles ?? 1.1;
  }

  get floodWashRate() {
    return this.config.floodWashRate ?? 1.6;
  }

  get crops() {
    return this.game.crops;
  }

  get food() {
    return this.crops?.food ?? 0;
  }

  /** Próg pierwszego spichlerza: zapasy o 30% większe niż na starcie. */
  get firstThreshold() {
    const start = this.game.config.crops?.foodStart ?? 60;
    return start * (this.config.firstGranaryFoodFactor ?? 1.3);
  }

  get totalCapacity() {
    return this.granaries.length * this.capacity;
  }

  /**
   * Ile spichlerzy jest już w drodze: place budowy plus projekty, w których
   * ktoś dopiero ścina drzewa. Bez tego kilku bezczynnych ludzi zaczynałoby
   * budowę naraz, zanim pierwszy plac w ogóle powstał.
   */
  get pendingBuilds() {
    let count = this.sites.length;
    for (const person of this.population?.people || []) {
      const project = person.granaryBuild;
      if (project && project.siteId == null) count++;
    }
    return count;
  }

  /** Ziarno faktycznie leżące w spichlerzach. */
  get storedGrain() {
    let total = 0;
    for (const granary of this.granaries) total += granary.grain || 0;
    return total;
  }

  getGranary(id) {
    return this.byId.get(id) || null;
  }

  getSite(id) {
    return this.sites.find((site) => site.id === id) || null;
  }

  /**
   * Czy wieś potrzebuje kolejnego spichlerza? Pierwszy pojawia się, gdy
   * ziarna jest o 30% więcej niż na starcie. Kolejne — gdy zapasy nie
   * mieszczą się już w istniejących spichlerzach i placach budowy.
   */
  needsGranary(food = this.food) {
    if (!this.enabled) return false;
    const pending = this.pendingBuilds;
    if (this.granaries.length + pending >= this.maxGranaries) {
      return false;
    }
    // Nie ma sensu stawiać spichlerza, gdy globalny limit zapasów i tak
    // jest już osiągnięty.
    if (food >= this.game.crops?.foodMax) return false;

    if (this.granaries.length === 0 && pending === 0) {
      return food >= this.firstThreshold;
    }
    // Kolejny spichlerz jest potrzebny dopiero wtedy, gdy istniejące
    // spichlerze są pełne. Jeden plac budowy w zupełności wystarczy.
    if (pending > 0) return false;
    return this.totalCapacity > 0 && food >= this.totalCapacity;
  }

  update(dt) {
    if (!this.enabled) return;
    this.time = (this.time || 0) + dt;
    this._updateFires(dt);
    this._updateWater(dt);
    this._updateWind(dt);
    this._recomputeStored();
    this._signalNeed(dt);
  }

  /** Rozdziela wiejskie ziarno po spichlerzach, od najstarszego. */
  _recomputeStored() {
    let remaining = Math.max(0, this.food);
    for (const granary of this.granaries) {
      const amount = Math.min(granary.capacity ?? this.capacity, remaining);
      granary.grain = amount;
      remaining -= amount;
    }
  }

  _signalNeed(dt) {
    this._signalTimer = Math.max(0, (this._signalTimer || 0) - dt);
    const needed = this.needsGranary();
    if (!needed) {
      this._announcedNeed = false;
      return;
    }
    if (this._announcedNeed || this._signalTimer > 0) return;
    this._announcedNeed = true;
    this._signalTimer = 4;
    const first = this.granaries.length === 0 && this.pendingBuilds === 0;
    this.game.ui.toast(
      first
        ? "Zapasy ziarna urosły ponad miarę. Wieś potrzebuje pierwszego spichlerza."
        : "Ziarno nie mieści się już w spichlerzach. Czas zbudować kolejny.",
      "birth"
    );
  }

  /** Czy dana osoba może zacząć budowę spichlerza? */
  canStartProject(person) {
    if (!this.enabled || !person.alive) return false;
    if (person.granaryBuild || person.homeBuild || person.ladderBuild) {
      return false;
    }
    if (person.buildCooldown > 0) return false;
    if (person.isNight) return false;
    if (
      person.state === "flee" ||
      person.state === "drown" ||
      person.state === "sleep"
    ) {
      return false;
    }
    if (person.panicTimer > 0) return false;
    if (person.ageYears < (person.config.fertileAge ?? 16)) return false;
    if (this.pendingBuilds >= this.maxSites) return false;
    if (!this.needsGranary()) return false;
    return true;
  }

  tryStartProject(person) {
    if (!this.canStartProject(person)) return false;
    if (!chance(this.config.buildChancePerIdle ?? 0.5)) return false;

    const project = {
      wood: 0,
      treeId: null,
      siteId: null,
      kind: "granary",
      startedAt: this.time || 0,
    };
    person.granaryBuild = project;

    if (!this.assignTree(person, project)) {
      person.granaryBuild = null;
      person.buildCooldown = this.config.buildCooldownSeconds ?? 10;
      return false;
    }
    return true;
  }

  /** Przydziela budowniczemu najbliższe odpowiednio wysokie drzewo. */
  assignTree(person, project) {
    const tree = this.vegetation.findFellableTree(
      person.x,
      (this.config.treeSearchTiles ?? 36) * this.map.tileSize,
      this.config.minTreeHeight ?? 44
    );
    if (!tree) return false;

    tree.reservedBy = person.id;
    project.treeId = tree.id;
    person._chopTimer = 0;
    person.state = "chop";
    person.stateTimer = 0;
    person.targetX = tree.x;
    person.partnerTarget = null;
    return true;
  }

  /** Wznawia przerwaną (np. nocą) budowę spichlerza. */
  resumeProject(person) {
    const project = person.granaryBuild;
    if (!project) return false;

    if (project.siteId != null) {
      const site = this.getSite(project.siteId);
      if (site) {
        person.state = "build";
        person.targetX = site.x;
        return true;
      }
      project.siteId = null;
    }

    if (project.wood >= this.woodRequired) {
      return this.beginSite(person);
    }

    if (project.treeId != null) {
      const tree = this.vegetation.getTree(project.treeId);
      if (tree && !tree.felled && !tree.burning && !tree.stump) {
        person._chopTimer = 0;
        person.state = "chop";
        person.targetX = tree.x;
        return true;
      }
      project.treeId = null;
    }

    if (this.assignTree(person, project)) return true;
    this.cancelProject(person);
    return false;
  }

  /** Wybiera równy, suchy skrawek ziemi z dala od innych budynków. */
  beginSite(person) {
    const project = person.granaryBuild;
    if (!project) return false;
    const spot = this._chooseSite(person.x);
    if (!spot) return false;

    const site = {
      id: this._nextId++,
      kind: "granary",
      x: spot.x,
      y: spot.y,
      tx: spot.tx,
      progress: 0,
      wood: project.wood,
      builderId: person.id,
      w: this.width,
      wallH: this.wallHeight,
      roofH: this.roofHeight,
      seed: rand(0, 1000),
      state: "building",
    };
    this.sites.push(site);
    project.siteId = site.id;
    person.state = "build";
    person.targetX = site.x;
    person.partnerTarget = null;

    // Fundament trzeba wykarczować: drzewa na placu padają.
    this.vegetation.clearTreesNear(site.x, site.w * 0.72);
    this.game.effects.burst(site.x, site.y - 3, "#9a7640", 12, {
      speed: 24,
      life: 0.9,
      size: 1.8,
      gravity: 120,
    });
    return true;
  }

  completeSite(site, builder) {
    const index = this.sites.indexOf(site);
    if (index >= 0) this.sites.splice(index, 1);
    if (!builder || !builder.alive) return null;

    const granary = {
      id: this._nextId++,
      kind: "granary",
      x: site.x,
      y: site.y,
      w: site.w,
      wallH: site.wallH,
      roofH: site.roofH,
      seed: site.seed,
      capacity: this.capacity,
      grain: 0,
      washMax: this.rainWashSeconds,
      builtDay: this.game.day,
    };
    this.granaries.push(granary);
    this.byId.set(granary.id, granary);
    this.totalBuilt++;

    if (builder.granaryBuild) builder.granaryBuild = null;
    builder.buildCooldown = this.config.buildCooldownSeconds ?? 10;
    builder.state = "idle";
    builder.stateTimer = rand(0.5, 1.4);
    builder.targetX = null;
    builder.moveDir = 0;
    builder.vx = 0;

    this._recomputeStored();

    this.game.effects.burst(site.x, site.y - site.wallH * 0.5, "#e8d7ab", 24, {
      speed: 36,
      life: 1.2,
      size: 2.1,
      gravity: 80,
    });
    this.game.effects.burst(site.x, site.y, "#8a7c68", 14, {
      speed: 20,
      life: 1.4,
      size: 2,
      gravity: 40,
    });
    this.game.ui.toast(
      `W wiosce staje spichlerz. Pomieści ${this.capacity} ziarna.`,
      "birth"
    );
    this.game.audio?.birth?.();
    return granary;
  }

  /** Przerywa budowę: zwalnia drzewo i usuwa plac budowy. */
  cancelProject(person, options = {}) {
    const project = person.granaryBuild;
    if (!project) return;
    if (project.treeId != null) {
      const tree = this.vegetation.getTree(project.treeId);
      if (tree && tree.reservedBy === person.id) tree.reservedBy = null;
    }
    if (project.siteId != null) this._removeSite(project.siteId);
    person.granaryBuild = null;
    person._chopTimer = 0;
    if (person.state === "chop" || person.state === "build") {
      person.state = "idle";
      person.stateTimer = rand(0.6, 1.8);
      person.targetX = null;
      person.moveDir = 0;
    }
    if (!options.silent) {
      person.buildCooldown =
        options.cooldown ?? this.config.buildCooldownSeconds ?? 10;
    }
  }

  /** Śmierć lub zniknięcie osoby: zwalnia jej projekt i drzewo. */
  release(person) {
    if (person.granaryBuild) {
      this.cancelProject(person, { silent: true });
    }
  }

  /** Podpala spichlerze w okolicy: od pioruna albo ognia z lasu. */
  igniteAt(worldX, worldY, radiusPx = 0, options = {}) {
    const ts = this.map.tileSize;
    const chancePerBuilding = options.chance ?? 1;
    let count = 0;

    for (const granary of this.granaries) {
      if (granary.burning || granary.destroyed) continue;
      const radius = Math.max(radiusPx, granary.w * 0.7);
      if (Math.abs(granary.x - worldX) > radius) continue;
      if (Math.abs(granary.y - worldY) > ts * 4.5) continue;
      if (chancePerBuilding < 1 && !chance(chancePerBuilding)) continue;
      if (this.igniteGranary(granary, options)) count++;
    }
    return count;
  }

  igniteGranary(granary, options = {}) {
    if (!granary || granary.burning || granary.destroyed) return false;
    granary.burning = true;
    granary.burnTimer = 0;
    granary.burnDuration = rand(
      this.config.burnSecondsMin ?? 5,
      this.config.burnSecondsMax ?? 8
    );
    granary.firePhase = rand(0, TAU);
    granary.emitTimer = 0;
    granary.spreadTimer = rand(0.6, 1.2);

    this._emitIgnition(granary);
    this.game.ui.toast("Ogień ogarnia spichlerz.", "fire");
    this.game.audio?.fire?.();
    return true;
  }

  /**
   * Wiatr napiera na spichlerze. Dach może zostać zerwany, a przy huraganie
   * cały budynek obraca się w rumowisko.
   */
  windAt(x, y, radius, strength, dt, dir = 1) {
    if (!this.enabled) return 0;
    const ts = this.map.tileSize;
    const cfg = this.game.config.wind || {};
    const damage =
      this.config.windDamagePerSecond ?? cfg.houseDamagePerSecond ?? 0.11;
    const roofTearAt =
      this.config.windRoofTearAt ?? cfg.houseRoofTearAt ?? 0.55;
    let hit = 0;

    for (const granary of [...this.granaries]) {
      if (granary.burning || granary.destroyed) continue;
      const dx = granary.x - x;
      if (Math.abs(dx) > radius + granary.w * 0.5) continue;
      if (Math.abs(granary.y - y) > ts * 3) continue;

      const falloff = 1 - Math.min(1, Math.abs(dx) / Math.max(1, radius));
      const pressure = damage * Math.max(0, strength - 1) * (0.55 + falloff * 0.45);
      granary.windStress = (granary.windStress || 0) + dt * pressure;
      granary.windLeanDir = dir;
      hit++;

      if (!granary.roofTorn && granary.windStress >= roofTearAt) {
        granary.roofTorn = true;
        const wallH = granary.wallH ?? this.wallHeight;
        const roofH = granary.roofH ?? this.roofHeight;
        this.game.effects.burst(
          granary.x + rand(-granary.w * 0.3, granary.w * 0.3),
          granary.y - wallH - roofH * 0.5,
          "#8a5a34",
          16,
          { speed: 52, life: 1.2, size: 2.4, gravity: 90, type: "leaf" }
        );
        this.game.effects.burst(
          granary.x,
          granary.y - wallH - roofH * 0.4,
          "#cbb894",
          10,
          { speed: 26, life: 1.3, size: 2.2, gravity: 20, type: "smoke" }
        );
        this.game.ui.toast("Wiatr zrywa dach ze spichlerza.", "rain");
      }

      if (granary.windStress >= 1) this._destroy(granary, "wind");
    }
    return hit;
  }

  _updateWind(dt) {
    const cfg = this.game.config.wind || {};
    const decay =
      (this.config.windDamageDecay ?? cfg.houseDamageDecay ?? 0.06) * dt;
    for (const granary of this.granaries) {
      if (!granary.windStress) continue;
      granary.windStress = Math.max(0, granary.windStress - decay);
    }
  }

  _updateFires(dt) {
    const ts = this.map.tileSize;
    for (const granary of [...this.granaries]) {
      if (!granary.burning) continue;

      granary.burnTimer += dt;
      granary.emitTimer = (granary.emitTimer || 0) - dt;
      if (granary.emitTimer <= 0) {
        granary.emitTimer = rand(0.05, 0.13);
        this._emitFire(granary);
      }

      granary.spreadTimer = (granary.spreadTimer || 0) - dt;
      if (granary.spreadTimer <= 0) {
        granary.spreadTimer = rand(0.5, 1);
        const radius =
          (this.config.fireSpreadRadiusTiles ?? 5.5) * ts;
        const spreadChance = this.config.fireSpreadChance ?? 0.06;
        this.igniteAt(granary.x, granary.y, radius, {
          chance: spreadChance,
        });
        this.game.housing?.igniteAt(granary.x, granary.y, radius, {
          chance: spreadChance,
        });
      }

      if (granary.burnTimer >= granary.burnDuration) {
        this._destroy(granary, "fire");
      }
    }
  }

  /**
   * Woda niszczy spichlerz tak samo jak chatę: ulewa go podmywa, a głęboka
   * powódź robi to szybciej.
   */
  _updateWater(dt) {
    const weather = this.game.weather;
    const ts = this.map.tileSize;
    const decay = this.config.rainWashDecay ?? 1.2;
    const minFloodDepth = this.floodWashDepthTiles * ts;

    for (const granary of [...this.granaries]) {
      if (granary.burning || granary.destroyed) continue;

      const intensity = weather ? weather.rainDamageAt(granary.x) : 0;
      const raining = intensity >= this.rainWashMinIntensity;
      const depth = this._buildingWaterDepth(granary);
      const flooding = depth >= minFloodDepth;

      if (raining || flooding) {
        const overflow = flooding
          ? clamp((depth - minFloodDepth) / ts, 0, 1)
          : 0;
        const floodRate = flooding ? this.floodWashRate + overflow : 0;
        const rate = Math.max(raining ? intensity : 0, floodRate);
        const cause = flooding ? "flood" : "rain";

        granary.wash = Math.min(
          this.rainWashSeconds,
          (granary.wash || 0) + dt * rate
        );
        granary.washCause = cause;

        granary.splashTimer = (granary.splashTimer || 0) - dt;
        if (granary.splashTimer <= 0) {
          granary.splashTimer = rand(0.08, 0.16);
          const wallH = granary.wallH ?? this.wallHeight;
          const rx = granary.x + rand(-granary.w * 0.6, granary.w * 0.6);
          const ry = flooding
            ? granary.y - Math.min(depth, wallH) * rand(0.2, 0.9)
            : granary.y - rand(wallH * 0.2, wallH);
          this.game.effects.burst(
            rx,
            ry,
            flooding ? "#8fc3cf" : "#a9c9d6",
            flooding ? 2 : 1,
            {
              speed: flooding ? 26 : 18,
              life: 0.5,
              size: 1.6,
              gravity: 240,
              spread: TAU,
            }
          );
        }

        if (granary.wash >= this.rainWashSeconds) {
          this._destroy(granary, cause);
        }
      } else if (granary.wash > 0) {
        granary.wash = Math.max(0, granary.wash - dt * decay);
      }
    }
  }

  /** Najgłębsza woda pod spichlerzem (w pikselach). */
  _buildingWaterDepth(granary) {
    const ts = this.map.tileSize;
    const center = Math.floor(granary.x / ts);
    const baseY = this.water.columnInfo(center).groundY;
    const half = Math.max(1, Math.floor((granary.w ?? this.width) / ts / 2));
    let depth = 0;
    for (let tx = center - half; tx <= center + half; tx++) {
      const info = this.water.columnInfo(tx);
      if (Math.abs(info.groundY - baseY) > ts * 0.5) continue;
      depth = Math.max(depth, info.depth);
    }
    return depth;
  }

  _emitIgnition(granary) {
    const wallH = granary.wallH ?? this.wallHeight;
    const roofH = granary.roofH ?? this.roofHeight;
    this.game.effects.burst(
      granary.x,
      granary.y - wallH - roofH * 0.35,
      "#ff9d3c",
      22,
      { speed: 46, life: 0.9, size: 2.5, gravity: 90, type: "flame" }
    );
    this.game.effects.burst(
      granary.x,
      granary.y - wallH * 0.6,
      "#5b4a3e",
      10,
      { speed: 22, life: 1.8, size: 3.2, gravity: -28, type: "smoke" }
    );
  }

  _emitFire(granary) {
    const wallH = granary.wallH ?? this.wallHeight;
    const roofH = granary.roofH ?? this.roofHeight;
    const h = wallH + roofH;
    const x = granary.x + rand(-granary.w * 0.55, granary.w * 0.55);
    const y = granary.y - rand(0.1, 0.95) * h;

    this.game.effects.burst(x, y, chance(0.5) ? "#ffb347" : "#ff6a2a", 1, {
      speed: 12,
      life: 0.6,
      size: 2.2,
      gravity: -50,
      type: "flame",
      spread: TAU,
    });
    if (chance(0.22)) {
      this.game.effects.burst(x, y, "#4c4038", 1, {
        speed: 7,
        life: 1.8,
        size: 3,
        gravity: -24,
        type: "smoke",
        spread: TAU,
      });
    }
  }

  /** Usuwa spichlerz ze świata; zmagazynowane ziarno przepada. */
  _destroy(granary, cause = "fire") {
    if (granary.destroyed) return;
    granary.destroyed = true;
    granary.burning = false;

    const index = this.granaries.indexOf(granary);
    if (index >= 0) this.granaries.splice(index, 1);
    this.byId.delete(granary.id);
    this.totalLost = (this.totalLost || 0) + 1;

    const lost = Math.round(granary.grain || 0);
    if (lost > 0) {
      this.crops.food = Math.max(0, (this.crops.food || 0) - lost);
      this.totalGrainLost += lost;
      granary.grain = 0;
    }
    this._recomputeStored();
    const lostText = lost > 0 ? ` Przepadło ${lost} ziarna.` : "";

    const wallH = granary.wallH ?? this.wallHeight;
    if (cause === "rain" || cause === "flood") {
      this.game.effects.burst(
        granary.x,
        granary.y - wallH * 0.4,
        "#9dbfcb",
        28,
        { speed: 46, life: 1.1, size: 2.3, gravity: 180 }
      );
      this.game.effects.burst(
        granary.x,
        granary.y - 2,
        "#6f5a41",
        16,
        { speed: 28, life: 1.4, size: 2.2, gravity: 130 }
      );
      this.game.audio?.splash?.();
      this.game.ui.toast(
        (cause === "flood"
          ? "Powódź zmywa spichlerz."
          : "Ulewa zmywa spichlerz.") + lostText,
        "rain"
      );
    } else if (cause === "wind") {
      this.game.effects.burst(
        granary.x,
        granary.y - wallH * 0.45,
        "#8a5a34",
        26,
        { speed: 64, life: 1.1, size: 2.4, gravity: 140, type: "leaf" }
      );
      this.game.effects.burst(
        granary.x,
        granary.y - wallH * 0.4,
        "#cbb894",
        20,
        { speed: 34, life: 1.8, size: 3, gravity: -12, type: "smoke" }
      );
      this.game.audio?.windBurst?.(3);
      this.game.ui.toast(`Huragan zwiewa spichlerz.${lostText}`, "death");
    } else {
      this.game.effects.burst(
        granary.x,
        granary.y - wallH * 0.35,
        "#ff9d3c",
        24,
        { speed: 62, life: 0.95, size: 2.5, gravity: 120, type: "flame" }
      );
      this.game.effects.burst(
        granary.x,
        granary.y - wallH * 0.5,
        "#5b4a3e",
        16,
        { speed: 24, life: 1.9, size: 3.1, gravity: -30, type: "smoke" }
      );
      this.game.audio?.fire?.();
      this.game.ui.toast(
        `Spichlerz obraca się w zgliszcza.${lostText}`,
        "death"
      );
    }

    this._addRuinDecal(granary, cause);
  }

  _addRuinDecal(granary, cause) {
    const decals = this.game.effects.decals;
    decals.push({
      x: granary.x,
      y: granary.y,
      w: granary.w * 2,
      h: granary.w * 0.8,
      rotation: rand(-0.18, 0.18),
      life: 30,
      maxLife: 30,
      type:
        cause === "wind"
          ? "dust"
          : cause === "rain" || cause === "flood"
            ? "mud"
            : "scorch",
    });
    if (decals.length > 60) decals.shift();
  }

  _chooseSite(originX) {
    const ts = this.map.tileSize;
    const radius = Math.max(6, this.config.siteSearchTiles ?? 26);
    const spacing = (this.config.minSiteSpacingTiles ?? 6) * ts;
    const w = this.width;
    const minTx = Math.ceil((w * 0.7) / ts) + 2;
    const maxTx = this.map.width - minTx - 1;
    let best = null;
    let bestScore = -Infinity;

    for (let attempt = 0; attempt < 48; attempt++) {
      const tx = Math.round(originX / ts + rand(-radius, radius));
      if (tx < minTx || tx > maxTx) continue;
      const x = (tx + 0.5) * ts;
      if (this._nearStructure(x, spacing)) continue;

      const info = this.water.columnInfo(tx);
      if (info.depth > ts * 0.18) continue;

      const row = this.map.surfaceRow(tx);
      const left = this.map.surfaceRow(tx - 2);
      const right = this.map.surfaceRow(tx + 2);
      const spread = Math.max(row, left, right) - Math.min(row, left, right);
      if (spread > 2) continue;

      const score = rand(0, 1) - Math.abs(tx - originX / ts) * 0.004;
      if (score > bestScore) {
        bestScore = score;
        best = { tx, x, y: row * ts };
      }
    }
    return best;
  }

  _nearStructure(x, spacing) {
    const housing = this.game.housing;
    for (const house of housing?.houses || []) {
      if (Math.abs(house.x - x) < spacing) return true;
    }
    for (const site of housing?.sites || []) {
      if (Math.abs(site.x - x) < spacing) return true;
    }
    for (const granary of this.granaries) {
      if (Math.abs(granary.x - x) < spacing) return true;
    }
    for (const site of this.sites) {
      if (Math.abs(site.x - x) < spacing) return true;
    }
    for (const plot of this.game.crops?.plots || []) {
      if (Math.abs(plot.x - x) < spacing * 0.8) return true;
    }
    return false;
  }

  _removeSite(siteId) {
    const index = this.sites.findIndex((site) => site.id === siteId);
    if (index < 0) return;
    const site = this.sites[index];
    this.sites.splice(index, 1);
    this.game.effects.burst(site.x, site.y - 2, "#8a7c68", 8, {
      speed: 18,
      life: 0.8,
      size: 1.6,
      gravity: 80,
    });
  }
}
