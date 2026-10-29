import { TAU, chance, clamp, distance, rand } from "./utils.js?v=20261046-1";

/**
 * Uprawy: wioska zakłada pola zbóż, sieje, zbiera plony i gromadzi ziarno.
 * Liczba pól rośnie z liczbą mieszkańców, a każdy dorosły może pracować
 * przy siewie lub żniwach. Ogień (piorun, pożar lasu) pali uprawy, a woda
 * je podmywa i gnije — wtedy pola znikają, zapasy maleją, a ludzie głodują.
 */
export class Crops {
  constructor(game) {
    this.game = game;
    this.map = game.map;
    this.water = game.water;
    this.config = game.config.crops || {};
    this.plots = [];
    // Miejsca po zniszczonych polach. Zboże można zasiać od nowa na tym
    // samym skrawku, więc wieś nie traci pól na zawsze po każdej wichurze.
    this.freeSites = [];
    this.nextId = 1;
    this.time = 0;
    this.food = this.config.foodStart ?? 40;
    this.foodMax = this.config.foodMax ?? 160;
    this.warnedEmpty = false;
    this._toastCooldown = 0;
    this._plotTimer = 0;
    this.stats = { harvests: 0, burned: 0, rotted: 0 };
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get aliveCount() {
    return this.game.population?.aliveCount ?? 0;
  }

  /** Ile pól wioska potrzebuje przy obecnej liczbie ludności. */
  get neededPlots() {
    const per = Math.max(1, this.config.peoplePerPlot ?? 5);
    return clamp(
      Math.ceil(this.aliveCount / per),
      this.config.minPlots ?? 1,
      this.config.maxPlots ?? 10
    );
  }

  /** Ilu ludzi naraz może pracować w polu. */
  get maxWorkers() {
    const per = Math.max(1, this.config.workersPerPerson ?? 7);
    return Math.min(
      this.config.maxWorkers ?? 6,
      Math.max(1, Math.ceil(this.aliveCount / per))
    );
  }

  getPlot(id) {
    return this.plots.find((plot) => plot.id === id) ?? null;
  }

  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
    this._toastCooldown = Math.max(0, this._toastCooldown - dt);

    for (const plot of [...this.plots]) {
      if (plot.burning) {
        this._updateBurn(plot, dt);
        continue;
      }
      if (plot.state === "growing") {
        const moisture = plot.soilMoisture || 0;
        const boost = 1 + moisture * (this.config.rainGrowthBoost ?? 0.45);
        plot.growth = Math.min(
          1,
          plot.growth +
            (dt * boost) / Math.max(1, this.config.growSeconds ?? 18)
        );
        if (plot.growth >= 1) plot.state = "ripe";
      }
      this._updateRot(plot, dt);
      if (plot.soilMoisture > 0) {
        plot.soilMoisture = Math.max(
          0,
          plot.soilMoisture - dt * (this.config.rainMoistureDecay ?? 0.02)
        );
      }
      if (plot.rainWet > 0) {
        plot.rainWet = Math.max(
          0,
          plot.rainWet - dt * (this.config.rainWetDecay ?? 0.09)
        );
      }
      if (plot.windBend) {
        plot.windBend *= Math.max(0, 1 - dt * 3.2);
        if (Math.abs(plot.windBend) < 0.01) plot.windBend = 0;
      }
    }

    // Wioska sama zakłada nowe pola, gdy brakuje ich dla rosnącej ludności.
    this._plotTimer = Math.max(0, this._plotTimer - dt);
    if (this.plots.length < this.neededPlots && this._plotTimer <= 0) {
      // Najpierw odzyskaj miejsce po zniszczonym polu. Losowe szukanie
      // nowego skrawka często nie znajduje luki między ocalałymi polami,
      // przez co wichura trwale zmniejszała liczbę upraw.
      const spot =
        this._takeFreeSite() || this._chooseSite(this._villageX());
      if (spot) {
        this._createPlot(spot);
        this._plotTimer = this.config.plotCreateSeconds ?? 4;
      } else {
        this._plotTimer = 1.5;
      }
    }
  }

