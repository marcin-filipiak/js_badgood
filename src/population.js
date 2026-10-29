import { Person } from "./person.js?v=20261046-1";
import { rand, randInt, chance, choice, distance, clamp, ageGroup } from "./utils.js?v=20261046-1";

export class Population {
  constructor(game) {
    this.game = game;
    this.map = game.map;
    this.water = game.water;
    this.config = game.config.agents;
    this.theme = game.config.theme;
    this.names = game.config.names;
    this.people = [];
    this.byId = new Map();
    this.nextId = 1;
    this.scanTimer = 0;
    this.birthsToday = 0;
    this.currentDay = 1;
    this.usedNames = new Set();
    this.stats = {
      births: 0,
      deaths: 0,
      godKills: 0,
      drownings: 0,
      buried: 0,
      oldAge: 0,
      conceptions: 0,
      starvations: 0,
    };
  }

  spawnInitial() {
    const start = this.game.config.world.startPopulation;
    const spawn = this.map.spawn;
    const points = [];

    for (let i = 0; i < start * 8 && points.length < start; i++) {
      const tx = Math.round(spawn.x + rand(-spawn.radius, spawn.radius));
      if (tx < 3 || tx >= this.map.width - 3) continue;
      const info = this.water.columnInfo(tx);
      if (info.depth > 2) continue;
      const ts = this.map.tileSize;
      const x = (tx + 0.5) * ts;
      if (points.some((p) => Math.abs(p.x - x) < ts * 0.8)) continue;
      points.push({ x, y: this.map.surfaceRow(tx) * ts });
    }

    const roll = () => Math.random();
    for (const point of points) {
      const r = roll();
      let age;
      if (r < 0.23) age = rand(1, this.config.childAge - 1);
      else if (r < 0.72) age = rand(this.config.fertileAge, 42);
      else age = rand(this.config.elderAge, Math.min(78, this.config.lifespanMax - 1));

      const sex = chance(0.5) ? "m" : "f";
      const lifespan = Math.max(
        age + rand(3, 18),
        rand(this.config.lifespanMin, this.config.lifespanMax)
      );
      this.createPerson({ x: point.x, y: point.y, age, sex, lifespan });
    }
  }

  createPerson(opts) {
    const sex = opts.sex || (chance(0.5) ? "m" : "f");
    const ageYears = opts.age ?? opts.ageYears ?? 0;
    const id = this.nextId++;
    const person = new Person({
      id,
      name: opts.name || this._randomName(sex),
      sex,
      ageYears,
      x: opts.x,
      y: opts.y,
      config: this.config,
      map: this.map,
      water: this.water,
      population: this,
      gravity: this.game.config.world.gravity,
      skinTone: choice(this.theme.skinTones),
      hairColor: choice(this.theme.hairColors),
      clothesColor: choice(this.theme.clothes),
      motherId: opts.motherId ?? null,
      fatherId: opts.fatherId ?? null,
      homeId: opts.homeId ?? null,
      lifespan: opts.lifespan,
    });
    if (opts.lifespan != null) person.lifespan = opts.lifespan;

    // Upewnij się, że postać nie stoi w skale.
    if (this.map.rectCollides(person.x, person.y, person.w, person.h)) {
      const ty = this.map.findGroundBelow(person.x, person.y - 4, 6);
      if (ty != null) person.y = ty * this.map.tileSize;
    }

    this.people.push(person);
    this.byId.set(id, person);
    if (person.homeId != null) {
      this.game.housing?.addResident(person, person.homeId);
    }
    return person;
  }

  _randomName(sex) {
    const pool = sex === "m" ? this.names.male : this.names.female;
    for (let i = 0; i < 10; i++) {
      const name = pool[randInt(0, pool.length - 1)];
      if (!this.usedNames.has(name)) {
        this.usedNames.add(name);
        return name;
      }
    }
    return choice(pool);
  }

  get aliveCount() {
    return this.people.length;
  }

  update(dt, game) {
    const day = game.day;
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.birthsToday = 0;
    }

    const hour = game.hour;
    for (const person of this.people) person.setHour(hour);
    // Kopia, bo śmierć może usuwać osoby z listy w trakcie iteracji.
    // Bufor jest współdzielony, żeby nie alokować tablicy co tick.
    const list = this._updateList || (this._updateList = []);
    list.length = 0;
    for (const person of this.people) list.push(person);
    for (const person of list) person.update(dt, game);

