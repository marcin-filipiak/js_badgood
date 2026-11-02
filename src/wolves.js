import { clamp, rand, randInt, chance } from "./utils.js?v=20261046-5";

/**
 * Wataha wilków.
 *
 * Co kilka nocy z lasu wychodzi wataha wilków. Trzymają się razem: lider
 * wybiera kierunek, a reszta idzie za nim w luźnym szyku. Wilki brodzą w wodzie
 * i mogą w niej utonąć, giną od pioruna i pod zwałami ziemi. Podmuch
 * wiatru kładzie je na ziemi — wtedy nie ruszają się, dopóki wiatr nie
 * ucichnie. Gdy księżyc jest w najwyższym punkcie nieba, czasem któryś
 * z wilków wyje.
 */
export class Wolves {
  constructor(game) {
    this.game = game;
    this.config = game.config.wolves || {};
    this.map = game.map;
    this.wolves = [];
    this.pack = null;
    this.time = 0;
    this._nextId = 1;
    this._nextPackId = 1;
    this._wasNight = false;
    this._wasZenith = false;
    this._howlTimer = -1;
    this._deathToastTimer = 0;
    // Wataha nie wychodzi co noc: kolejne noce są losowo pomijane.
    this._nightCount = 0;
    this._nextPackNight = randInt(
      this.config.firstNightMin ?? 1,
      this.config.firstNightMax ?? 2
    );
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get aliveCount() {
    let count = 0;
    for (const wolf of this.wolves) if (wolf.alive) count++;
    return count;
  }

  _isNight() {
    const agents = this.game.config.agents || {};
    const start = this.config.spawnHour ?? agents.nightStartHour ?? 21;
    const end = this.config.despawnHour ?? agents.dayStartHour ?? 6;
    const hour = this.game.hour;
    return hour >= start || hour < end;
  }

  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
    this._deathToastTimer = Math.max(0, this._deathToastTimer - dt);

    const night = this._isNight();
    if (night && !this._wasNight) {
      this._nightCount++;
      if (this._nightCount >= this._nextPackNight) this._startNight();
    }
    if (!night && this._wasNight) this._endNight();
    this._wasNight = night;

    this._updateCorpses(dt);
    if (this.pack) this._updatePack(dt);
    if (this.pack && !this.pack.leaving) this._scarePeople();
    this._updateHowl(dt, night);
  }

  /* ------------------------------------------------------------------ */
  /* POJAWIANIE SIĘ I ODCHODZENIE                                        */
  /* ------------------------------------------------------------------ */

  _startNight() {
    const cfg = this.config;
    this._spawnPack();
    // Po każdej watahy nastaje kilka cichych nocy, zanim wilki wrócą.
    const gap = randInt(cfg.nightGapMin ?? 2, cfg.nightGapMax ?? 4);
    this._nextPackNight = this._nightCount + gap;
  }

  _endNight() {
    if (!this.pack) return;
    this.pack.leaving = true;
  }

  _spawnPack() {
    const cfg = this.config;
    const ts = this.map.tileSize;
    this.wolves.length = 0;

    const count = randInt(cfg.packSizeMin ?? 3, cfg.packSizeMax ?? 5);
    const baseX = this._findSpawnX();
    const mid = (count - 1) / 2;
    const spacing = (cfg.spacingTiles ?? 1.15) * ts;

    const pack = {
      id: this._nextPackId++,
      members: [],
      leader: null,
      targetX: null,
      retargetTimer: 0,
      leaving: false,
      spawnX: baseX,
    };

    for (let i = 0; i < count; i++) {
      const x = clamp(
        baseX + (i - mid) * spacing,
        ts * 0.6,
        this.map.pixelWidth - ts * 0.6
      );
      const y = this.map.groundYAtWorldX(x);
      const wolf = {
        isWolf: true,
        id: this._nextId++,
        x,
        y,
        vx: 0,
        facing: chance(0.5) ? 1 : -1,
        h: cfg.height ?? 15,
        w: cfg.width ?? 26,
        alive: true,
        state: "walk",
        walkTime: rand(0, 8),
        drownTimer: 0,
        waterDepth: 0,
        inWater: false,
        blockedTimer: 0,
        deathTimer: 0,
        fade: 1,
        followOffset: 0,
      };
      pack.members.push(wolf);
      this.wolves.push(wolf);
    }

    const leaderIndex = Math.floor(count / 2);
    pack.leader = pack.members[leaderIndex];
    for (let i = 0; i < count; i++) {
      pack.members[i].followOffset = (i - leaderIndex) * spacing;
    }

    this.pack = pack;
    this._howlTimer = -1;

    if (cfg.announce !== false) {
      this.game.ui?.toast?.(
        count === 1
          ? "Samotny wilk wychodzi z lasu..."
          : `Wataha ${count} wilków wychodzi z lasu...`,
        ""
      );
    }
  }