  /** Deszcz i powódź: mokra ziemia gnije, aż pole znika. */
  _updateRot(plot, dt) {
    if (plot.state !== "growing" && plot.state !== "ripe") return;
    const ts = this.map.tileSize;
    const depth = this.water.columnInfo(plot.tx).depth;
    const minDepth = (this.config.rotDepthTiles ?? 0.2) * ts;

    if (depth > minDepth) {
      const rate =
        (this.config.rotRateBase ?? 0.35) +
        (depth / ts) * (this.config.rotRatePerTile ?? 0.6);
      plot.rot = Math.min(1, (plot.rot || 0) + dt * rate);
      plot.wet = true;

      if (chance(dt * 2)) {
        this.game.effects.burst(
          plot.x + rand(-plot.w * 0.5, plot.w * 0.5),
          plot.y - rand(1, 4),
          "#7d8a63",
          1,
          { speed: 8, life: 0.7, size: 1.5, gravity: 30, spread: TAU }
        );
      }
      if (plot.rot >= 1) this._dropPlot(plot, "rot");
    } else {
      plot.wet = false;
      plot.rot = Math.max(0, (plot.rot || 0) - dt * 0.12);
    }
  }

  _updateBurn(plot, dt) {
    plot.burnTimer += dt;
    if (chance(dt * 14)) {
      this.game.effects.burst(
        plot.x + rand(-plot.w * 0.45, plot.w * 0.45),
        plot.y - rand(2, 10),
        chance(0.5) ? "#ffb347" : "#ff6a2a",
        1,
        {
          speed: 16,
          life: 0.7,
          size: 2.2,
          gravity: -45,
          type: "flame",
          spread: TAU,
        }
      );
    }
    if (chance(dt * 5)) {
      this.game.effects.burst(
        plot.x + rand(-plot.w * 0.4, plot.w * 0.4),
        plot.y - rand(6, 14),
        "#4c4038",
        1,
        {
          speed: 8,
          life: 1.8,
          size: 3,
          gravity: -25,
          type: "smoke",
          spread: TAU,
        }
      );
    }
    if (plot.burnTimer >= plot.burnDuration) this._dropPlot(plot, "fire");
  }

  /** Podpala pola w promieniu (piorun, ogień z lasu). */
  igniteAt(x, y, radius, opts = {}) {
    let count = 0;
    const ts = this.map.tileSize;
    const chanceToIgnite =
      opts.chance ?? this.config.igniteChance ?? 0.85;

    for (const plot of this.plots) {
      if (plot.burning) continue;
      if (Math.abs(plot.x - x) > radius + plot.w * 0.5) continue;
      if (Math.abs(plot.y - y) > ts * 2.5) continue;
      if (!chance(chanceToIgnite)) continue;
      this._ignite(plot);
      count++;
    }
    return count;
  }

  /**
   * Deszcz podlewa glebę. Lekki opad tylko nawilża ziemię i przyspiesza
   * wzrost; dopiero gwałtowna ulewa (poziom 3) wypłukuje i łamie plony.
   */
  rainAt(x, radius, intensity, dt, strength = 2) {
    if (!this.enabled || intensity <= 0.01) return 0;
    const cfg = this.config;
    const rate = (cfg.rainIrrigationPerSecond ?? 0.45) * intensity;
    let touched = 0;
    for (const plot of [...this.plots]) {
      if (plot.burning) continue;
      const dx = Math.abs(plot.x - x);
      if (dx > radius + plot.w * 0.5) continue;
      const falloff = 1 - Math.min(1, dx / Math.max(1, radius));
      const gain =
        rate *
        (0.35 + falloff * 0.65) *
        dt *
        (strength >= 3 ? 1.4 : 1);
      plot.soilMoisture = Math.min(1, (plot.soilMoisture || 0) + gain);
      plot.rainWet = Math.min(
        1,
        (plot.rainWet || 0) + gain * (strength >= 3 ? 4 : 2.4)
      );
      touched++;

      if (
        strength >= 3 &&
        plot.state !== "empty" &&
        chance(
          dt *
            (cfg.rainDamageChancePerSecond ?? 0.04) *
            falloff *
            intensity
        )
      ) {
        this._dropPlot(plot, "rain");
      }
    }
    return touched;
  }

