import { chance, clamp, distance, rand, TAU } from "./utils.js?v=20261046-5";

/**
 * Kamienne monolity — materialny ślad boskiej mocy.
 *
 * Gdy w krótkim czasie ludzie oddają dużo Lush, w okolicy ich skupiska
 * powstaje monolit. Jeśli w tym regionie stoi już taki kamień, nie stawiamy
 * drugiego: ludzie gromadzą się i modlą przy istniejącym. Monolit zostaje
 * w świecie na zawsze i od czasu do czasu przyciąga pojedynczych czcicieli.
 */
export class Monoliths {
  constructor(game) {
    this.game = game;
    this.config = game.config.monoliths || {};
    this.sites = [];
    this.byId = new Map();
    this.monoliths = [];
    this.recentLush = [];
    this.recentDeaths = [];
    this.time = 0;
    this._nextId = 1;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  recordLush(amount) {
    if (!this.enabled || amount <= 0) return;
    this.recentLush.push({ t: this.time, amount: amount });
    // Zabezpieczenie przed rozrostem listy przy bardzo długiej nieobecności
    // odpowiedniego miejsca (np. gdy trwa noc).
    if (this.recentLush.length > 240) this.recentLush.shift();
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
    const radius = (this.config.deathClusterRadiusTiles ?? 6) * ts;
    const cluster = this.recentDeaths.filter(
      (death) => distance(death.x, death.y, person.x, person.y) <= radius
    );
    if (cluster.length < (this.config.deathThreshold ?? 4)) return;

    const centerX = cluster.reduce((sum, d) => sum + d.x, 0) / cluster.length;
    const centerY = cluster.reduce((sum, d) => sum + d.y, 0) / cluster.length;

    // Nie stawiaj monolit tuż obok istniejącego.
    const nearest = this._nearestSite(centerX, centerY);
    const region = (this.config.regionRadiusTiles ?? 20) * ts;
    if (nearest && distance(centerX, centerY, nearest.x, nearest.y) <= region) return;
    if (this.sites.length >= (this.config.maxMonoliths ?? 8)) return;

    const groundY = this.game.map.groundYAtWorldX(centerX);
    this._createSite(centerX, groundY, {
      toastText: "Wielka tragedia w dolinie — zemsta złego boga rodzi nowy monolit.",
      toastType: "memorial",
    });
  }

  _pruneDeaths() {
    const window = this.config.deathWindowSeconds ?? 15;
    while (this.recentDeaths.length && this.time - this.recentDeaths[0].time > window) {
      this.recentDeaths.shift();
    }
  }

  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
    const window = this.config.windowSeconds ?? 12;
    while (this.recentLush.length && this.time - this.recentLush[0].t > window) {
      this.recentLush.shift();
    }
    this._pruneDeaths();
    const total = this.recentLush.reduce((s, e) => s + e.amount, 0);
    const night = this._isNight();

    // Nocą ludzie śpią — energia czeka do świtu. Dzięki temu monolit nie
    // powstaje bez świadków, a kult od razu wygląda jak wydarzenie.
    if (!night && total >= (this.config.lushThreshold ?? 20)) {
      const center = this._centerOfPopulation();
      if (center) {
        this._handleSurge(center);
        this.recentLush.length = 0;
      }
    }

    for (let i = this.sites.length - 1; i >= 0; i--) {
      const site = this.sites[i];
      this._pruneParticipants(site);
      this._updateSite(site, dt, night);
    }

    // Monolit podpalony piorunem wypala się i znika z doliny.
    for (let i = this.monoliths.length - 1; i >= 0; i--) {
      const m = this.monoliths[i];
      if (!m) continue;
      if (m.burning) {
        m.burnTimer += dt;
        if (chance(dt * 6)) {
          this.game.effects?.burst?.(
            m.x + rand(-m.w * 0.45, m.w * 0.45),
            m.y - rand(4, Math.max(6, m.h * 0.8)),
            chance(0.5) ? "#ffb347" : "#ff6a2a",
            1,
            {
              speed: rand(10, 26),
              life: 0.6,
              size: 1.6,
              gravity: -38,
              type: "flame",
              spread: TAU,
            }
          );
        }
        if (chance(dt * 1.5)) {
          this.game.effects?.burst?.(
            m.x + rand(-m.w * 0.7, m.w * 0.7),
            m.y - m.h * rand(0.7, 1),
            "#4b4038",
            1,
            {
              speed: rand(4, 12),
              life: 1.6,
              size: 2.2,
              gravity: -22,
              type: "smoke",
              spread: TAU,
            }
          );
        }
        if (m.burnTimer >= m.burnDuration) {
          this._destroyMonolith(m);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* WYBÓR MIEJSCA                                                       */
  /* ------------------------------------------------------------------ */

  _handleSurge(center) {
    const ts = this.game.map.tileSize;
    const region = (this.config.regionRadiusTiles ?? this.config.minSpacingTiles ?? 20) * ts;
    const nearest = this._nearestSite(center.x, center.y);
    const atLimit = this.sites.length >= (this.config.maxMonoliths ?? 8);

    // W tym regionie stoi już monolit (albo jest w trakcie wznoszenia):
    // nie tworzymy konkurencyjnego kamienia, tylko wzywamy ludzi do kultu.
    if (nearest && (atLimit || distance(center.x, center.y, nearest.x, nearest.y) <= region)) {
      this._awakenSite(nearest);
      return;
    }

    const x = this._findDryX(center.x, region * 0.8);
    const y = this.game.map.groundYAtWorldX(x);

    // Dodatkowa kontrola odstępu — nowy monolit nie może stanąć zbyt blisko
    // starszego, nawet jeśli środek populacji przesunął się w bok.
    const blocking = this._nearestSite(x, y, (this.config.minSpacingTiles ?? 20) * ts);
    if (blocking) {
      this._awakenSite(blocking);
      return;
    }

    this._createSite(x, y);
  }

  _nearestSite(x, y, maxDistance = Infinity) {
    let best = null;
    let bestD = maxDistance;
    for (const site of this.sites) {
      const d = distance(x, y, site.x, site.y);
      if (d <= bestD) {
        bestD = d;
        best = site;
      }
    }
    return best;
  }

  _createSite(x, y, opts = {}) {
    const h = rand(
      this.config.monolithHeightMin ?? 44,
      this.config.monolithHeightMax ?? 66
    );
    const w =
      (this.config.monolithWidth ?? clamp(h * 0.17, 7, 12)) *
      rand(0.9, 1.1);
    const site = {
      id: this._nextId++,
      x,
      y,
      w,
      state: "build",
      timer: this.config.buildSeconds ?? 2.4,
      dustTimer: 0,
      glow: 0,
      participants: new Set(),
      slots: new Map(),
      monolith: null,
    };

    const monolith = {
      id: this._nextId++,
      siteId: site.id,
      x,
      y,
      h,
      w,
      seed: rand(0, 1000),
      phase: rand(0, Math.PI * 2),
      rise: 0,
      site,
    };
    site.monolith = monolith;

    this.sites.push(site);
    this.byId.set(site.id, site);
    this.monoliths.push(monolith);

    this._summon(site);
    this.game.ui?.toast?.(
      opts.toastText ?? "W krótkim czasie zebrano dużo Lush — ziemia rodzi kamienny monolit.",
      opts.toastType ?? "memorial"
    );
  }

  /** Istniejący monolit budzi się: ludzie idą tam, zamiast stawiać nowy. */
  _awakenSite(site) {
    if (!site || site.state === "build") return;
    const wasCalm = site.state === "idle" || site.state === "done";
    site.state = "gather";
    site.timer = this.config.gatherSeconds ?? 2.2;
    this._summon(site);
    if (wasCalm) {
      this.game.ui?.toast?.(
        "W tym regionie stoi już monolit — ludzie modlą się przy istniejącym kamieniu.",
        "memorial"
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* UCZESTNICY                                                          */
  /* ------------------------------------------------------------------ */

  _summon(site) {
    const ts = this.game.map.tileSize;
    const max = this.config.maxPrayers ?? 10;
    if (site.participants.size >= max) return;

    const radius = (this.config.summonRadiusTiles ?? 34) * ts;
    const minAge = this.config.minAge ?? 6;
    const candidates = [];

    for (const p of this.game.population.people) {
      if (!p.alive || p.ageYears < minAge) continue;
      if (p.monolithSiteId != null || p.memorialSiteId != null) continue;
      if (p.panicTimer > 0) continue;
      if (p.state === "flee" || p.state === "drown" || p.state === "sleep") continue;
      if (p.state === "climb" || p.state === "reclothe" || p.state === "shame") continue;
      const d = Math.abs(p.x - site.x);
      if (d > radius) continue;
      candidates.push({ p, d });
    }

    candidates.sort((a, b) => a.d - b.d);
    for (const { p } of candidates) {
      if (site.participants.size >= max) break;
      this._attach(site, p, true);
    }
  }

  _attach(site, person, summoned) {
    if (person.monolithSiteId != null) return false;
    const max = this.config.maxPrayers ?? 10;
    if (site.participants.size >= max && !site.participants.has(person.id)) {
      return false;
    }

    site.participants.add(person.id);
    person.monolithSiteId = site.id;
    person.prayOffsetX = this._assignSlot(site, person);
    person.state = "pray";
    person.stateTimer = summoned
      ? 999
      : rand(
          this.config.prayMinSeconds ?? 9,
          this.config.prayMaxSeconds ?? 20
        );
    person.partnerTarget = null;
    person.targetX = site.x + person.prayOffsetX;
    person.facing = site.x >= person.x ? 1 : -1;
    return true;
  }

  /** Miejsca w półkolu wokół monolitu — nikt nie stoi drugiemu na plecach. */
  _assignSlot(site, person) {
    const ts = this.game.map.tileSize;
    const spacing = (this.config.prayerSpacingTiles ?? 1.1) * ts;
    const index = site.slots.size;
    const rank = Math.floor(index / 2) + 1;
    const side = index % 2 === 0 ? 1 : -1;
    const jitter = rand(-0.12, 0.12) * spacing;
    const offset = side * rank * spacing + jitter;
    site.slots.set(person.id, offset);
    return offset;
  }

  /** Osoba odpoczywająca pyta, czy może dołączyć do modlitwy. */
  findPraySite(person) {
    if (!this.enabled) return null;
    if (person.isNight) return null;
    if (person.ageYears < (this.config.minAge ?? 6)) return null;
    if (person.monolithSiteId != null) return null;
    if (person.state === "flee" || person.state === "drown") return null;
    if (person.memorialSiteId != null) return null;

    const ts = this.game.map.tileSize;
    let best = null;
    let bestD = Infinity;

    for (const site of this.sites) {
      if (site.participants.size >= (this.config.maxPrayers ?? 10)) continue;
      if (site.participants.has(person.id)) continue;
      const radius =
        (site.state === "idle"
          ? this.config.idleGatherRadiusTiles ?? 24
          : this.config.gatherRadiusTiles ?? 34) * ts;
      const d = Math.abs(person.x - site.x);
      if (d > radius) continue;
      const joinChance =
        site.state === "idle"
          ? this.config.idleJoinChance ?? 0.28
          : site.state === "done"
            ? this.config.joinChance ?? 0.85
            : site.state === "gather"
              ? this.config.joinChance ?? 0.85
              : 0.5;
      if (!chance(joinChance)) continue;
      if (d < bestD) {
        bestD = d;
        best = site;
      }
    }

    if (!best) return null;
    return this._attach(best, person, false) ? best : null;
  }

  release(person) {
    if (person.monolithSiteId == null) return;
    const site = this.byId.get(person.monolithSiteId);
    if (site) {
      site.participants.delete(person.id);
      site.slots.delete(person.id);
    }
    person.monolithSiteId = null;
    person.prayOffsetX = 0;
  }

  /* ------------------------------------------------------------------ */
  /* PRZEBIEG KULTU                                                      */
  /* ------------------------------------------------------------------ */

  _updateSite(site, dt, night) {
    const monolith = site.monolith;
    const targetGlow =
      site.state === "idle"
        ? site.participants.size > 0
          ? 0.4
          : 0.12
        : 1;
    site.glow += (targetGlow - site.glow) * Math.min(1, dt * 2.6);

    if (monolith) {
      if (site.state === "build") {
        const total = Math.max(0.001, this.config.buildSeconds ?? 2.4);
        monolith.rise = clamp(monolith.rise + dt / total, 0, 1);
      } else {
        monolith.rise = 1;
      }
    }

    if (site.state === "idle") return;

    if (site.state === "gather") {
      if (night || this._panicNearby(site)) {
        // Noc albo panika przerywa obrzęd; kamień pozostaje i czeka.
        site.state = "idle";
        this._releaseAll(site);
        return;
      }
      site.timer -= dt;
      if (site.timer <= 0) {
        site.state = "done";
        site.timer = this.config.lingerSeconds ?? 9;
      }
      return;
    }

    if (site.state === "build") {
      site.dustTimer -= dt;
      if (site.dustTimer <= 0) {
        site.dustTimer = rand(0.12, 0.28);
        this.game.effects?.burst(
          site.x + rand(-site.w, site.w),
          site.y - rand(0, 5),
          "#b9ad94",
          3,
          { speed: 24, life: 0.85, size: 2.1, gravity: 55 }
        );
      }
      site.timer -= dt;
      if (site.timer <= 0) {
        if (monolith) monolith.rise = 1;
        site.state = "done";
        site.timer = this.config.lingerSeconds ?? 9;
        this.game.effects?.burst(
          site.x,
          site.y - (monolith?.h ?? 40) * 0.35,
          "#d8c49a",
          Math.round(14 + (monolith?.h ?? 40) * 0.25),
          { speed: 38, life: 1.2, size: 2.2, gravity: 120 }
        );
        this.game.ui?.toast?.(
          "Kamienny monolit wznosi się ku czci złego boga.",
          "memorial"
        );
      }
      return;
    }

    if (site.state === "done") {
      site.timer -= dt;
      if (site.timer <= 0) {
        site.state = "idle";
        // Nie rozganiamy wszystkich naraz: każdy kończy modlitwę po swojemu.
        const min = this.config.prayMinSeconds ?? 9;
        const max = this.config.prayMaxSeconds ?? 20;
        for (const id of site.participants) {
          const p = this.game.population.byId.get(id);
          if (p && p.monolithSiteId === site.id && p.state === "pray") {
            p.stateTimer = rand(min, max);
          }
        }
      }
    }
  }

  _releaseAll(site) {
    for (const id of [...site.participants]) {
      const p = this.game.population.byId.get(id);
      if (p && p.monolithSiteId === site.id) {
        p.monolithSiteId = null;
        p.prayOffsetX = 0;
      }
    }
    site.participants.clear();
    site.slots.clear();
  }

  _pruneParticipants(site) {
    for (const id of [...site.participants]) {
      const p = this.game.population.byId.get(id);
      if (!p || !p.alive) {
        site.participants.delete(id);
        site.slots.delete(id);
      }
    }
  }

  _panicNearby(site) {
    const ts = this.game.map.tileSize;
    const radius = (this.config.panicRadiusTiles ?? 16) * ts;
    for (const p of this.game.population.people) {
      if (!p.alive || p.panicTimer <= 0) continue;
      if (Math.abs(p.x - site.x) <= radius) return true;
    }
    return false;
  }

  _centerOfPopulation() {
    const people = this.game.population?.people || [];
    if (!people.length) return null;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const p of people) {
      if (!p.alive) continue;
      sx += p.x;
      sy += p.y;
      n++;
    }
    if (!n) return null;
    return { x: sx / n, y: sy / n };
  }

  /** Bezpieczne, w miarę płaskie i suche miejsce na kamień. */
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

        const row = map.surfaceRow(tx);
        const flatness =
          Math.abs(map.surfaceRow(tx - 2) - row) +
          Math.abs(map.surfaceRow(tx + 2) - row);
        if (flatness > 3) continue;

        const score = distanceFromCenter + flatness * 0.7;
        if (score < bestScore) {
          bestScore = score;
          best = tx;
        }
      }
    }

    const tx = best ?? fallback ?? center;
    return (tx + 0.5) * ts;
  }

  _isNight() {
    const a = this.game.config.agents;
    const hr = this.game.hour;
    return hr >= (a.nightStartHour ?? 21) || hr < (a.dayStartHour ?? 6);
  }

  /** Piorun może podpalić monolit w promieniu uderzenia (nie tylko ogień od sąsiednich drzew). */
  igniteAt(x, y, radius, opts = {}) {
    let count = 0;
    const ts = this.game.map.tileSize;
    const chanceToIgnite = opts.chance ?? this.config.igniteChance ?? 0.85;

    for (const m of this.monoliths) {
      if (!m || m.burning) continue;
      if (Math.abs(m.x - x) > radius + m.w * 0.5) continue;
      if (Math.abs(m.y - y) > ts * 3) continue;
      if (!chance(chanceToIgnite)) continue;
      this._igniteMonolith(m);
      count++;
    }
    return count;
  }

  _igniteMonolith(m) {
    if (m.burning) return;
    m.burning = true;
    m.burnTimer = 0;
    m.burnDuration = rand(3, 6);
    m.firePhase = rand(0, Math.PI * 2);

    // Osoby modlące się przy monolicie uciekają w panice, gdy kamień staje w ogniu.
    const site = m.site ? this.byId.get(m.site.id) : null;
    if (site) this._releaseAll(site);

    this.game.effects?.burst?.(m.x, m.y - m.h * 0.25, "#ffb347", 22, {
      speed: 36,
      life: 0.9,
      size: 2.2,
      gravity: -50,
      type: "flame",
      spread: TAU,
    });
    this.game.effects?.burst?.(m.x, m.y - m.h * 0.4, "#4b4038", 10, {
      speed: 20,
      life: 1.8,
      size: 3,
      gravity: -26,
      type: "smoke",
      spread: TAU,
    });
  }

  _destroyMonolith(monolith) {
    const site = monolith.site ? this.byId.get(monolith.site.id) : null;
    if (site) {
      this._releaseAll(site);
      this.byId.delete(site.id);
      const sIdx = this.sites.indexOf(site);
      if (sIdx >= 0) this.sites.splice(sIdx, 1);
    }
    const idx = this.monoliths.indexOf(monolith);
    if (idx >= 0) this.monoliths.splice(idx, 1);

    this.game.effects?.burst?.(monolith.x, monolith.y - monolith.h * 0.35, "#ff7a2a", 24, {
      speed: 36,
      life: 0.8,
      size: 2.4,
      gravity: -60,
      type: "flame",
      spread: TAU,
    });
    this.game.effects?.burst?.(monolith.x, monolith.y - monolith.h * 0.2, "#5b4a3e", 24, {
      speed: 26,
      life: 2.2,
      size: 3.5,
      gravity: -24,
      type: "smoke",
      spread: TAU,
    });
    const decals = this.game.effects?.decals;
    if (decals) {
      decals.push({
        x: monolith.x,
        y: monolith.y,
        w: monolith.w * 6,
        h: monolith.w * 2,
        rotation: rand(-0.2, 0.2),
        life: 24,
        maxLife: 24,
        type: "scorch",
      });
      if (decals.length > 60) decals.shift();
    }
    this.game.ui?.toast?.("Monolit spłonął. Popiół pozostaje na miejscu.", "fire");
  }
}