  _findSpawnX() {
    const cfg = this.config;
    const map = this.map;
    const ts = map.tileSize;
    const camera = this.game.camera;
    const minX = ts * 2;
    const maxX = map.pixelWidth - ts * 2;
    let best = null;

    for (let attempt = 0; attempt < 24; attempt++) {
      let x;
      if (camera && camera.viewW) {
        const halfView = (camera.viewW / Math.max(0.35, camera.zoom)) * 0.42;
        x = camera.cx + rand(-halfView, halfView);
      } else {
        x = rand(minX, maxX);
      }
      x = clamp(x, minX, maxX);

      const y = map.groundYAtWorldX(x);
      if (y <= ts || y >= map.pixelHeight) continue;

      // Nie chcemy, żeby wataha pojawiała się w głębokiej wodzie i od razu
      // tonęła. Płytka kałuża jest w porządku.
      const water = this.game.water?.waterInfoAtX(x);
      if (water && water.depth > (cfg.height ?? 15) * 1.1) continue;

      best = x;
      // Pierwsze sensowne miejsce zwykle wystarcza; czasem szukamy dalej,
      // żeby wataha nie wychodziła wciąż w tym samym punkcie.
      if (chance(0.65)) break;
    }

    return best ?? clamp(camera?.cx ?? map.pixelWidth / 2, minX, maxX);
  }

  /* ------------------------------------------------------------------ */
  /* RUCH WATAHY                                                         */
  /* ------------------------------------------------------------------ */

  _updatePack(dt) {
    const pack = this.pack;
    if (!pack) return;

    if (pack.leaving) return;

    const alive = this.wolves.filter((wolf) => wolf.alive);
    if (alive.length === 0) return;

    let leader = pack.leader;
    if (!leader || !leader.alive) {
      leader = alive[0];
      pack.leader = leader;
    }

    const cfg = this.config;
    const ts = this.map.tileSize;

    pack.retargetTimer -= dt;
    if (
      pack.targetX == null ||
      pack.retargetTimer <= 0 ||
      Math.abs(pack.targetX - leader.x) < ts * 0.8
    ) {
      const range = (cfg.roamTiles ?? 14) * ts;
      let target = leader.x + rand(-range, range);
      target = clamp(target, ts, this.map.pixelWidth - ts);
      pack.targetX = target;
      pack.retargetTimer = rand(cfg.retargetMinSeconds ?? 3.2, cfg.retargetMaxSeconds ?? 7);
    }

    const windThreshold = cfg.windLieThreshold ?? 0.08;
    const walkSpeed = cfg.walkSpeed ?? 34;
    const runSpeed = cfg.runSpeed ?? 62;
    const waterSlowdown = cfg.waterSlowdown ?? 0.55;

    for (const wolf of alive) {
      wolf.y = this.map.groundYAtWorldX(wolf.x);

      // Woda jest ważniejsza niż wiatr: tonący wilk nie może położyć się
      // na dnie i przeczekać podmuchu.
      const waterInfo = this.game.water?.waterInfoAtX(wolf.x);
      let wading = false;
      if (waterInfo) {
        wolf.waterDepth = waterInfo.depth;
        wolf.inWater =
          waterInfo.top != null &&
          waterInfo.depth > 1.2 &&
          wolf.y > waterInfo.top + 0.5;
        wading = waterInfo.depth > wolf.h * 0.16;

        const headY = wolf.y - wolf.h * 0.82;
        const submerged = waterInfo.top != null && waterInfo.top < headY - 1;
        if (submerged) {
          wolf.state = "drown";
          wolf.drownTimer += dt;
          wolf.vx *= 0.82;
          if (wolf.drownTimer >= (cfg.drownSeconds ?? 3.2)) {
            this._kill(wolf, "drown");
          }
          continue;
        }
        wolf.drownTimer = Math.max(0, wolf.drownTimer - dt * 1.5);
        if (wolf.state === "drown") wolf.state = "walk";
      }

      // Wilki nie idą, dopóki wiatr szarpie doliną — kładą się i czekają.
      const wind = this.game.wind?.intensityAt(wolf.x, wolf.y) ?? 0;
      if (wind >= windThreshold) {
        wolf.state = "lie";
        wolf.vx = 0;
        continue;
      }
      if (wolf.state === "lie") wolf.state = "walk";

      const targetX =
        wolf === leader ? pack.targetX : leader.x + wolf.followOffset;
      const dist = Math.abs(targetX - wolf.x);
      const urgency = clamp(dist / (ts * 3), 0, 1);
      let speed = walkSpeed + (runSpeed - walkSpeed) * urgency;
      if (wading) speed *= waterSlowdown;

      const moved = this._stepToward(wolf, targetX, dt, speed);
      if (!moved) {
        // Zablokowany przez urwisko: po chwili lider wybiera nowy kierunek.
        wolf.blockedTimer += dt;
        if (wolf.blockedTimer > 0.55) {
          wolf.blockedTimer = 0;
          pack.retargetTimer = 0;
          if (wolf === leader) {
            pack.targetX = clamp(
              wolf.x + (chance(0.5) ? -1 : 1) * ts * (5 + rand(0, 6)),
              ts,
              this.map.pixelWidth - ts
            );
          }
        }
      } else {
        wolf.blockedTimer = Math.max(0, wolf.blockedTimer - dt * 2);
      }
    }

    // Jeśli wszyscy członkowie watahy zginęli, nie ma już czego pilnować.
    if (!pack.members.some((wolf) => wolf.alive)) {
      pack.targetX = null;
    }
  }