  /**
   * Wiatr gnie łodygi, a przy silnym podmuchu łamie całe pole. Zniszczone
   * zboże zostawia na ziemi warstwę słomy.
   */
  windAt(x, y, radius, strength, dt, dir = 1) {
    const ts = this.map.tileSize;
    let broken = 0;
    for (const plot of [...this.plots]) {
      if (plot.burning) continue;
      const dx = plot.x - x;
      if (Math.abs(dx) > radius + plot.w * 0.5) continue;
      if (Math.abs(plot.y - y) > ts * 2.5) continue;

      const falloff = 1 - Math.min(1, Math.abs(dx) / Math.max(1, radius));
      plot.windBend = clamp(
        (plot.windBend || 0) +
          dir * dt * strength * (2.2 + falloff * 3.4),
        -6,
        6
      );

      if (
        plot.state !== "empty" &&
        strength >= 2 &&
        chance(
          dt *
            (this.game.config.wind?.cropBreakChancePerSecond ?? 0.05) *
            (strength - 1) *
            (0.4 + falloff * 0.6)
        )
      ) {
        this._dropPlot(plot, "wind");
        broken++;
      }
    }
    return broken;
  }

  _ignite(plot) {
    if (plot.burning) return;
    plot.burning = true;
    plot.burnTimer = 0;
    plot.burnDuration = rand(
      this.config.burnSecondsMin ?? 2.5,
      this.config.burnSecondsMax ?? 4.5
    );
    this._releaseWorker(plot);
    this.game.effects.burst(plot.x, plot.y - 5, "#ffb347", 10, {
      speed: 34,
      life: 0.8,
      size: 2.2,
      gravity: -30,
      type: "flame",
    });
  }

  _dropPlot(plot, cause) {
    this._releaseWorker(plot);
    const index = this.plots.indexOf(plot);
    if (index >= 0) this.plots.splice(index, 1);

    // Zapamiętaj skrawek, żeby wieś mogła na nim odtworzyć pole.
    if (this.freeSites.length < 40) {
      this.freeSites.push({
        x: plot.x,
        y: plot.y,
        tx: plot.tx,
        w: plot.w,
        seed: plot.seed,
      });
    }

    const ts = this.map.tileSize;
    if (cause === "fire") {
      this.stats.burned++;
      this.game.effects.decals.push({
        x: plot.x,
        y: plot.y,
        w: plot.w * 1.05,
        h: ts * 0.5,
        rotation: rand(-0.1, 0.1),
        life: 24,
        maxLife: 24,
        type: "scorch",
      });
      this.game.effects.burst(plot.x, plot.y - 6, "#ff9d3c", 22, {
        speed: 64,
        life: 0.9,
        size: 2.4,
        gravity: 120,
        type: "flame",
      });
      this._toast("Ogień trawi uprawy.", "fire");
    } else if (cause === "wind") {
      this.stats.windLoss = (this.stats.windLoss || 0) + 1;
      this.game.effects.decals.push({
        x: plot.x,
        y: plot.y,
        w: plot.w * 1.1,
        h: ts * 0.4,
        rotation: rand(-0.28, 0.28),
        life: 16,
        maxLife: 16,
        type: "straw",
      });
      this.game.effects.burst(plot.x, plot.y - 3, "#d8b24a", 18, {
        speed: 46,
        life: 1.1,
        size: 1.8,
        gravity: 60,
        spread: TAU,
        type: "leaf",
      });
      this._toast("Wiatr łamie zboże. Uprawy znikają.", "rain");
    } else if (cause === "rain") {
      this.stats.rainLoss = (this.stats.rainLoss || 0) + 1;
      this.game.effects.decals.push({
        x: plot.x,
        y: plot.y,
        w: plot.w * 1.0,
        h: ts * 0.4,
        rotation: rand(-0.22, 0.22),
        life: 14,
        maxLife: 14,
        type: "mud",
      });
      this.game.effects.burst(plot.x, plot.y - 4, "#9dbfcb", 16, {
        speed: 38,
        life: 0.9,
        size: 1.9,
        gravity: 160,
      });
      this._toast("Ulewa wypłukuje plony z pola.", "rain");
    } else {
      this.stats.rotted++;
      this.game.effects.decals.push({
        x: plot.x,
        y: plot.y,
        w: plot.w * 0.95,
        h: ts * 0.45,
        rotation: rand(-0.2, 0.2),
        life: 18,
        maxLife: 18,
        type: "mud",
      });
      this.game.effects.burst(plot.x, plot.y - 2, "#7d8a63", 14, {
        speed: 22,
        life: 1,
        size: 2,
        gravity: 90,
      });
      this._toast("Woda gnije plony. Uprawy znikają.", "rain");
    }
    if (this.game.effects.decals.length > 40) {
      this.game.effects.decals.shift();
    }
  }

