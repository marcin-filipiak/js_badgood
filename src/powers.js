import { rand, clamp, chance } from "./utils.js?v=20261046-1";

export class Powers {
  constructor(game) {
    this.game = game;
    this.config = game.config.powers;
    this.list = this.config.list;
    this.selectedId = this.list[0]?.id || null;
    // Moc "uzbrojona" to ta, która czeka na kliknięcie planszy.
    // Samo podświetlenie karty (selectedId) nie wystarcza — dopóki gracz
    // nie uzbroi mocy, przeciąganie planszy ma tylko przesuwać mapę.
    this.armedId = null;
    const lush = this.config.lush || {};
    this.lushConfig = {
      start: lush.start ?? this.config.energyMax,
      capacityPerLush: lush.capacityPerLush ?? 0,
      capacityMax: lush.capacityMax ?? this.config.energyMax,
      panicPerSecond: lush.panicPerSecond ?? 0,
      panicChildFactor: lush.panicChildFactor ?? 1,
      panicElderFactor: lush.panicElderFactor ?? 1,
      deathBase: lush.deathBase ?? 0,
      deathPerYear: lush.deathPerYear ?? 0,
      deathChildFactor: lush.deathChildFactor ?? 1,
      deathElderFactor: lush.deathElderFactor ?? 1,
    };
    // Lush jest jedynym źródłem boskiej mocy: nie odradza się sam.
    // Zbierają go przerażeni ludzie, a śmierć oddaje całe żniwo naraz.
    this.totalLush = 0;
    this.energy = Math.min(this.lushConfig.start, this.config.energyMax);
    this.panicIncome = 0;
    this.panicRate = 0;
    this.harvestPulse = 0;
    this.cooldowns = new Map();
    for (const p of this.list) this.cooldowns.set(p.id, 0);
    // Siła każdej mocy: 1 = najlżejsza, wyżej = obfitszy i droższy efekt.
    this.strengths = new Map();
    for (const p of this.list) {
      this.strengths.set(p.id, this._clampStrength(p, p.strengthDefault ?? 1));
    }
    this.lastDenied = 0;
  }

  _clampStrength(power, level) {
    const max = Math.max(1, power.strengthLevels ?? 1);
    return clamp(Math.round(level), 1, max);
  }

  getStrength(idOrPower) {
    const power =
      typeof idOrPower === "string" ? this.getPower(idOrPower) : idOrPower;
    if (!power) return 1;
    return this.strengths.get(power.id) ?? this._clampStrength(power, power.strengthDefault ?? 1);
  }

  setStrength(id, level) {
    const power = this.getPower(id);
    if (!power) return false;
    this.strengths.set(power.id, this._clampStrength(power, level));
    return true;
  }

  cycleStrength(id, dir) {
    const power = this.getPower(id);
    if (!power) return false;
    const max = Math.max(1, power.strengthLevels ?? 1);
    const next = this.getStrength(power) + dir;
    this.strengths.set(power.id, clamp(next < 1 ? max : next > max ? 1 : next, 1, max));
    return true;
  }

  /** Ile Lush kosztuje rzucenie mocy przy obecnej sile. */
  castCost(power) {
    if (!power) return 0;
    const level = this.getStrength(power);
    const factor = 1 + (level - 1) * (power.costPerStrength ?? 0.45);
    return Math.max(1, Math.round(power.cost * factor));
  }

  /** Pojemność zbiornika rośnie z całym lush zebranym w ciągu gry. */
  get lushMax() {
    const cfg = this.lushConfig;
    return Math.min(
      cfg.capacityMax,
      this.config.energyMax + this.totalLush * cfg.capacityPerLush
    );
  }

  get lush() {
    return this.energy;
  }

  _ageFactor(ageYears, childFactor, elderFactor) {
    const agents = this.game.config.agents;
    if (ageYears < agents.childAge) return childFactor;
    if (ageYears >= agents.elderAge) return elderFactor;
    return 1;
  }

  /** Ile lush na sekundę sączy jedna przerażona osoba. */
  panicRateFor(person) {
    const cfg = this.lushConfig;
    return (
      cfg.panicPerSecond *
      this._ageFactor(person.ageYears, cfg.panicChildFactor, cfg.panicElderFactor)
    );
  }

  /** Jednorazowe żniwo po śmierci — im więcej przeżytych lat, tym więcej. */
  deathLushFor(person) {
    const cfg = this.lushConfig;
    const value =
      (cfg.deathBase + Math.max(0, person.ageYears) * cfg.deathPerYear) *
      this._ageFactor(person.ageYears, cfg.deathChildFactor, cfg.deathElderFactor);
    return Math.max(0, value);
  }