  _stepToward(wolf, targetX, dt, speed) {
    const dx = targetX - wolf.x;
    if (Math.abs(dx) < 1.2) {
      wolf.vx = 0;
      return true;
    }

    const dir = Math.sign(dx);
    const step = Math.min(Math.abs(dx), speed * dt);
    const nx = wolf.x + dir * step;
    const ts = this.map.tileSize;
    const clampedX = clamp(nx, ts * 0.6, this.map.pixelWidth - ts * 0.6);
    const currentGround = this.map.groundYAtWorldX(wolf.x);
    const nextGround = this.map.groundYAtWorldX(clampedX);

    const maxUp = (this.config.maxStepUpTiles ?? 1.6) * ts;
    const maxDown = (this.config.maxStepDownTiles ?? 8) * ts;
    if (nextGround < currentGround - maxUp || nextGround > currentGround + maxDown) {
      wolf.vx = 0;
      return false;
    }

    wolf.x = clampedX;
    wolf.y = nextGround;
    wolf.vx = dir * speed;
    wolf.facing = dir;
    wolf.walkTime += dt * (0.55 + speed / 55);
    return true;
  }

  /** Ludzie w pobliżu żywego wilka rzucają wszystko i uciekają. */
  _scarePeople() {
    const people = this.game.population?.people;
    if (!people || people.length === 0) return;

    const ts = this.map.tileSize;
    const radius = (this.config.fearRadiusTiles ?? 5) * ts;
    const vertical = ts * 3.2;

    for (const person of people) {
      if (!person.alive || person.sleepIndoors || person.state === "drown") {
        continue;
      }
      for (const wolf of this.wolves) {
        if (!wolf.alive) continue;
        if (Math.abs(wolf.x - person.x) > radius) continue;
        if (Math.abs(wolf.y - person.y) > vertical) continue;
        person.fleeFromWolf?.(wolf.x);
        break;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* ŚMIERĆ                                                              */
  /* ------------------------------------------------------------------ */

  _kill(wolf, cause) {
    if (!wolf || !wolf.alive) return;
    wolf.alive = false;
    wolf.deathTimer = 0;
    wolf.vx = 0;
    wolf.state = "dead";
    wolf.causeOfDeath = cause;

    const y = wolf.y - wolf.h * 0.45;

    if (cause === "drown") {
      this.game.effects?.drown?.(wolf.x, y, wolf.h);
      this.game.audio?.splash?.();
      this._notifyDeath("Wilk tonie w wodzie.");
    } else if (cause === "lightning") {
      this.game.effects?.burst?.(wolf.x, y, "#ffd27a", 20, {
        speed: 82,
        life: 0.8,
        size: 2,
        gravity: 250,
      });
      this._notifyDeath(
        this.aliveCount > 0 ? "Piorun zabija wilka z watahy." : "Piorun zabija wilka."
      );
    } else if (cause === "quake") {
      this.game.effects?.burst?.(wolf.x, y, "#7a7062", 16, {
        speed: 30,
        life: 1.1,
        size: 2.2,
        gravity: 210,
      });
      this.game.effects?.burst?.(wolf.x, y, "#b8ad99", 10, {
        speed: 18,
        life: 0.9,
        size: 1.8,
        gravity: 160,
      });
      this._notifyDeath("Wilk ginie pod zwałami ziemi.");
    }
  }

  _notifyDeath(text) {
    if (this._deathToastTimer > 0) return;
    this._deathToastTimer = 1.6;
    this.game.ui?.toast?.(text, "death");
  }

  /* ------------------------------------------------------------------ */
  /* MOCE BOSKIE                                                         */
  /* ------------------------------------------------------------------ */

  /** Piorun zabija wilki w promieniu uderzenia. Zwraca liczbę ofiar. */
  strikeAt(x, y, radius, ts) {
    let count = 0;
    for (const wolf of this.wolves) {
      if (!wolf.alive) continue;
      if (Math.abs(wolf.x - x) > radius + wolf.w * 0.4) continue;
      if (wolf.y < y - ts * 4 || wolf.y > y + ts * 2.2) continue;
      this._kill(wolf, "lightning");
      count++;
    }
    return count;
  }

  /**
   * Trzęsienie ziemi: zasypane wilki giną, a ocalałe trafiają na nowy grunt.
   * Zwraca liczbę zabitych.
   */
  quakeAt(x, radiusPx, mode, level = 1) {
    const ts = this.map.tileSize;
    let count = 0;

    for (const wolf of this.wolves) {
      if (!wolf.alive) continue;
      const u = Math.abs(wolf.x - x) / Math.max(1, radiusPx);
      if (u > 1.15) continue;

      let dies = false;
      if (mode === "fill") {
        dies = this.map.rectCollides(wolf.x, wolf.y, wolf.w * 0.7, wolf.h * 0.8);
      } else {
        dies = u <= 0.68 && chance(0.35 + (level - 1) * 0.12);
      }

      if (dies) {
        this._kill(wolf, "quake");
        count++;
      }
    }

    // Nic nie może wisieć nad wykopaną ziemią.
    for (const wolf of this.wolves) {
      if (!wolf.alive && wolf.deathTimer > 0.4) continue;
      wolf.y = this.map.groundYAtWorldX(wolf.x);
    }

    if (count > 0) {
      const word = count === 1 ? "wilk" : count < 5 ? "wilki" : "wilków";
      this.game.ui?.toast?.(`Trzęsienie ziemi zabija ${count} ${word} z watahy.`, "death");
    }
    return count;
  }

  /* ------------------------------------------------------------------ */
  /* WYCIE I ZANIKANIE                                                   */
  /* ------------------------------------------------------------------ */

  /** 1 w zenicie księżyca (północ), 0 poza jego najwyższym punktem. */
  _moonZenith() {
    const hour = this.game.hour;
    const window = this.config.moonZenithHours ?? 1.7;
    const fromMidnight = Math.abs(((hour + 12) % 24) - 12);
    return clamp(1 - fromMidnight / Math.max(0.001, window), 0, 1);
  }

  _updateHowl(dt, night) {
    const canHowl =
      night && this.pack && !this.pack.leaving && this.aliveCount > 0;
    const zenith = canHowl ? this._moonZenith() : 0;

    if (zenith > 0) {
      // Wejście w okno zenitu: czasem wataha odpowiada księżycowi.
      if (!this._wasZenith) {
        this._howlTimer = chance(this.config.howlChance ?? 0.55)
          ? rand(
              this.config.howlDelayMinSeconds ?? 0.2,
              this.config.howlDelayMaxSeconds ?? 1.1
            )
          : -1;
      }
      if (this._howlTimer > 0) {
        this._howlTimer -= dt;
        if (this._howlTimer <= 0) {
          this.game.audio?.howl?.();
          this._howlTimer = -1;
        }
      }
    } else {
      this._howlTimer = -1;
    }

    this._wasZenith = zenith > 0;
  }

  _updateCorpses(dt) {
    const pack = this.pack;
    const leaving = !!pack?.leaving;

    for (let i = this.wolves.length - 1; i >= 0; i--) {
      const wolf = this.wolves[i];
      if (!wolf.alive) {
        wolf.deathTimer += dt;
        if (wolf.deathTimer > (this.config.corpseSeconds ?? 7)) {
          wolf.fade -= dt / 1.4;
        }
      } else if (leaving) {
        wolf.fade -= dt / 1.8;
      }

      if (wolf.fade <= 0) {
        this.wolves.splice(i, 1);
        if (pack) {
          const idx = pack.members.indexOf(wolf);
          if (idx >= 0) pack.members.splice(idx, 1);
        }
      }
    }

    if (leaving && this.wolves.length === 0) {
      this.pack = null;
    }
  }
}