  _toast(html, type) {
    if (this._toastCooldown > 0) return;
    this._toastCooldown = 5;
    this.game.ui.toast(html, type);
  }

  /** Szuka pola do pracy dla człowieka; zakłada nowe, gdy wioska go potrzebuje. */
  tryStartWork(person, ignoreWorkerCap = false) {
    if (!this.enabled || !person.alive) return false;
    if (person.ageYears < (this.config.minAge ?? 12)) return false;
    if (person.isNight) return false;
    if (person.cropWork || person.homeBuild || person.ladderBuild) return false;
    if (!ignoreWorkerCap && this._workerCount() >= this.maxWorkers) {
      return false;
    }

    let plot = this._pickPlot(person, ["ripe"]);
    if (!plot) {
      // Najpierw żniwa; nowe pole powstaje tylko, gdy wiosce brakuje pól.
      if (this.plots.length < this.neededPlots && chance(this.config.workChance ?? 0.8)) {
        const spot =
          this._takeFreeSite() || this._chooseSite(this._villageX());
        if (spot) plot = this._createPlot(spot);
      }
      if (!plot) plot = this._pickPlot(person, ["empty"]);
    }
    if (!plot) return false;
    return this._assign(person, plot);
  }

  /**
   * Gdy zapasy spadają, ludzie rzucają inne zajęcia i idą zbierać dojrzałe
   * zboże, zamiast czekać bezczynnie na kolejny spacer.
   */
  urgentHarvest(person) {
    if (!this.enabled || !person.alive) return false;
    if (this.food >= (this.config.urgentFood ?? 30)) return false;
    // W kryzysie żywnościowym żniwa są ważniejsze niż limit etatów.
    if (this._pickPlot(person, ["ripe"])) {
      return this.tryStartWork(person, true);
    }
    // Gdy dojrzałego zboża brak, obsiejmy puste pola ponad limit, żeby
    // odbudować zapasy; inaczej wieś czeka bezczynnie na kolejny zbiór.
    if (this._pickPlot(person, ["empty"])) {
      return this.tryStartWork(person, true);
    }
    return false;
  }

  resume(person) {
    const work = person.cropWork;
    if (!work) return false;
    const plot = this.getPlot(work.plotId);
    if (!plot || plot.burning || plot.state === "rotting") {
      this.cancelProject(person);
      return false;
    }
    if (plot.workerId !== person.id) {
      this.cancelProject(person);
      return false;
    }
    if (plot.state === "empty") {
      work.action = "sow";
    } else if (plot.state === "ripe") {
      work.action = "harvest";
    } else {
      this.cancelProject(person);
      return false;
    }
    person.state = work.action;
    person.targetX = plot.x;
    return true;
  }

  /** Kończy pracę: zasiew zakłada wzrost, żniwa dodają ziarno do zapasów. */
  completeWork(person, plot) {
    const work = person.cropWork;
    if (!work || !plot || plot.workerId !== person.id) return false;

    if (work.action === "sow") {
      plot.state = "growing";
      plot.growth = 0;
      plot.rot = 0;
      plot.wet = false;
      plot.sownAt = this.time;
      this.game.effects.burst(plot.x, plot.y - 2, "#8a6a43", 9, {
        speed: 18,
        life: 0.5,
        size: 1.5,
        gravity: 120,
      });
    } else if (work.action === "harvest" && plot.state === "ripe") {
      const amount = this.config.yieldPerHarvest ?? 8;
      this.food = Math.min(this.foodMax, this.food + amount);
      this.stats.harvests++;
      plot.state = "empty";
      plot.growth = 0;
      plot.rot = 0;
      plot.wet = false;
      this.game.effects.burst(plot.x, plot.y - 8, "#e2c063", 14, {
        speed: 26,
        life: 0.8,
        size: 1.8,
        gravity: 90,
      });
    }

    plot.workerId = null;
    person.cropWork = null;
    person._cropTimer = 0;
    person.targetX = null;
    if (person.state === "sow" || person.state === "harvest") {
      person.state = "idle";
      person.stateTimer = rand(0.5, 1.6);
    }
    return true;
  }