  _addLush(amount) {
    if (!(amount > 0)) return 0;
    this.game.monoliths?.recordLush?.(amount);
    const before = this.energy;
    // Cały zebrany Lush rozwija zbiornik, nawet jeśli część nadmiaru nie
    // zmieści się w nim od razu. Dzięki temu żniwo po śmierci nigdy nie
    // przepada w całości, gdy pasek jest pełny.
    this.totalLush += amount;
    this.energy = Math.min(this.lushMax, before + amount);
    return this.energy - before;
  }

  /** Wywoływane przez Population.kill; zwraca faktycznie zebrany lush. */
  grantDeathLush(person) {
    const gained = this._addLush(this.deathLushFor(person));
    if (gained >= 1) {
      this.harvestPulse = 1;
      this.game.effects?.burst(
        person.x,
        person.y - person.h * 0.55,
        "#ffd27a",
        10,
        {
          speed: 16,
          life: 1.6,
          size: 1.7,
          gravity: -65,
          angle: -Math.PI / 2,
          spread: Math.PI * 1.1,
          type: "dot",
        }
      );
    }
    return gained;
  }

  get selected() {
    return this.list.find((p) => p.id === this.selectedId) || this.list[0];
  }

  getPower(id) {
    return this.list.find((p) => p.id === id) || null;
  }

  get armed() {
    return this.armedId ? this.getPower(this.armedId) : null;
  }

  select(id) {
    if (this.getPower(id)) this.selectedId = id;
  }

  arm(id) {
    if (!this.getPower(id)) return false;
    this.selectedId = id;
    this.armedId = id;
    return true;
  }

  disarm() {
    this.armedId = null;
  }

  toggleArm(id) {
    if (this.armedId === id) {
      this.disarm();
      return false;
    }
    return this.arm(id);
  }

  update(dt) {
    const people = this.game.population?.people || [];
    let income = 0;
    for (const person of people) {
      if (person.alive && person.panicTimer > 0) {
        income += this.panicRateFor(person) * dt;
      }
    }
    const gained = this._addLush(income);
    const blend = Math.min(1, dt * 2.5);
    this.panicIncome += ((dt > 0 ? income / dt : 0) - this.panicIncome) * blend;
    this.panicRate += ((dt > 0 ? gained / dt : 0) - this.panicRate) * blend;
    this.harvestPulse = Math.max(0, this.harvestPulse - dt * 2);
    for (const [id, value] of this.cooldowns) {
      this.cooldowns.set(id, Math.max(0, value - dt));
    }
    this.lastDenied = Math.max(0, this.lastDenied - dt);
  }

  cooldownFraction(power) {
    const remaining = this.cooldowns.get(power.id) || 0;
    return power.cooldown > 0 ? clamp(remaining / power.cooldown, 0, 1) : 0;
  }

  canCast(power) {
    if (!power) return { ok: false, reason: "Brak mocy." };
    if (this.energy < this.castCost(power)) return { ok: false, reason: "Za mało Lush." };
    if ((this.cooldowns.get(power.id) || 0) > 0.01) {
      return { ok: false, reason: "Moc jeszcze się odradza." };
    }
    return { ok: true };
  }

  castSelected(worldX, worldY) {
    return this.cast(this.selectedId, worldX, worldY);
  }

  castArmed(worldX, worldY) {
    if (!this.armedId) return false;
    return this.cast(this.armedId, worldX, worldY);
  }

  cast(id, worldX, worldY) {
    const power = this.getPower(id);
    const check = this.canCast(power);
    if (!check.ok) {
      if (this.lastDenied <= 0) {
        this.game.ui.toast(check.reason, "death");
        this.lastDenied = 1.5;
      }
      return false;
    }

    this.energy -= this.castCost(power);
    this.cooldowns.set(power.id, power.cooldown);
    const ts = this.game.map.tileSize;
    const groundY = this.game.map.groundYAtWorldX(worldX);
    const level = this.getStrength(power);

    switch (power.id) {
      case "lightning":
        this._castLightning(power, worldX, Math.min(worldY, groundY), groundY, ts, level);
        break;
      case "rain":
        this._castRain(power, worldX, groundY, level);
        break;
      case "wind":
        this._castWind(power, worldX, groundY, level);
        break;
      case "earthquake":
        this._castEarthquake(power, worldX, worldY, groundY, ts, level);
        break;
      default:
        // Nowe moce mogą być podpinane tutaj; domyślnie efekt w miejscu celu.
        this.game.effects.burst(worldX, worldY, power.color || "#fff", 20, { speed: 60 });
        break;
    }
    return true;
  }

