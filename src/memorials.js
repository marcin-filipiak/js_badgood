import { chance, clamp, distance, rand } from "./utils.js?v=20261046-1";

/**
 * Miejsca pamięci po tragediach.
 *
 * Gdy w krótkim czasie i w jednym miejscu ginie kilka osób, ocalali czekają,
 * aż opadnie panika, schodzą się w tym miejscu, a potem stawiają mały kamienny
 * obelisk. Obelisk zostaje w świecie na zawsze i oznacza to miejsce.
 */
export class Memorials {
  constructor(game) {
    this.game = game;
    this.config = game.config.memorials || {};
    this.sites = [];
    this.byId = new Map();
    this.obelisks = [];
    this.recentDeaths = [];
    this.time = 0;
    this._nextId = 1;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  /** Wywoływane przez Population.kill() dla każdej śmierci. */
  recordDeath(person, cause = "starość") {
    if (!this.enabled) return;
    const ignored = this.config.ignoreCauses || [];
    if (ignored.includes(cause)) return;

    this.recentDeaths.push({
      x: person.x,
      y: person.y,
      cause,
      time: this.time,
    });
    this._pruneDeaths();

    const ts = this.game.map.tileSize;
    const radius = (this.config.clusterRadiusTiles ?? 5) * ts;
    const cluster = this.recentDeaths.filter(
      (death) => distance(death.x, death.y, person.x, person.y) <= radius
    );
    if (cluster.length < (this.config.deathsToTrigger ?? 3)) return;

    // Nie stawiaj drugiego miejsca pamięci tuż obok istniejącego.
    if (this.obelisks.some((o) => distance(o.x, o.y, person.x, person.y) <= radius * 1.4)) {
      return;
    }
    if (this.sites.some((s) => distance(s.x, s.y, person.x, person.y) <= radius * 1.4)) {
      return;
    }

    const centerX =
      cluster.reduce((sum, death) => sum + death.x, 0) / cluster.length;
    // Przy utonięciach śmierć bywa pod lustrem wody — obelisk stawiamy na
    // najbliższym suchym brzegu, żeby nie zniknął pod wodą.
    const siteX = this._findDryX(centerX, radius);
    const siteY = this.game.map.groundYAtWorldX(siteX);

    this._createSite(siteX, siteY, cluster.length);

    // Zużyj zgony z tego klastra, by nie tworzyć kilku miejsc pod rząd.
    const consumed = new Set(cluster);
    this.recentDeaths = this.recentDeaths.filter((death) => !consumed.has(death));
  }

  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
    this._pruneDeaths();

    const ts = this.game.map.tileSize;
    const night = this._isNight();

    for (let i = this.sites.length - 1; i >= 0; i--) {
      const site = this.sites[i];
      site.age += dt;
      this._pruneParticipants(site);

      if (site.state === "waiting") {
        // Nocą ludzie śpią; zbierają się dopiero po wschodzie słońca.
        if (night) continue;
        if (site.age >= 0.5 && !this._panicNearby(site)) {
          site.state = "gather";
          site.timer = this.config.gatherSeconds ?? 6;
          if (!site.announced) {
            site.announced = true;
            this.game.ui.toast(
              "Ludzie schodzą się w miejscu tragedii...",
              "memorial"
            );
          }
        } else if (
          site.age > (this.config.giveUpSeconds ?? 32) * 2 &&
          !this._panicNearby(site)
        ) {
          this._removeSite(site);
        }
      } else if (site.state === "gather") {
        if (night) {
          // Zapada noc — wracają do domów i do snu, obelisk poczeka.
          site.state = "waiting";
          site.age = 0;
          this._releaseAll(site);
          continue;
        }
        if (this._panicNearby(site)) {
          // Nowa tragedia przerwała żałobę.
          site.state = "waiting";
          site.age = 0;
          this._releaseAll(site);
          continue;
        }

        site.timer -= dt;
        const arrived = this._arrivedCount(site);
        if (site.timer <= 0) {
          if (arrived >= (this.config.minMourners ?? 2)) {
            site.state = "build";
            site.timer = this.config.buildSeconds ?? 1.8;
            site.dustTimer = 0;
          } else if (
            site.age >
            (this.config.gatherSeconds ?? 6) + (this.config.giveUpSeconds ?? 32)
          ) {
            this._removeSite(site);
          }
        }
      } else if (site.state === "build") {
        site.timer -= dt;
        site.dustTimer -= dt;
        if (site.dustTimer <= 0) {
          site.dustTimer = rand(0.2, 0.45);
          this.game.effects.burst(
            site.x + rand(-4, 4),
            site.y - rand(1, 4),
            "#bdb6a5",
            2,
            { speed: 18, life: 0.7, size: 1.8, gravity: 90 }
          );
        }
        if (site.timer <= 0) {
          this._erectObelisk(site);
          site.state = "done";
          site.timer = this.config.lingerSeconds ?? 4;
          this.game.ui.toast(
            "Kamienny obelisk staje ku pamięci zmarłych.",
            "memorial"
          );
        }
      } else if (site.state === "done") {
        site.timer -= dt;
        if (site.timer <= 0) {
          this._releaseAll(site);
          this._removeSite(site);
        }
      }
    }
  }

  getSite(id) {
    return this.byId.get(id) || null;
  }