  /** Przerywa pracę człowieka, zwalniając pole dla innych. */
  cancelProject(person) {
    const work = person.cropWork;
    if (!work) return;
    const plot = this.getPlot(work.plotId);
    if (plot && plot.workerId === person.id) plot.workerId = null;
    person.cropWork = null;
    person._cropTimer = 0;
    if (person.state === "sow" || person.state === "harvest") {
      person.state = "idle";
      person.stateTimer = rand(0.5, 1.6);
      person.targetX = null;
      person.moveDir = 0;
    }
  }

  /** Zwalnia pole po śmierci człowieka. */
  release(person) {
    if (!person.cropWork) return;
    const plot = this.getPlot(person.cropWork.plotId);
    if (plot && plot.workerId === person.id) plot.workerId = null;
    person.cropWork = null;
  }

  tryEat(person) {
    if (this.food >= 1) {
      this.food -= 1;
      person.hunger = Math.max(
        0,
        person.hunger - (this.config.mealValue ?? 0.85)
      );
      this.warnedEmpty = false;
      return true;
    }
    if (!this.warnedEmpty) {
      this.warnedEmpty = true;
      this.game.ui.toast(
        "Zapasy ziarna się skończyły. Ludzie zaczynają głodować.",
        "death"
      );
    }
    return false;
  }

  _workerCount() {
    let count = 0;
    for (const person of this.game.population?.people || []) {
      if (person.alive && person.cropWork) count++;
    }
    return count;
  }

  /** Środek wioski — pola powstają blisko chat, nie tam, gdzie ktoś stał. */
  _villageX() {
    const houses = this.game.housing?.houses || [];
    if (!houses.length) {
      return (this.map.spawn.x + 0.5) * this.map.tileSize;
    }
    let sum = 0;
    for (const house of houses) sum += house.x;
    return sum / houses.length;
  }

  _pickPlot(person, states = ["ripe", "empty"]) {
    let best = null;
    let bestScore = Infinity;
    for (const plot of this.plots) {
      if (plot.burning || plot.workerId != null) continue;
      if (!states.includes(plot.state)) continue;
      const priority = plot.state === "ripe" ? 0 : 1;
      const score =
        priority * 100000 +
        distance(person.x, person.y, plot.x, plot.y);
      if (score < bestScore) {
        bestScore = score;
        best = plot;
      }
    }
    return best;
  }

  _assign(person, plot) {
    const action = plot.state === "ripe" ? "harvest" : "sow";
    plot.workerId = person.id;
    person.cropWork = { plotId: plot.id, action };
    person._cropTimer = 0;
    person.state = action;
    person.targetX = plot.x;
    person.targetY = plot.y;
    return true;
  }

  _releaseWorker(plot) {
    if (plot.workerId == null) return;
    const worker = this.game.population?.byId.get(plot.workerId);
    if (worker && worker.cropWork && worker.cropWork.plotId === plot.id) {
      worker.cropWork = null;
      worker._cropTimer = 0;
      if (worker.state === "sow" || worker.state === "harvest") {
        worker.state = "idle";
        worker.stateTimer = rand(0.4, 1.4);
        worker.targetX = null;
        worker.moveDir = 0;
      }
    }
    plot.workerId = null;
  }