  _castLightning(power, worldX, worldY, groundY, ts, level = 1) {
    const strikeX = worldX;
    const strikeY = groundY;
    const radiusScale = 1 + (level - 1) * (power.radiusPerStrength ?? 0.35);
    const radius = power.radius * ts * radiusScale;
    this.game.effects.lightning(strikeX, strikeY, radius, level);
    this.game.screenFlash = 1;
    this.game.camera.shake(7 + level * 2, 0.35 + level * 0.05);
    this.game.audio.thunder();

    const killedNames = [];
    let lushGained = 0;

    // Najpierw pożar: mieszkańcy zdążą wybiec z płonącej chaty, zamiast
    // zginąć od samego uderzenia.
    const sheltered = new Set();
    const housesIgnited = this.game.housing
      ? this.game.housing.igniteAt(strikeX, strikeY, radius, { sheltered })
      : 0;

    for (const person of [...this.game.population.people]) {
      if (!person.alive) continue;
      if (sheltered.has(person.id)) continue;
      const dx = person.x - strikeX;
      const dy = person.y - strikeY;
      if (Math.abs(dx) <= radius && dy > -ts * 3.2 && dy < ts * 2.2) {
        killedNames.push(person.name);
        lushGained += this.game.population.kill(person, "piorun", false) || 0;
      }
    }
    const lushText = lushGained >= 1 ? ` +${Math.round(lushGained)} Lush` : "";

    const ignited = this.game.vegetation
      ? this.game.vegetation.igniteAt(strikeX, strikeY, radius)
      : 0;

    // Piorun podpala też pola uprawne wokół miejsca uderzenia.
    const cropsIgnited = this.game.crops
      ? this.game.crops.igniteAt(strikeX, strikeY, radius * 1.15, {
          chance: 0.9,
        })
      : 0;

    if (killedNames.length === 0) {
      if (ignited > 0) {
        this.game.ui.toast("Grom podpala las.", "fire");
      } else if (housesIgnited > 0) {
        this.game.ui.toast("Grom podpala chatę.", "fire");
      } else if (cropsIgnited > 0) {
        this.game.ui.toast("Grom trawi uprawy.", "fire");
      } else {
        this.game.ui.toast("Grom uderza w jałową ziemię.", "");
      }
    } else if (killedNames.length === 1) {
      const fire = ignited > 0 ? " Las staje w płomieniach." : "";
      this.game.ui.toast(`${killedNames[0]} ginie od pioruna.${fire}${lushText}`, "death");
    } else {
      const fire = ignited > 0 ? " i podpala las" : "";
      this.game.ui.toast(
        `Grom zabija ${killedNames.length} ${this._peopleWord(killedNames.length)}${fire}.${lushText}`,
        "death"
      );
    }

    // Panika w okolicy.
    for (const person of this.game.population.people) {
      if (Math.abs(person.x - strikeX) < ts * 16) {
        person.panicTimer = Math.max(person.panicTimer, rand(4, 9));
      }
    }
  }

  _peopleWord(count) {
    if (count === 1) return "osobę";
    const last = count % 10;
    const tens = count % 100;
    if (last >= 2 && last <= 4 && !(tens >= 12 && tens <= 14)) return "osoby";
    return "osób";
  }

  _castRain(power, worldX, groundY, level = 1) {
    const radiusScale = 1 + (level - 1) * (power.radiusPerStrength ?? 0.25);
    const durationScale = 1 + (level - 1) * (power.durationPerStrength ?? 0.2);
    this.game.weather.spawnRain(worldX, groundY, {
      ...power,
      strength: level,
      radius: power.radius * radiusScale,
      duration: power.duration * durationScale,
    });
    this.game.ui.toast(
      level >= 3
        ? "Oberwanie chmury zalewa dolinę. Woda rwie domy i plony."
        : level === 2
          ? "Ciężka ulewa spada na dolinę..."
          : "Lekki deszcz siąpi nad doliną. Kałuże podlewają ziemię.",
      "rain"
    );
    this.game.audio.rainBurst();
  }

  _castWind(power, worldX, groundY, level = 1) {
    this.game.wind?.spawn(worldX, groundY, power, level);
    this.game.audio.windBurst?.(level);
    if (level >= 3) {
      this.game.camera.shake(5, 0.8);
      this.game.ui.toast("Huragan uderza w dolinę.", "rain");
    } else if (level === 2) {
      this.game.camera.shake(2.5, 0.5);
      this.game.ui.toast("Silny wiatr zrywa się nad doliną.", "rain");
    } else {
      this.game.ui.toast("Lekki wiaterek muska dolinę.", "rain");
    }
  }