  /** Osoba w stanie odpoczynku pyta, czy może dołączyć do żałoby. */
  findMourningSite(person) {
    if (!this.enabled) return null;
    if (person.isNight) return null;
    if (person.ageYears < 6) return null;
    if (person.memorialSiteId != null) return null;
    if (person.state === "flee" || person.state === "drown") return null;

    const ts = this.game.map.tileSize;
    const maxDistance = (this.config.gatherRadiusTiles ?? 28) * ts;
    let best = null;
    let bestDistance = Infinity;

    for (const site of this.sites) {
      if (site.state !== "gather") continue;
      if (site.participants.size >= (this.config.maxMourners ?? 8)) continue;
      if (site.participants.has(person.id)) continue;
      const d = Math.abs(person.x - site.x);
      if (d > maxDistance) continue;
      if (d < bestDistance) {
        bestDistance = d;
        best = site;
      }
    }

    if (!best) return null;
    if (!chance(this.config.joinChance ?? 0.7)) return null;

    best.participants.add(person.id);
    return best;
  }

  /** Usuwa osobę z listy uczestników (śmierć, panika, noc, odejście). */
  release(person) {
    if (person.memorialSiteId == null) return;
    const site = this.byId.get(person.memorialSiteId);
    if (site) site.participants.delete(person.id);
    person.memorialSiteId = null;
  }

  _createSite(x, y, deaths) {
    const h = rand(
      this.config.obeliskHeightMin ?? 24,
      this.config.obeliskHeightMax ?? 34
    );
    const site = {
      id: this._nextId++,
      x,
      y,
      deaths,
      state: "waiting",
      timer: 0,
      age: 0,
      announced: false,
      dustTimer: 0,
      obeliskH: h,
      obeliskW: clamp(h * 0.22, 4.5, 8),
      participants: new Set(),
    };
    this.sites.push(site);
    this.byId.set(site.id, site);
  }

  _erectObelisk(site) {
    this.obelisks.push({
      id: this._nextId++,
      x: site.x,
      y: site.y,
      h: site.obeliskH,
      w: site.obeliskW,
      seed: rand(0, 1000),
      deaths: site.deaths,
    });
    this.game.effects.burst(
      site.x,
      site.y - site.obeliskH * 0.45,
      "#c8c1b0",
      18,
      { speed: 34, life: 1.1, size: 2.1, gravity: 150 }
    );
    this.game.effects.burst(site.x, site.y, "#8a7c68", 12, {
      speed: 20,
      life: 1.4,
      size: 2,
      gravity: 40,
    });
  }

  _removeSite(site) {
    this._releaseAll(site);
    this.byId.delete(site.id);
    const index = this.sites.indexOf(site);
    if (index >= 0) this.sites.splice(index, 1);
  }

  _releaseAll(site) {
    for (const id of site.participants) {
      const person = this.game.population.byId.get(id);
      if (person && person.memorialSiteId === site.id) {
        person.memorialSiteId = null;
      }
    }
    site.participants.clear();
  }

  _pruneParticipants(site) {
    for (const id of [...site.participants]) {
      const person = this.game.population.byId.get(id);
      if (!person || !person.alive) site.participants.delete(id);
    }
  }

  _arrivedCount(site) {
    const ts = this.game.map.tileSize;
    const radius = ts * 3.2;
    const heightTolerance = ts * 1.5;
    let arrived = 0;
    for (const id of site.participants) {
      const person = this.game.population.byId.get(id);
      if (!person || !person.alive) continue;
      if (Math.abs(person.x - site.x) > radius) continue;
      if (Math.abs(person.y - site.y) > heightTolerance) continue;
      arrived++;
    }
    return arrived;
  }

  _panicNearby(site) {
    const ts = this.game.map.tileSize;
    const radius = (this.config.panicRadiusTiles ?? 16) * ts;
    for (const person of this.game.population.people) {
      if (!person.alive || person.panicTimer <= 0) continue;
      if (Math.abs(person.x - site.x) <= radius) return true;
    }
    return false;
  }

  _isNight() {
    const agents = this.game.config.agents;
    const nightStart = agents.nightStartHour ?? 21;
    const dayStart = agents.dayStartHour ?? 6;
    const hour = this.game.hour;
    return hour >= nightStart || hour < dayStart;
  }

  _pruneDeaths() {
    const window = this.config.clusterWindowSeconds ?? 40;
    while (
      this.recentDeaths.length &&
      this.time - this.recentDeaths[0].time > window
    ) {
      this.recentDeaths.shift();
    }
  }

  _findDryX(x, radius) {
    const map = this.game.map;
    const ts = map.tileSize;
    const center = clamp(Math.floor(x / ts), 4, map.width - 5);
    const maxSteps = Math.ceil(radius / ts);
    let best = null;
    let bestScore = Infinity;
    let fallback = null;
    let fallbackScore = Infinity;

    for (let step = 0; step <= maxSteps; step++) {
      const dirs = step === 0 ? [1] : [-1, 1];
      for (const dir of dirs) {
        const tx = clamp(center + dir * step, 4, map.width - 5);
        const info = this.game.water.columnInfo(tx);
        if (info.depth > ts * 0.15) continue;

        const distanceFromCenter = Math.abs(tx - center);
        if (distanceFromCenter < fallbackScore) {
          fallback = tx;
          fallbackScore = distanceFromCenter;
        }

        // Preferuj równy fragment gruntu, żeby żałobnicy mogli się zebrać
        // i żeby obelisk nie stał na samym skraju urwiska.
        const row = map.surfaceRow(tx);
        const flatness =
          Math.abs(map.surfaceRow(tx - 2) - row) +
          Math.abs(map.surfaceRow(tx + 2) - row);
        if (flatness > 2) continue;

        const score = distanceFromCenter + flatness * 0.6;
        if (score < bestScore) {
          bestScore = score;
          best = tx;
        }
      }
    }

    const tx = best ?? fallback ?? center;
    return (tx + 0.5) * ts;
  }
}