  /** Wybiera płaski, suchy skrawek ziemi z dala od chat i innych pól. */
  _chooseSite(originX) {
    const ts = this.map.tileSize;
    const width = (this.config.plotWidthTiles ?? 3.6) * ts;
    const halfTiles = Math.max(1, Math.ceil(width / ts / 2));
    const radius = this.config.siteSearchTiles ?? 34;
    const spacing = (this.config.minSpacingTiles ?? 4) * ts;
    const minTx = halfTiles + 2;
    const maxTx = this.map.width - halfTiles - 3;
    const houses = this.game.housing?.houses || [];

    for (let attempt = 0; attempt < 120; attempt++) {
      const tx = Math.round(originX / ts + rand(-radius, radius));
      if (tx < minTx || tx > maxTx) continue;
      const x = (tx + 0.5) * ts;
      const row = this.map.surfaceRow(tx);
      const ground = this.map.tileAt(tx, row);
      if (ground !== "#" && ground !== "f") continue;

      let minRow = row;
      let maxRow = row;
      for (let dx = -halfTiles; dx <= halfTiles; dx++) {
        const r = this.map.surfaceRow(tx + dx);
        if (r < minRow) minRow = r;
        if (r > maxRow) maxRow = r;
      }
      // Lekki spadek jest w porządku; ostre urwisko już nie.
      if (maxRow - minRow > 1) continue;

      const y = row * ts;
      if (this.water.columnInfo(tx).depth > ts * 0.15) continue;
      if (this.plots.some((p) => Math.abs(p.x - x) < spacing)) continue;
      if (
        houses.some(
          (h) =>
            Math.abs(h.x - x) < spacing + (h.w ?? 46) * 0.5 &&
            Math.abs(h.y - y) < ts * 1.5
        )
      ) {
        continue;
      }

      const trees = this.game.vegetation?.trees || [];
      const blocked = trees.some(
        (tree) =>
          !tree.felled &&
          Math.abs(tree.x - x) < width * 0.45 &&
          Math.abs(tree.y - y) < ts * 1.2
      );
      if (blocked) continue;

      return { x, y, tx, w: width, seed: rand(0, 1000) };
    }
    return null;
  }

  /**
   * Odtwarza pole na skrawku po zniszczonym polu. Sprawdza, czy teren się nie
   * zmienił (wykop, woda, nowy dom, drzewo). Zalane miejsce zostaje w kolejce,
   * aż woda opadnie; trwale zajęte jest usuwane.
   */
  _takeFreeSite() {
    const ts = this.map.tileSize;
    const spacing = (this.config.minSpacingTiles ?? 4) * ts;
    const width = (this.config.plotWidthTiles ?? 3.6) * ts;
    const halfTiles = Math.max(1, Math.ceil(width / ts / 2));
    const houses = this.game.housing?.houses || [];
    const trees = this.game.vegetation?.trees || [];

    for (let i = this.freeSites.length - 1; i >= 0; i--) {
      const site = this.freeSites[i];
      const row = this.map.surfaceRow(site.tx);
      const x = site.x;
      const y = row * ts;

      // Pole w tym miejscu już stoi (np. założone losowo na dawnym skrawku).
      // Ten wpis jest zbędny — gdy tamto pole zniknie, jego miejsce wróci
      // do kolejki osobno.
      if (this.plots.some((p) => Math.abs(p.x - x) < spacing)) {
        this.freeSites.splice(i, 1);
        continue;
      }
      if (
        houses.some(
          (h) =>
            Math.abs(h.x - x) < spacing + (h.w ?? 46) * 0.5 &&
            Math.abs(h.y - y) < ts * 1.5
        )
      ) {
        this.freeSites.splice(i, 1);
        continue;
      }
      if (
        trees.some(
          (tree) =>
            !tree.felled &&
            Math.abs(tree.x - x) < width * 0.45 &&
            Math.abs(tree.y - y) < ts * 1.2
        )
      ) {
        this.freeSites.splice(i, 1);
        continue;
      }

      let minRow = row;
      let maxRow = row;
      for (let dx = -halfTiles; dx <= halfTiles; dx++) {
        const r = this.map.surfaceRow(site.tx + dx);
        if (r < minRow) minRow = r;
        if (r > maxRow) maxRow = r;
      }
      const ground = this.map.tileAt(site.tx, row);
      if (maxRow - minRow > 1 || (ground !== "#" && ground !== "f")) {
        this.freeSites.splice(i, 1);
        continue;
      }
      // Woda jeszcze stoi — poczekaj, nie porzucaj pola.
      if (this.water.columnInfo(site.tx).depth > ts * 0.15) {
        continue;
      }

      this.freeSites.splice(i, 1);
      return { ...site, y };
    }
    return null;
  }

  _createPlot(spot) {
    const plot = {
      id: this.nextId++,
      x: spot.x,
      y: spot.y,
      tx: spot.tx,
      w: spot.w,
      seed: spot.seed,
      state: "empty",
      growth: 0,
      rot: 0,
      wet: false,
      soilMoisture: 0,
      rainWet: 0,
      burning: false,
      burnTimer: 0,
      burnDuration: 0,
      workerId: null,
    };
    this.plots.push(plot);
    return plot;
  }
}