    // Skanowanie par (nie każdego ticka, dla wydajności).
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = 0.5;
      this._scanCouples();
    }
  }

  _scanCouples() {
    if (this.people.length >= this.game.config.world.maxAgents) return;
    if (this.birthsToday >= this.config.maxBirthsPerDay) return;

    const ts = this.map.tileSize;
    const adults = this.people.filter((p) => p.isAdult && p.ageYears < this.config.fertilityEnd);
    const rate = this.config.conceptionChancePerSecond;

    for (let i = 0; i < adults.length; i++) {
      const a = adults[i];
      for (let j = i + 1; j < adults.length; j++) {
        const b = adults[j];
        if (a.sex === b.sex) continue;
        const female = a.sex === "f" ? a : b;
        const male = a.sex === "m" ? a : b;
        if (!female.isFertileFemale || !male.isFertileMale) continue;
        if (female.state === "drown" || male.state === "drown") continue;
        if (female.state === "sleep" || male.state === "sleep") continue;
        if (female.state === "mourn" || male.state === "mourn") continue;
        if (distance(a.x, a.y, b.x, b.y) > ts * 2.1) continue;
        const p = 1 - Math.exp(-rate * 0.5);
        if (!chance(p)) continue;

        female.pregnancyDays = this.config.gestationDays;
        female.partnerCooldownDays = this.config.partnerCooldownDays;
        female.fatherCandidateId = male.id;
        female.partnerId = male.id;
        male.partnerCooldownDays = this.config.partnerCooldownDays;
        male.partnerId = female.id;
        this.stats.conceptions++;
        if (female.state === "social") {
          female.state = "idle";
          female.socialTimer = 0;
        }
        if (male.state === "social") {
          male.state = "idle";
          male.socialTimer = 0;
        }
        return;
      }
    }
  }

  giveBirth(mother) {
    if (!mother.alive) return;
    if (this.people.length >= this.game.config.world.maxAgents) {
      mother.birthCooldownDays = this.config.birthCooldownDays;
      return;
    }

    const ts = this.map.tileSize;
    const babySex = chance(0.5) ? "m" : "f";
    let x = mother.x + (chance(0.5) ? -1 : 1) * ts * 0.7;
    x = clamp(x, ts * 3, this.map.pixelWidth - ts * 3);
    let y = mother.y;
    if (this.map.rectCollides(x, y, this.config.width, this.config.height * 0.5)) {
      x = mother.x;
    }
    const baby = this.createPerson({
      x,
      y,
      age: 0,
      sex: babySex,
      motherId: mother.id,
      fatherId: mother.fatherCandidateId ?? null,
      homeId: mother.homeId,
    });
    baby.facing = mother.facing;
    mother.fatherCandidateId = null;

    mother.birthCooldownDays = this.config.birthCooldownDays;
    this.birthsToday++;
    this.stats.births++;

    this.game.effects.burst(baby.x, baby.y - 14, "#ffe3a3", 14, { speed: 32, life: 1.1, size: 2 });
    this.game.ui.toast(
      babySex === "f"
        ? `Na świat przyszła <strong>${baby.name}</strong>.`
        : `Na świat przyszedł <strong>${baby.name}</strong>.`,
      "birth"
    );
    this.game.audio.birth();
  }

  kill(person, cause = "starość", notify = true) {
    if (!person.alive) return 0;
    person.alive = false;
    person.causeOfDeath = cause;
    this.byId.delete(person.id);
    const index = this.people.indexOf(person);
    if (index >= 0) this.people.splice(index, 1);

    this.stats.deaths++;
    this.game.housing?.release(person);
    this.game.ladders?.release(person);
    this.game.crops?.release(person);
    this.game.memorials?.release(person);
    this.game.monoliths?.release(person);
    this.game.memorials?.recordDeath(person, cause);
    // Śmierć oddaje całe nagromadzone życie jako jednorazowe żniwo Lush.
    const lushGain = this.game.powers?.grantDeathLush(person) || 0;
    const lushSuffix =
      lushGain >= 1
        ? ` <span class="lush-gain">+${Math.round(lushGain)} Lush</span>`
        : "";
    let label;
    switch (cause) {
      case "utonięcie":
        this.stats.drownings++;
        this.stats.godKills++;
        label = `${person.name} tonie w wodzie.${lushSuffix}`;
        this.game.effects.drown(person.x, person.y - person.h * 0.4, person.h);
        if (notify) this.game.ui.toast(label, "death");
        this.game.audio.splash();
        break;
      case "zasypanie":
        this.stats.buried = (this.stats.buried || 0) + 1;
        this.stats.godKills++;
        label = `${person.name} ginie pod zwałami ziemi.${lushSuffix}`;
        this.game.effects.burst(person.x, person.y - person.h * 0.4, "#c9a06a", 20, {
          speed: 28, life: 1.2, size: 2, gravity: 180,
        });
        this.game.effects.burst(person.x, person.y - person.h * 0.4, "#6b4a2f", 14, {
          speed: 18, life: 0.9, size: 1.6, gravity: 260,
        });
        if (notify) this.game.ui.toast(label, "death");
        break;
      case "piorun":
        this.stats.godKills++;
        label = `${person.name} ginie od pioruna.${lushSuffix}`;
        this.game.effects.burst(person.x, person.y - person.h * 0.5, "#ffd27a", 28, {
          speed: 90,
          life: 0.8,
          size: 2.4,
          gravity: 260,
        });
        if (notify) this.game.ui.toast(label, "death");
        break;
      case "starość":
        this.stats.oldAge++;
        label = `${person.name} umiera ze starości (${person.age} lat).${lushSuffix}`;
        this.game.effects.burst(person.x, person.y - person.h * 0.4, "#cbb59a", 12, {
          speed: 22,
          life: 1.6,
          size: 2,
          gravity: -10,
        });
        if (notify && (this.people.length < 40 || chance(0.35))) this.game.ui.toast(label, "");
        break;
      case "głód":
        this.stats.starvations++;
        label = `${person.name} umiera z głodu.${lushSuffix}`;
        this.game.effects.burst(person.x, person.y - person.h * 0.35, "#a89a7a", 10, {
          speed: 18,
          life: 1.4,
          size: 1.8,
          gravity: -6,
        });
        if (notify) this.game.ui.toast(label, "death");
        break;
      case "przepaść":
        label = `${person.name} znika w otchłani.${lushSuffix}`;
        if (notify) this.game.ui.toast(label, "death");
        break;
      default:
        label = `${person.name} umiera.${lushSuffix}`;
        if (notify) this.game.ui.toast(label, "death");
    }
    return lushGain;
  }

  /** Zwraca najbliższą osobę w punkcie ekranu/świata (dla tooltipa). */
  findAt(worldX, worldY) {
    let best = null;
    for (const p of this.people) {
      if (p.sleepIndoors) continue;
      const lying = p.state === "sleep";
      const halfW = lying ? Math.max(p.w / 2 + 3, p.h * 0.55) : p.w / 2 + 3;
      const top = lying ? p.y - p.h * 0.55 : p.y - p.h - 3;
      if (
        worldX > p.x - halfW &&
        worldX < p.x + halfW &&
        worldY > top &&
        worldY < p.y + 3
      ) {
        const centerY = lying ? p.y - p.h * 0.2 : p.y - p.h / 2;
        const d = Math.abs(worldX - p.x) + Math.abs(worldY - centerY);
        if (!best || d < best.d) best = { person: p, d };
      }
    }
    return best ? best.person : null;
  }

  findNearestFertile(person, maxTiles = 24) {
    if (person.sex === "f" && !person.isFertileFemale) return null;
    if (person.sex === "m" && person.partnerCooldownDays > 0) return null;
    let best = null;
    let bestDist = Infinity;
    const max = maxTiles * this.map.tileSize;
    for (const other of this.people) {
      if (other === person || !other.isAdult || other.sex === person.sex) continue;
      if (person.sex === "m" && !other.isFertileFemale) continue;
      if (person.sex === "f" && !other.isFertileMale) continue;
      const d = distance(person.x, person.y, other.x, other.y);
      if (d < max && d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    return best;
  }

  findPartner(person) {
    return this.findNearestFertile(person, 26);
  }

  counts() {
    let children = 0;
    let adults = 0;
    let elders = 0;
    for (const p of this.people) {
      const g = ageGroup(p.ageYears, this.config);
      if (g === "child") children++;
      else if (g === "adult") adults++;
      else elders++;
    }
    return { children, adults, elders };
  }
}
