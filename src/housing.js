import { TAU, chance, clamp, distance, rand } from "./utils.js?v=20261046-1";

/**
 * Domy i rodziny.
 *
 * Bezdomny dorosły, który ma dość sił, wybiera się do lasu po drewno.
 * Ścina tylko drzewa wystarczająco wysokie, a gdy uzbiera potrzebną ilość,
 * wybiera losowe, równe miejsce i stawia na nim chatę. Gotowy dom dostaje
 * rodzinę: budowniczego, jego partnera, dzieci i kilku najbliższych
 * bezdomnych sąsiadów. Ludzie z domem nocą wracają do środka, o ile nie
 * zapuścili się zbyt daleko.
 */
export class Housing {
  constructor(game) {
    this.game = game;
    this.map = game.map;
    this.water = game.water;
    this.vegetation = game.vegetation;
    this.config = game.config.housing || {};
    this.population = game.population;
    this.houses = [];
    this.sites = [];
    this.byId = new Map();
    this._nextId = 1;
    this._scanTimer = 0;
    this.totalBuilt = 0;
    this.totalLost = 0;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get maxHouses() {
    return this.config.maxHouses ?? 20;
  }

  get maxSites() {
    return this.config.maxConcurrentBuilds ?? 4;
  }

  get maxResidents() {
    return this.config.maxResidents ?? 6;
  }

  get woodRequired() {
    return this.config.woodRequired ?? 2;
  }

  get woodPerTree() {
    return this.config.woodPerTree ?? 1;
  }

  get chopSeconds() {
    return this.config.chopSeconds ?? 2.4;
  }

  get buildSeconds() {
    return this.config.buildSeconds ?? 4.5;
  }

  get rainWashSeconds() {
    return this.config.rainWashSeconds ?? 9;
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

  getHouse(id) {
    return this.byId.get(id) || null;
  }

  getSite(id) {
    const site = this.sites.find((s) => s.id === id);
    return site || null;
  }

  /** Wywoływane z pętli gry; porządkuje rodziny i mieszkania. */
  update(dt) {
    if (!this.enabled) return;
    this.time = (this.time || 0) + dt;
    this._updateFires(dt);
    this._updateWater(dt);
    this._updateWind(dt);
    this._scanTimer -= dt;
    if (this._scanTimer > 0) return;
    this._scanTimer = 1.2;
    this._pruneHouses();
    this._pairHomeless();
  }

  /** Czy dana osoba może w ogóle zacząć budowę? */
  canStartProject(person) {
    if (!this.enabled || !person.alive) return false;
    if (person.homeId != null || person.homeBuild) return false;
    if (person.buildCooldown > 0) return false;
    if (person.isNight) return false;
    if (person.state === "flee" || person.state === "drown" || person.state === "sleep") {
      return false;
    }
    if (person.panicTimer > 0) return false;
    if (person.ageYears < (person.config.fertileAge ?? 16)) return false;
    if (this.houses.length >= this.maxHouses) return false;
    if (this.sites.length >= this.maxSites) return false;

    const partner = this._partnerOf(person);
    if (partner) {
      // Jeśli partner już ma dom i jest w nim miejsce, nie ma po co
      // stawiać drugiego. Przepełniona chata nie blokuje nowej budowy.
      if (partner.homeId != null) {
        const house = this.getHouse(partner.homeId);
        if (house && house.residents.size < this.maxResidents) return false;
      }
    }
    return true;
  }

  /** Losuje osobę do roli budowniczego i przydziela jej pierwsze drzewo. */
  tryStartProject(person) {
    if (!this.canStartProject(person)) return false;

    // Jedna chata na parę: przy równoczesnym budowaniu wygrywa niższe id.
    const partner = this._partnerOf(person);
    if (partner && !partner.homeId) {
      if (partner.homeBuild) return false;
      if (partner.id < person.id) return false;
    }

    if (!chance(this.config.buildChancePerIdle ?? 0.4)) return false;

    const project = {
      wood: 0,
      treeId: null,
      siteId: null,
      startedAt: this.time || 0,
    };
    person.homeBuild = project;

    if (!this.assignTree(person, project)) {
      person.homeBuild = null;
      person.buildCooldown = this.config.buildCooldownSeconds ?? 10;
      return false;
    }
    return true;
  }

  /** Przydziela budowniczemu najbliższe odpowiednio wysokie drzewo. */
  assignTree(person, project) {
    const tree = this.vegetation.findFellableTree(
      person.x,
      (this.config.treeSearchTiles ?? 32) * this.map.tileSize,
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

  /** Wznawia przerwaną (np. nocą) budowę. */
  resumeProject(person) {
    const project = person.homeBuild;
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

  /** Wybiera losowy, równy skrawek ziemi i stawia tam plac budowy. */
  beginSite(person) {
    const project = person.homeBuild;
    if (!project) return false;
    const spot = this._chooseSite(person.x);
    if (!spot) return false;

    const site = {
      id: this._nextId++,
      x: spot.x,
      y: spot.y,
      tx: spot.tx,
      progress: 0,
      wood: project.wood,
      builderId: person.id,
      w: this.config.width ?? 46,
      wallH: this.config.wallHeight ?? 27,
      roofH: this.config.roofHeight ?? 16,
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

    const house = {
      id: this._nextId++,
      x: site.x,
      y: site.y,
      w: site.w,
      wallH: site.wallH,
      roofH: site.roofH,
      seed: site.seed,
      familyName: builder.name,
      residents: new Set(),
      builtDay: this.game.day,
    };
    this.houses.push(house);
    this.byId.set(house.id, house);
    this.totalBuilt++;

    if (builder.homeBuild) builder.homeBuild = null;
    builder.buildCooldown = this.config.buildCooldownSeconds ?? 10;
    builder.state = "idle";
    builder.stateTimer = rand(0.5, 1.4);
    builder.targetX = null;
    builder.moveDir = 0;
    builder.vx = 0;

    this._assignFamily(house, builder);

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
      `W dolinie staje dom rodziny <strong>${builder.name}</strong>.`,
      "birth"
    );
    this.game.audio?.birth?.();
    return house;
  }

  /** Dopisuje osobę do domu, jeśli jest miejsce. */
  moveIn(person, houseId) {
    const house = this.getHouse(houseId);
    if (!house || house.burning || house.destroyed) return false;
    if (house.wash >= this.rainWashSeconds * 0.7) return false;
    if (!person || !person.alive) return false;
    if (person.homeId === house.id) {
      house.residents.add(person.id);
      return true;
    }
    if (house.residents.size >= this.maxResidents) return false;
    if (person.homeId != null) {
      const old = this.getHouse(person.homeId);
      if (old) old.residents.delete(person.id);
    }
    if (person.homeBuild) this.cancelProject(person);
    person.homeId = house.id;
    house.residents.add(person.id);
    return true;
  }

  addResident(person, houseId) {
    return this.moveIn(person, houseId);
  }

  /** Przerywa budowę: zwalnia drzewo i usuwa plac budowy. */
  cancelProject(person, options = {}) {
    const project = person.homeBuild;
    if (!project) return;
    if (project.treeId != null) {
      const tree = this.vegetation.getTree(project.treeId);
      if (tree && tree.reservedBy === person.id) tree.reservedBy = null;
    }
    if (project.siteId != null) this._removeSite(project.siteId);
    person.homeBuild = null;
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

  /** Śmierć lub zniknięcie osoby: zwalnia jej projekt i dom. */
  release(person) {
    if (person.homeBuild) this.cancelProject(person, { silent: true });
    if (person.homeId != null) {
      const house = this.getHouse(person.homeId);
      if (house) house.residents.delete(person.id);
    }
  }

  /**
   * Podpala domy w okolicy: od pioruna, ognia z lasu albo płonącej chaty.
   * Zwraca liczbę nowych pożarów.
   */
  igniteAt(worldX, worldY, radiusPx = 0, options = {}) {
    const ts = this.map.tileSize;
    const chancePerHouse = options.chance ?? 1;
    let count = 0;

    for (const house of this.houses) {
      if (house.burning || house.destroyed) continue;
      const radius = Math.max(radiusPx, house.w * 0.7);
      if (Math.abs(house.x - worldX) > radius) continue;
      if (Math.abs(house.y - worldY) > ts * 4.5) continue;
      if (chancePerHouse < 1 && !chance(chancePerHouse)) continue;
      if (this.igniteHouse(house, options)) count++;
    }
    return count;
  }

  /**
   * Zajmuje dom ogniem; mieszkańcy w panice wybiegają na zewnątrz.
   * `options.sheltered` zbiera id osób, które uszły z płonącej chaty.
   */
  igniteHouse(house, options = {}) {
    if (!house || house.burning || house.destroyed) return false;
    house.burning = true;
    house.burnTimer = 0;
    house.burnDuration = rand(
      this.config.houseBurnSecondsMin ?? 4.5,
      this.config.houseBurnSecondsMax ?? 7.5
    );
    house.firePhase = rand(0, TAU);
    house.emitTimer = 0;
    house.spreadTimer = rand(0.6, 1.2);

    const hadResidents = house.residents.size > 0;
    this._evacuate(house, "fire", options.sheltered);
    this._emitIgnition(house);

    this.game.ui.toast(
      hadResidents
        ? `Ogień ogarnia dom rodziny <strong>${house.familyName}</strong>. Mieszkańcy uciekają.`
        : `Dom rodziny <strong>${house.familyName}</strong> staje w płomieniach.`,
      "fire"
    );
    this.game.audio?.fire?.();
    return true;
  }

  /**
   * Wyprowadza mieszkańców na zewnątrz. Osoby, które były w środku, budzą się
   * i uciekają w panice, a dom przestaje być ich domem.
   */
  _evacuate(house, cause = "fire", sheltered = null) {
    const ts = this.map.tileSize;
    const residents = [...house.residents];
    house.residents.clear();

    for (const id of residents) {
      const person = this.population.byId.get(id);
      if (!person || !person.alive) continue;

      const inside =
        person.sleepIndoors ||
        Math.abs(person.x - house.x) < house.w * 0.75;
      if (person.homeId === house.id) person.homeId = null;
      if (!inside) {
        // Kto był daleko, traci dach nad głową, ale nie teleportuje się do chaty.
        if (person.state === "home") {
          person.state = "idle";
          person.stateTimer = rand(0.6, 1.6);
          person.targetX = null;
          person.moveDir = 0;
        }
        continue;
      }
      if (sheltered) sheltered.add(person.id);

      let dir = person.x < house.x ? -1 : 1;
      let outX = house.x + dir * (house.w * 0.6 + rand(2, 10));
      if (this.water.columnInfo(Math.floor(outX / ts)).depth > ts * 0.45) {
        dir = -dir;
        outX = house.x + dir * (house.w * 0.6 + rand(2, 10));
      }

      person.x = outX;
      person.sleepIndoors = false;
      person.state = "flee";
      person.stateTimer = rand(3, 6);
      person.panicTimer = Math.max(
        person.panicTimer || 0,
        cause === "rain" ? rand(3, 6) : rand(4, 8)
      );
      person.targetX = outX + dir * ts * rand(3, 6);
      person.partnerTarget = null;
      person.moveDir = dir;
      person.facing = dir;
      person._chopTimer = 0;
    }
  }

  /**
   * Wiatr napiera na chaty. Dach może zostać zerwany, a przy huraganie
   * cały dom obraca się w rumowisko. Nacisk powoli opada po ustaniu wichru.
   */
  windAt(x, y, radius, strength, dt, dir = 1) {
    if (!this.enabled) return 0;
    const ts = this.map.tileSize;
    const cfg = this.game.config.wind || {};
    let hit = 0;
    for (const house of [...this.houses]) {
      if (house.burning || house.destroyed) continue;
      const dx = house.x - x;
      if (Math.abs(dx) > radius + house.w * 0.5) continue;
      if (Math.abs(house.y - y) > ts * 3) continue;

      const falloff = 1 - Math.min(1, Math.abs(dx) / Math.max(1, radius));
      const pressure =
        (cfg.houseDamagePerSecond ?? 0.11) *
        Math.max(0, strength - 1) *
        (0.55 + falloff * 0.45);
      house.windStress = (house.windStress || 0) + dt * pressure;
      house.windLeanDir = dir;
      hit++;

      if (!house.roofTorn && house.windStress >= (cfg.houseRoofTearAt ?? 0.55)) {
        house.roofTorn = true;
        const wallH = house.wallH ?? 27;
        const roofH = house.roofH ?? 16;
        this.game.effects.burst(
          house.x + rand(-house.w * 0.3, house.w * 0.3),
          house.y - wallH - roofH * 0.5,
          "#8a5a34",
          16,
          { speed: 52, life: 1.2, size: 2.4, gravity: 90, type: "leaf" }
        );
        this.game.effects.burst(
          house.x,
          house.y - wallH - roofH * 0.4,
          "#cbb894",
          10,
          { speed: 26, life: 1.3, size: 2.2, gravity: 20, type: "smoke" }
        );
        this.game.ui.toast(
          `Wiatr zrywa dach z domu rodziny <strong>${house.familyName}</strong>.`,
          "rain"
        );
      }

      if (house.windStress >= 1) {
        this._destroy(house, "wind");
      }
    }
    return hit;
  }

  _updateWind(dt) {
    const decay = (this.game.config.wind?.houseDamageDecay ?? 0.06) * dt;
    for (const house of this.houses) {
      if (!house.windStress) continue;
      house.windStress = Math.max(0, house.windStress - decay);
    }
  }

  _updateFires(dt) {    const ts = this.map.tileSize;
    for (const house of [...this.houses]) {
      if (!house.burning) continue;

      house.burnTimer += dt;
      house.emitTimer = (house.emitTimer || 0) - dt;
      if (house.emitTimer <= 0) {
        house.emitTimer = rand(0.05, 0.13);
        this._emitFire(house);
      }

      house.spreadTimer = (house.spreadTimer || 0) - dt;
      if (house.spreadTimer <= 0) {
        house.spreadTimer = rand(0.5, 1);
        const radius = (this.config.houseFireSpreadRadiusTiles ?? 5.5) * ts;
        this.igniteAt(house.x, house.y, radius, {
          chance: this.config.houseFireSpreadChance ?? 0.08,
        });
      }

      if (house.burnTimer >= house.burnDuration) this._destroy(house, "fire");
    }
  }

  /**
   * Woda niszczy chatę: mocna ulewa podmywa ją bezpośrednio, a powódź
   * (głęboka woda stojąca przy domu) robi to szybciej. W obu przypadkach
   * budynek przechyla się, mieszkańcy uciekają, a na końcu zostaje błoto.
   */
  _updateWater(dt) {
    const weather = this.game.weather;
    const ts = this.map.tileSize;
    const decay = this.config.rainWashDecay ?? 1.2;
    const minFloodDepth = this.floodWashDepthTiles * ts;

    for (const house of [...this.houses]) {
      if (house.burning || house.destroyed) continue;

      const intensity = weather ? weather.rainDamageAt(house.x) : 0;
      const raining = intensity >= this.rainWashMinIntensity;
      const depth = this._houseWaterDepth(house);
      const flooding = depth >= minFloodDepth;

      if (raining || flooding) {
        const overflow = flooding
          ? clamp((depth - minFloodDepth) / ts, 0, 1)
          : 0;
        const floodRate = flooding ? this.floodWashRate + overflow : 0;
        const rate = Math.max(raining ? intensity : 0, floodRate);
        const cause = flooding ? "flood" : "rain";

        house.wash = Math.min(
          this.rainWashSeconds,
          (house.wash || 0) + dt * rate
        );
        house.washCause = cause;

        house.splashTimer = (house.splashTimer || 0) - dt;
        if (house.splashTimer <= 0) {
          house.splashTimer = rand(0.08, 0.16);
          const wallH = house.wallH ?? 27;
          const rx = house.x + rand(-house.w * 0.6, house.w * 0.6);
          const ry = flooding
            ? house.y - Math.min(depth, wallH) * rand(0.2, 0.9)
            : house.y - rand(wallH * 0.2, wallH);
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

        if (
          !house.evacuated &&
          house.wash >= this.rainWashSeconds * 0.7 &&
          house.residents.size > 0
        ) {
          // Chata zaczyna się rozpadać — mieszkańcy wolą zmoknąć na zewnątrz.
          house.evacuated = true;
          this._evacuate(house, cause);
          this.game.ui.toast(
            cause === "flood"
              ? `Powódź podmywa dom rodziny <strong>${house.familyName}</strong>. Mieszkańcy uciekają.`
              : `Ulewa podmywa dom rodziny <strong>${house.familyName}</strong>. Mieszkańcy uciekają.`,
            "rain"
          );
        }

        if (house.wash >= this.rainWashSeconds) {
          this._evacuate(house, cause);
          this._destroy(house, cause);
        }
      } else if (house.wash > 0) {
        house.wash = Math.max(0, house.wash - dt * decay);
        // Chata przestała się rozpadać — rodzina może wrócić, a kolejna
        // ulewa albo powódź znowu wypędzi ją na zewnątrz.
        if (house.wash < this.rainWashSeconds * 0.7) house.evacuated = false;
      }
    }
  }

  /**
   * Najgłębsza woda pod chatą (w pikselach). Powódź może podmyć dom
   * z boku, więc bierzemy pod uwagę także kolumny przy krawędziach.
   */
  _houseWaterDepth(house) {
    const ts = this.map.tileSize;
    const center = Math.floor(house.x / ts);
    const baseY = this.water.columnInfo(center).groundY;
    const half = Math.max(1, Math.floor((house.w ?? 46) / ts / 2));
    let depth = 0;
    for (let tx = center - half; tx <= center + half; tx++) {
      const info = this.water.columnInfo(tx);
      // Tylko kolumny na tym samym poziomie gruntu — inaczej sąsiednie
      // jezioro za skarpą wyglądałoby jak powódź pod domem.
      if (Math.abs(info.groundY - baseY) > ts * 0.5) continue;
      depth = Math.max(depth, info.depth);
    }
    return depth;
  }

  _emitIgnition(house) {
    const wallH = house.wallH ?? 27;
    const roofH = house.roofH ?? 16;
    this.game.effects.burst(
      house.x,
      house.y - wallH - roofH * 0.35,
      "#ff9d3c",
      22,
      { speed: 46, life: 0.9, size: 2.5, gravity: 90, type: "flame" }
    );
    this.game.effects.burst(
      house.x,
      house.y - wallH * 0.6,
      "#5b4a3e",
      10,
      { speed: 22, life: 1.8, size: 3.2, gravity: -28, type: "smoke" }
    );
  }

  _emitFire(house) {
    const wallH = house.wallH ?? 27;
    const roofH = house.roofH ?? 16;
    const h = wallH + roofH;
    const x = house.x + rand(-house.w * 0.55, house.w * 0.55);
    const y = house.y - rand(0.1, 0.95) * h;

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

  /** Usuwa dom ze świata i zostawia po nim ślad. */
  _destroy(house, cause = "fire") {
    if (house.destroyed) return;
    house.destroyed = true;
    house.burning = false;

    const index = this.houses.indexOf(house);
    if (index >= 0) this.houses.splice(index, 1);
    this.byId.delete(house.id);
    this.totalLost = (this.totalLost || 0) + 1;

    if (house.residents.size > 0) this._evacuate(house, cause);

    const wallH = house.wallH ?? 27;
    if (cause === "rain" || cause === "flood") {
      this.game.effects.burst(
        house.x,
        house.y - wallH * 0.4,
        "#9dbfcb",
        28,
        { speed: 46, life: 1.1, size: 2.3, gravity: 180 }
      );
      this.game.effects.burst(
        house.x,
        house.y - 2,
        "#6f5a41",
        16,
        { speed: 28, life: 1.4, size: 2.2, gravity: 130 }
      );
      this.game.audio?.splash?.();
      this.game.ui.toast(
        cause === "flood"
          ? `Powódź zmywa dom rodziny <strong>${house.familyName}</strong>.`
          : `Ulewa zmywa dom rodziny <strong>${house.familyName}</strong>.`,
        "rain"
      );
    } else if (cause === "wind") {
      this.game.effects.burst(
        house.x,
        house.y - wallH * 0.45,
        "#8a5a34",
        26,
        { speed: 64, life: 1.1, size: 2.4, gravity: 140, type: "leaf" }
      );
      this.game.effects.burst(
        house.x,
        house.y - wallH * 0.4,
        "#cbb894",
        20,
        { speed: 34, life: 1.8, size: 3, gravity: -12, type: "smoke" }
      );
      this.game.audio?.windBurst?.(3);
      this.game.ui.toast(
        `Huragan zwiewa dom rodziny <strong>${house.familyName}</strong>.`,
        "death"
      );
    } else {
      this.game.effects.burst(
        house.x,
        house.y - wallH * 0.35,
        "#ff9d3c",
        24,
        { speed: 62, life: 0.95, size: 2.5, gravity: 120, type: "flame" }
      );
      this.game.effects.burst(
        house.x,
        house.y - wallH * 0.5,
        "#5b4a3e",
        16,
        { speed: 24, life: 1.9, size: 3.1, gravity: -30, type: "smoke" }
      );
      this.game.audio?.fire?.();
      this.game.ui.toast(
        `Dom rodziny <strong>${house.familyName}</strong> obraca się w zgliszcza.`,
        "death"
      );
    }

    this._addRuinDecal(house, cause);
  }

  _addRuinDecal(house, cause) {
    const decals = this.game.effects.decals;
    decals.push({
      x: house.x,
      y: house.y,
      w: house.w * 2,
      h: house.w * 0.8,
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

  _partnerOf(person) {
    if (person.partnerId == null) return null;
    const partner = this.population.byId.get(person.partnerId);
    return partner && partner.alive ? partner : null;
  }

  _parentWithHome(person) {
    for (const id of [person.motherId, person.fatherId]) {
      if (id == null) continue;
      const parent = this.population.byId.get(id);
      if (parent && parent.alive && parent.homeId != null) return parent;
    }
    return null;
  }

  /** Ludzie bez dachu przeprowadzają się do partnera, rodzica albo wolnego domu. */
  _pairHomeless() {
    for (const person of this.population.people) {
      if (!person.alive || person.homeId != null) continue;

      const partner = this._partnerOf(person);
      if (partner && partner.homeId != null) {
        this.moveIn(person, partner.homeId);
        continue;
      }

      // Młode osoby mogą zostać u rodziców, jeśli jest miejsce.
      if (person.ageYears < (person.config.fertileAge ?? 16) + 2) {
        const parent = this._parentWithHome(person);
        if (parent) {
          this.moveIn(person, parent.homeId);
          continue;
        }
      }

      // Wolne miejsce w pobliżu: bezdomny prosi o kąt u sąsiadów.
      if (person.homeBuild) continue;
      if (!chance(this.config.moveInChance ?? 0.12)) continue;
      let best = null;
      let bestDist = Infinity;
      const maxDist = (this.config.familyRadiusTiles ?? 16) * this.map.tileSize;
      for (const house of this.houses) {
        if (house.burning || house.destroyed) continue;
        if (house.residents.size >= this.maxResidents) continue;
        const d = Math.abs(house.x - person.x);
        if (d > maxDist || d >= bestDist) continue;
        bestDist = d;
        best = house;
      }
      if (best) this.moveIn(person, best.id);
    }
  }

  _pruneHouses() {
    for (const house of this.houses) {
      for (const id of [...house.residents]) {
        const person = this.population.byId.get(id);
        if (!person || !person.alive) house.residents.delete(id);
      }
    }
  }

  /** Budowniczy, partner, dzieci, a potem najbliżsi bezdomni. */
  _assignFamily(house, builder) {
    const max = this.maxResidents;
    const added = new Set();

    const add = (person) => {
      if (!person || !person.alive) return;
      if (house.residents.size >= max) return;
      if (person.homeId === house.id) {
        added.add(person.id);
        return;
      }
      if (person.homeId != null) return;
      if (person.homeBuild) return;
      person.homeId = house.id;
      house.residents.add(person.id);
      added.add(person.id);
    };

    add(builder);
    const partner = this._partnerOf(builder);
    if (partner) add(partner);

    // Dzieci budowniczego i jego partnera.
    const parents = new Set([builder.id]);
    if (partner) parents.add(partner.id);
    const children = this.population.people
      .filter(
        (p) =>
          p.alive &&
          p.homeId == null &&
          !p.homeBuild &&
          ((p.motherId != null && parents.has(p.motherId)) ||
            (p.fatherId != null && parents.has(p.fatherId)))
      )
      .sort(
        (a, b) =>
          distance(a.x, a.y, house.x, house.y) -
          distance(b.x, b.y, house.x, house.y)
      );
    for (const child of children) add(child);

    // Reszta: najbliżsi bezdomni w okolicy.
    if (house.residents.size < max) {
      const radius = (this.config.familyRadiusTiles ?? 16) * this.map.tileSize;
      const nearest = this.population.people
        .filter(
          (p) =>
            p.alive &&
            p.homeId == null &&
            !p.homeBuild &&
            !added.has(p.id) &&
            Math.abs(p.x - house.x) <= radius
        )
        .sort(
          (a, b) =>
            distance(a.x, a.y, house.x, house.y) -
            distance(b.x, b.y, house.x, house.y)
        );
      for (const person of nearest) add(person);
    }
  }

  _chooseSite(originX) {
    const ts = this.map.tileSize;
    const radius = Math.max(6, this.config.siteSearchTiles ?? 26);
    const spacing = (this.config.minSiteSpacingTiles ?? 5) * ts;
    const w = this.config.width ?? 46;
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

      // Losowość miejsca jest ważniejsza niż odległość od budowniczego.
      const score = rand(0, 1) - Math.abs(tx - originX / ts) * 0.004;
      if (score > bestScore) {
        bestScore = score;
        best = { tx, x, y: row * ts };
      }
    }
    return best;
  }

  _nearStructure(x, spacing) {
    for (const house of this.houses) {
      if (Math.abs(house.x - x) < spacing) return true;
    }
    for (const site of this.sites) {
      if (Math.abs(site.x - x) < spacing) return true;
    }
    return false;
  }

  _removeSite(siteId) {
    const index = this.sites.findIndex((s) => s.id === siteId);
    if (index < 0) return;
    const site = this.sites[index];
    this.sites.splice(index, 1);
    // Plac budowy znika, ale ślady pracy zostają na ziemi.
    this.game.effects.burst(site.x, site.y - 2, "#8a7c68", 8, {
      speed: 18,
      life: 0.8,
      size: 1.6,
      gravity: 80,
    });
  }
}