  _castEarthquake(power, worldX, worldY, groundY, ts, level = 1) {
    const game = this.game;
    const map = game.map;
    const w = map.width;
    const radiusScale = 1 + (level - 1) * (power.radiusPerStrength ?? 0.3);
    const depthScale = 1 + (level - 1) * (power.depthPerStrength ?? 0.42);
    const radiusTiles = Math.max(1, power.radius * radiusScale);
    const depthTiles = Math.max(1, Math.round(power.depth * depthScale));
    const radiusPx = radiusTiles * ts;
    const cx = clamp(Math.floor(worldX / ts), 0, w - 1);
    const cy = clamp(Math.floor(worldY / ts), 0, map.height - 1);
    const mode = map.isSolidTile(cx, cy) ? "dig" : "fill";

    const reach = Math.ceil(radiusTiles + 1);
    const tx0 = clamp(cx - reach, 0, w - 1);
    const tx1 = clamp(cx + reach, 0, w - 1);
    const oldSurfaces = new Map();
    let changed = 0;

    const oldCenterY = map.surfaceRow(cx) * ts;

    for (let tx = tx0; tx <= tx1; tx++) {
      const u = Math.abs(tx - cx) / radiusTiles;
      if (u > 1) continue;
      const amount = Math.max(0, Math.round(depthTiles * (1 - u * u)));
      if (amount <= 0) continue;
      const surface = map.surfaceRow(tx);
      oldSurfaces.set(tx, surface);
      if (mode === "dig") {
        let removed = 0;
        for (let ty = surface; ty < map.height && removed < amount && map.solid[ty * w + tx]; ty++) {
          if (map.setTile(tx, ty, " ")) removed++;
        }
        if (removed > 0) changed++;
      } else {
        const start = Math.max(0, surface - amount);
        for (let ty = start; ty < surface; ty++) {
          if (!map.solid[ty * w + tx]) {
            if (map.setTile(tx, ty, "d")) changed++;
          }
        }
      }
    }

    // Nowy wierzch wykopanej dziury też jest ziemią, nie trawą: jeśli kolumna
    // zapadła się, odsłania się nasyp, nie zielona darń. Wypełniona ziemia
    // już używa „d” z zalożenia.
    if (mode === "dig") {
      for (let tx = tx0; tx <= tx1; tx++) {
        const old = oldSurfaces.get(tx);
        if (old == null) continue;
        const ns = map.surfaceRow(tx);
        if (ns === old) continue;
        const ch = map.tileAt(tx, ns);
        const def = map.legend[ch] || map.legend[" "];
        if (def && def.surface && def.surface !== "rock" && ch !== "d") {
          map.setTile(tx, ns, "d");
        }
      }
      map.recomputeSurface(tx0, tx1);
    } else {
      map.recomputeSurface(tx0, tx1);
    }
    game.water?.terrainChanged?.(tx0, tx1);

    const newCenterY = map.surfaceRow(cx) * ts;
    const effectY = mode === "dig" ? oldCenterY : newCenterY;

    // Dusza luciu działa jak przy wodzie: zaburzony teren może pogrzebać osoby
    // w zasięgu. Najpierw przy wypełnianiu, bo tam ziemia pojawi się wokół
    // istniejącego ciała. Przy zapadaniu zabranie wierzchniej warstwy zabija
    // tylko część pechowców zIGNED w centrum wstrząsu.
    const killedNames = [];
    let lushGained = 0;
    if (mode === "fill") {
      for (const person of [...game.population.people]) {
        if (!person.alive) continue;
        if (Math.abs(person.x - worldX) > radiusPx + ts * 2) continue;
        if (game.map.rectCollides(person.x, person.y, person.w, person.h)) {
          killedNames.push(person.name);
          lushGained += game.population.kill(person, "zasypanie", false) || 0;
        }
      }
    } else {
      for (const person of [...game.population.people]) {
        if (!person.alive) continue;
        const u = Math.abs(person.x - worldX) / radiusPx;
        if (u > 0.6) continue;
        const column = map.surfaceRow(Math.floor(person.x / ts));
        const old = oldSurfaces.get(Math.floor(person.x / ts));
        if (old == null || old === column) continue;
        if (chance(0.35 + (level - 1) * 0.12)) {
          killedNames.push(person.name);
          lushGained += game.population.kill(person, "zasypanie", false) || 0;
        }
      }
    }

    for (const person of game.population.people) {
      if (Math.abs(person.x - worldX) < ts * 14) {
        person.panicTimer = Math.max(person.panicTimer, rand(4, 9));
      }
    }

    game.camera.shake(6 + level * 3, 0.55 + level * 0.1);
    game.effects.quake?.(worldX, effectY, radiusPx, mode, level);
    game.audio.quake?.(level);

    const lushText = lushGained >= 1 ? ` +${Math.round(lushGained)} Lush` : "";
    if (mode === "fill") {
      if (killedNames.length === 0) {
        game.ui.toast(
          changed > 0 ? "Ziemia sypie się z nieba." : "Brak miejsca na dosypanie.",
          "rain"
        );
      } else if (killedNames.length === 1) {
        game.ui.toast(`${killedNames[0]} ginie pod zwałami ziemi.${lushText}`, "death");
      } else {
        game.ui.toast(
          `Ziemia zasypuje ${killedNames.length} ${this._peopleWord(killedNames.length)}.${lushText}`,
          "death"
        );
      }
    } else {
      if (killedNames.length === 0) {
        game.ui.toast(
          changed > 0 ? "Ziemia zapada się z hukiem." : "Ziemia nie chce ustąpić.",
          "death"
        );
      } else if (killedNames.length === 1) {
        game.ui.toast(`${killedNames[0]} ginie pod zwałami ziemi.${lushText}`, "death");
      } else {
        game.ui.toast(
          `Ziemia zasypuje ${killedNames.length} ${this._peopleWord(killedNames.length)}.${lushText}`,
          "death"
        );
      }
    }

    // Trzęsienie ziemi niszczy drabiny oparte na wstrząśniętym podłożu.
    const ladders = game.ladders;
    if (ladders) {
      for (const ladder of [...(ladders.ladders || [])]) {
        const tx = ladder.wallTx != null ? ladder.wallTx : Math.floor(ladder.x / ts);
        if (tx < tx0 || tx > tx1) continue;
        const idx = ladders.ladders.indexOf(ladder);
        if (idx >= 0) ladders.ladders.splice(idx, 1);
        if (ladders.byWall) ladders.byWall.delete(`${ladder.wallTx}:${ladder.topRow}`);
        game.effects?.burst?.(ladder.x, ladder.baseY, "#c9a06a", 9, {
          speed: 22, life: 0.7, size: 1.8, gravity: 140, type: "dot",
        });
      }
      for (const site of [...(ladders.sites || [])]) {
        const tx = site.wallTx != null ? site.wallTx : Math.floor(site.x / ts);
        if (tx < tx0 || tx > tx1) continue;
        for (const person of game.population.people) {
          if (person.ladderBuild?.siteId === site.id) {
            ladders.cancelProject(person, { silent: true });
            person._climb = null;
          }
        }
        const idx = ladders.sites.indexOf(site);
        if (idx >= 0) ladders.sites.splice(idx, 1);
      }
    }

    // Nic nie może zostać wisieć w powietrzu: przesunąć drzewa, uprawy i chaty,
    // których ziemia się pod nimi zmieniła.
    const settle = (tx) => map.surfaceRow(tx) * ts;
    for (const tree of game.vegetation?.trees || []) {
      if (tree.tx < tx0 || tree.tx > tx1) continue;
      tree.y = settle(tree.tx) + 1;
    }
    for (const stump of game.vegetation?.stumps || []) {
      // Poświęcamy stare pniaki tylko wtedy, gdy ich kolumna widocznie zmieniła
      // powierzchnię; i tak są krótkotrwałe, ale nie chcemy, by wisiały.
      const tx = Math.floor(stump.x / ts);
      if (tx < tx0 || tx > tx1) continue;
      stump.y = settle(tx);
    }
    for (const plot of game.crops?.plots || []) {
      const tx = plot.tx ?? Math.floor(plot.x / ts);
      if (tx < tx0 || tx > tx1) continue;
      plot.y = settle(tx);
    }
    for (const site of game.housing?.sites || []) {
      const tx = site.tx ?? Math.floor(site.x / ts);
      if (tx < tx0 || tx > tx1) continue;
      site.y = settle(tx);
    }
    for (const house of game.housing?.houses || []) {
      const tx = Math.floor(house.x / ts);
      if (tx < tx0 || tx > tx1) continue;
      house.y = settle(tx);
    }
    for (const monolith of game.monoliths?.sites || []) {
      const tx = Math.floor(monolith.x / ts);
      if (tx < tx0 || tx > tx1) continue;
      const ny = settle(tx);
      const delta = ny - monolith.y;
      monolith.y = ny;
      if (monolith.monolith) monolith.monolith.y = ny;
    }

    game.renderer.refreshTerrainRegion?.(tx0, 0, tx1, map.height - 1);
  }
}
