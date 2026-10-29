import { clamp, rand, chance, distance, ageGroup, mixColor, choice } from "./utils.js?v=20261046-1";

const STATE_LABELS = {
  idle: "odpoczywa",
  wander: "spaceruje",
  flee: "ucieka",
  social: "rozmawia",
  drown: "tonie",
  sleep: "śpi",
  mourn: "żegna zmarłych",
  pray: "modli się",
  child: "bawi się",
  chop: "ścina drzewo",
  build: "buduje dom",
  home: "wraca do domu",
  ladderChop: "ścina drzewo na drabinę",
  ladderBuild: "buduje drabinę",
  climb: "wspina się po drabinie",
  sow: "sieje zboże",
  harvest: "zbiera plony",
  shame: "stoi zawstydzony",
  reclothe: "biegnie po ubranie",
};

export class Person {
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name;
    this.sex = opts.sex; // "m" | "f"
    this.ageYears = opts.ageYears;
    this.config = opts.config;
    this.map = opts.map;
    this.water = opts.water;
    this.population = opts.population;
    this.gravity = opts.gravity || 1500;

    this.x = opts.x;
    this.y = opts.y;
    this.vx = 0;
    this.vy = 0;
    this.grounded = false;
    this.facing = chance(0.5) ? 1 : -1;

    this.alive = true;
    this.causeOfDeath = null;
    this.state = "idle";
    this.stateTimer = rand(0.5, 3);
    this.targetX = null;
    this.partnerTarget = null;
    this.partnerTimer = rand(2, 5);
    this.socialTimer = 0;
    this.moveDir = 0;
    this.panicTimer = 0;
    this.blockedTimer = 0;
    this.jumpCooldown = 0;
    this.wanderCount = 0;
    this.drownTimer = 0;
    this.waterDepth = 0;
    this.inWater = false;
    this._hour = null;
    this._isNight = null;

    this.memorialSiteId = null;
    this.monolithSiteId = null;
    this.prayOffsetX = 0;
    this._prayLushTimer = 0;
    this.sleepPhase = rand(0, 10);

    this.homeId = opts.homeId ?? null;
    this.homeBuild = null;
    this.buildCooldown = rand(0, 7);
    this.sleepIndoors = false;
    this.partnerId = null;
    this._chopTimer = 0;

    // Drabiny: przeszkoda terenowa wymagająca drabiny i praca nad nią.
    this.ladderBuild = null;
    this._needsLadder = false;
    this._trapCooldown = rand(2, 7);
    this._climb = null;

    // Uprawy i głód: ziarno z pól trafia do wspólnych zapasów wioski.
    this.cropWork = null;
    this._cropTimer = 0;
    this.hunger = rand(0, 0.3);
    this.starveTimer = 0;

    // Wiatr: rozebranie przez podmuch, wstyd i biegu do domu po ubranie.
    this.stripped = false;
    this.stripCooldown = 0;
    this.windPush = 0;
    this._reclothHouseId = null;
    this._reclothAvoidId = null;
    this._reclothAvoidTimer = 0;
    this._reclothSearchTimer = 0;
    this._reclothStuckTimer = 0;
    this._reclothLastDist = null;

    this.pregnancyDays = 0;
    this.birthCooldownDays = 0;
    this.partnerCooldownDays = rand(0, 3);
    this.lifespan = rand(this.config.lifespanMin, this.config.lifespanMax);

    this.walkTime = rand(0, 10);
    this.idleTime = rand(0, 10);
    this.courage = rand(0, 1);
    this.speedVariation = rand(0.84, 1.14);

    this.skinTone = opts.skinTone;
    this.hairColor = opts.hairColor;
    this.clothesColor = opts.clothesColor;
    this.pantsColor = mixColor(opts.clothesColor, "#241b1c", 0.55);
    this.eyeColor = "#2a2119";
    this.motherId = opts.motherId ?? null;
    this.fatherId = opts.fatherId ?? null;
    // Zapamiętywane przy poczęciu; trafia do dziecka jako fatherId.
    this.fatherCandidateId = null;

    this._updateSize();
  }

  _updateSize() {
    const childAge = this.config.childAge;
    const t = clamp(this.ageYears / childAge, 0, 1);
    const growth = 0.5 + 0.5 * Math.sqrt(t);
    const elderShrink = this.ageYears > this.config.elderAge ? 0.97 : 1;
    this.h = this.config.height * growth * elderShrink;
    this.w = this.config.width * (0.72 + 0.28 * growth);
  }

  get age() {
    return Math.floor(this.ageYears);
  }

  get group() {
    return ageGroup(this.ageYears, this.config);
  }

  get isNight() {
    if (this._hour == null) return false;
    const nightStart = this.config.nightStartHour ?? 21;
    const dayStart = this.config.dayStartHour ?? 6;
    return this._hour >= nightStart || this._hour < dayStart;
  }

  get isAdult() {
    return this.ageYears >= this.config.fertileAge && this.ageYears < this.config.fertilityEnd;
  }

  get isFertileFemale() {
    return (
      this.sex === "f" &&
      this.isAdult &&
      this.pregnancyDays <= 0 &&
      this.birthCooldownDays <= 0 &&
      this.partnerCooldownDays <= 0
    );
  }

  get isFertileMale() {
    return (
      this.sex === "m" &&
      this.isAdult &&
      this.partnerCooldownDays <= 0
    );
  }

  get isPregnant() {
    return this.pregnancyDays > 0;
  }

  get displayState() {
    if (this.state === "drown") return STATE_LABELS.drown;
    if (this.state === "pray") {
      return this.targetX != null ? "idzie do monolitu" : STATE_LABELS.pray;
    }
    if (this.state === "sleep") {
      return this.sleepIndoors ? "śpi w domu" : STATE_LABELS.sleep;
    }
    if (this.state === "mourn") return STATE_LABELS.mourn;
    if (this.hunger >= 0.95) return "głoduje";
    if (this.isPregnant) return "w ciąży";
    if (this.ageYears < 6 && this.motherId) return STATE_LABELS.child;
    if (this.state === "idle" && this.isNight) return "odpoczywa nocą";
    return STATE_LABELS[this.state] || "żyje";
  }

  update(dt, game) {
    if (!this.alive) return;

    const days = (dt * game.config.time.yearsPerDay) / game.config.time.secondsPerDay;
    this.ageYears += days;
    this._updateSize();

    if (this.ageYears >= this.lifespan) {
      this.population.kill(this, "starość");
      return;
    }

    // Głód: ludzie jedzą, gdy zapasy na to pozwalają. Gdy plony są
    // niszczone, w końcu zaczynają umierać z głodu.
    const cropsCfg = game.config.crops || {};
    this.hunger = Math.min(1.5, this.hunger + dt * (cropsCfg.hungerPerSecond ?? 0.018));
    if (this.hunger >= (cropsCfg.eatThreshold ?? 0.55)) {
      game.crops?.tryEat(this);
    }
    if (this.hunger >= 1) {
      this.starveTimer += dt;
      if (this.starveTimer >= (cropsCfg.starveSeconds ?? 22)) {
        this.population.kill(this, "głód");
        return;
      }
    } else {
      this.starveTimer = 0;
    }

    this.birthCooldownDays = Math.max(0, this.birthCooldownDays - days);
    this.partnerCooldownDays = Math.max(0, this.partnerCooldownDays - days);
    this.buildCooldown = Math.max(0, this.buildCooldown - dt);
    this.stripCooldown = Math.max(0, this.stripCooldown - dt);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    this._trapCooldown = Math.max(0, this._trapCooldown - dt);
    this.partnerTimer -= dt;
    this.idleTime += dt;
    this.walkTime += dt * (0.7 + Math.abs(this.vx) / 30);

    // Wspinaczka po drabinie rządzi się własną animacją, bez fizyki terenu.
    if (this._climb) {
      this._climbStep(dt);
      return;
    }

    if (this.pregnancyDays > 0) {
      this.pregnancyDays -= days;
      if (this.pregnancyDays <= 0) {
        this.pregnancyDays = 0;
        this.population.giveBirth(this);
      }
    }

    const waterInfo = this.water.waterInfoAtX(this.x);
    this.waterDepth = waterInfo.depth;
    this.inWater =
      waterInfo.top != null &&
      waterInfo.depth > 1.2 &&
      this.y > waterInfo.top + 0.5;
    const headY = this.y - this.h * 0.9;
    const submerged = waterInfo.top != null && waterInfo.top < headY - 1;

    if (submerged) {
      this.state = "drown";
      this.moveDir = 0;
      this.drownTimer += dt;
      this.vx *= 0.9;
      if (this.drownTimer >= this.config.drownSeconds) {
        this.population.kill(this, "utonięcie");
        return;
      }
      this._physics(dt);
      return;
    }
    this.drownTimer = Math.max(0, this.drownTimer - dt * 1.5);

    // Panika, gdy pada lub woda podnosi się w pobliżu.
    const raining = game.weather.isRainingAt(this.x);
    const wadeDepth = waterInfo.depth;
    if (!this.panicTimer && (wadeDepth > this.config.height * 0.32 || raining)) {
      const risk = (1 - this.courage) * this.config.fleeChance;
      if (chance(risk * dt * (raining ? 0.7 : 2.2))) {
        this.panicTimer = rand(3.5, 9);
      }
    }
    this.panicTimer = Math.max(0, this.panicTimer - dt);

    this._think(dt, game, waterInfo, wadeDepth);
    if (this._climb) return;
    if (
      !this.ladderBuild &&
      !this.homeBuild &&
      this.blockedTimer > 0.2 &&
      this.state !== "shame"
    ) {
      const cd = Math.sign(this.vx) || this.facing || 1;
      if (this._findHighWallAhead(cd) != null) this._registerFailedJump(cd);
    }
    this._physics(dt);
  }

  _think(dt, game, waterInfo, wadeDepth) {
    // Ubranie mogło zniknąć, a stan przerwać fizyka, woda, noc albo inna
    // czynność. Zanim cokolwiek innego, wracamy do biegu po ubranie.
    // Jeśli w drodze zaczęła się drabina, najpierw ją kończymy — dopiero
    // po przejściu na drugą stronę wracamy do ubierania.
    if (
      this.stripped &&
      this.state !== "shame" &&
      this.state !== "reclothe" &&
      this.state !== "ladderChop" &&
      this.state !== "ladderBuild"
    ) {
      if (this.ladderBuild && game.ladders?.resume(this)) return;
      this._startReclothe(game);
      return;
    }
    if (this.state === "pray") {
      const ts = this.map.tileSize;
      if (this.panicTimer > 0 || this.isNight) {
        game.monoliths?.release(this);
        this.state = "idle";
        this.stateTimer = this._idleDuration();
        return;
      }
      const site =
        this.monolithSiteId != null
          ? game.monoliths?.byId?.get(this.monolithSiteId)
          : null;
      if (!site) {
        game.monoliths?.release(this);
        this.state = "idle";
        this.stateTimer = this._idleDuration();
        this.targetX = null;
        return;
      }

      const slotX = site.x + (this.prayOffsetX || 0);
      if (Math.abs(this.x - slotX) < ts * 0.7) {
        // Klęczy już na swoim miejscu w półkolu wokół monolitu.
        this.stateTimer = Math.max(0, this.stateTimer - dt);
        this.targetX = null;
        this.moveDir = 0;
        this.vx *= 0.86;
        this.facing = site.x >= this.x ? 1 : -1;

        // Modlitwa rzeczywiście zasila boga: niewielki, ale regularny strumień
        // Lush, a na zakończeniu obrzędu dodatkowa porcja.
        const monolithCfg = game.config.monoliths || {};
        this._prayLushTimer -= dt;
        if (this._prayLushTimer <= 0) {
          this._prayLushTimer = 1;
          const perSecond = monolithCfg.prayLushPerSecond ?? 1;
          if (perSecond > 0) game.powers?._addLush(perSecond);
        }

        if (
          this.stateTimer <= 0 &&
          site.state !== "gather" &&
          site.state !== "build"
        ) {
          const bonus = monolithCfg.prayLushBonus ?? 6;
          if (bonus > 0) game.powers?._addLush(bonus);
          game.monoliths?.release(this);
          this.state = "idle";
          this.stateTimer = this._idleDuration();
        }
        return;
      }
      if (this.blockedTimer > 5) {
        // Nie da się dotrzeć do kamienia — wracaj do codziennych zajęć.
        game.monoliths?.release(this);
        this.state = "idle";
        this.stateTimer = this._idleDuration();
        this.targetX = null;
        return;
      }
      this.targetX = slotX;
      this._walkTowardsTarget(dt, game, waterInfo);
      return;
    }
    const night = this.isNight;

    // Wiatr zerwał ubranie: najpierw chwila wstydu, potem bieg do chaty.
    if (this.state === "shame") {
      this.stateTimer -= dt;
      this.moveDir = 0;
      this.vx *= 0.86;
      this.panicTimer = 0;
      if (this.stateTimer <= 0) this._startReclothe(game);
      return;
    }
    if (this.state === "reclothe") {
      this._reclotheStep(dt, game, waterInfo);
      return;
    }

    if (this.panicTimer > 0 && this.state !== "social") {
      if (this.memorialSiteId != null) this._leaveMemorial();
      if (this.homeBuild) game.housing?.cancelProject(this);
      if (this.ladderBuild) game.ladders?.cancelProject(this);
      if (this.cropWork) game.crops?.cancelProject(this);
      if (this.monolithSiteId != null) game.monoliths?.release(this);
      this.state = "flee";
    }

    if (this.state === "flee") {
      if (this.panicTimer > 0) {
        this._flee(game, waterInfo, wadeDepth);
        return;
      }
      // Panika minęła: zejdź z wysokiego gruntu i wróć do normalnego życia.
      this.state = "wander";
      this.stateTimer = rand(4, 8);
      this._pickWanderTarget(game, true);
      this._walkTowardsTarget(dt, game, waterInfo);
      return;
    }

    if (this.memorialSiteId != null && this.state !== "mourn") {
      this._leaveMemorial();
    }

    if (this.state === "sleep") {
      if (!night || wadeDepth > this.config.height * 0.2) {
        this._wake();
      } else {
        this.moveDir = 0;
        this.vx *= 0.9;
        return;
      }
    }

    if (this.state === "mourn") {
      this._mourn(dt, game, waterInfo);
      return;
    }

    if (this.homeBuild && (this.state === "chop" || this.state === "build")) {
      this._workOnHome(dt, game, waterInfo);
      return;
    }

    if (
      this.ladderBuild &&
      (this.state === "ladderChop" || this.state === "ladderBuild")
    ) {
      this._workOnLadder(dt, game, waterInfo);
      return;
    }

    if (
      this.cropWork &&
      (this.state === "sow" || this.state === "harvest")
    ) {
      this._workOnCrop(dt, game, waterInfo);
      return;
    }

    if (this.state === "home") {
      this._goHomeStep(dt, game, waterInfo);
      return;
    }

    // Gdy zapasy się kończą, dojrzałe pola są ważniejsze niż spacery i rozmowy.
    if (!night && game.crops?.urgentHarvest(this)) return;

    // Małe dzieci trzymają się matki.
    if (this.ageYears < 6 && this.motherId && this.state !== "social") {
      const mother = this.population.byId.get(this.motherId);
      if (mother && mother.alive) {
        const dx = mother.x - this.x;
        if (Math.abs(dx) > this.map.tileSize * 2.2) {
          this.state = "wander";
          this.targetX = mother.x + (this.x < mother.x ? -1 : 1) * this.map.tileSize * 0.9;
          this._walkTowardsTarget(dt, game, waterInfo);
          return;
        }
        if (this.state !== "idle") {
          this.state = "idle";
          this.stateTimer = rand(0.4, 1.4);
          this.targetX = null;
        }
      }
    }

    if (this.state === "social") {
      this.socialTimer -= dt;
      this.moveDir = 0;
      if (this.socialTimer <= 0) {
        this.state = "idle";
        this.stateTimer = this._idleDuration(night);
        this.partnerTarget = null;
      }
      return;
    }

    // Dorośli szukają towarzystwa, co daje szansę na potomstwo.
    if (this.isAdult && this.partnerCooldownDays <= 0 && !this.isPregnant) {
      if (night) {
        // Nocą nie wędrują w poszukiwaniu partnera; wracają do odpoczynku.
        if (this.partnerTarget != null) {
          this.partnerTarget = null;
          this.targetX = null;
          this.state = "idle";
          this.stateTimer = this._idleDuration(true);
          this.moveDir = 0;
        }
      } else {
        this.partnerTimer -= dt;
        if (this.partnerTimer <= 0) {
          this.partnerTimer = rand(4, 9);
          const partner = this.population.findPartner(this);
          if (partner) {
            this.partnerTarget = partner.id;
            this.targetX = partner.x;
            this.state = "wander";
          }
        }
        if (this.partnerTarget != null) {
          const partner = this.population.byId.get(this.partnerTarget);
          if (!partner || !partner.alive) {
            this.partnerTarget = null;
          } else if (distance(this.x, this.y, partner.x, partner.y) < this.map.tileSize * 1.5) {
            this.state = "social";
            this.socialTimer = rand(1.2, 3.4);
            this.moveDir = 0;
            this.facing = partner.x >= this.x ? 1 : -1;
            this.targetX = null;
            this.partnerTarget = null;
            return;
          } else {
            this.targetX = partner.x;
          }
        }
      }
    }

    if (this.state === "idle") {
      this.stateTimer -= dt;
      this.moveDir = 0;
      if (chance(dt * 0.35)) this.facing = chance(0.5) ? 1 : -1;
      if (this.stateTimer <= 0) {
        if (night) {
          if (chance(this.config.nightSleepChance ?? 0.9)) {
            if (this._goHomeIfPossible(game)) return;
            this._fallAsleep(false);
            return;
          }
        } else {
          // Najpierw dokończ przerwaną budowę, potem myśl o nowej chacie.
          if (this.ladderBuild && game.ladders?.resume(this)) return;
          if (this.homeBuild && game.housing?.resumeProject(this)) return;
          if (!night && this.cropWork && game.crops?.resume(this)) return;
          if (!this.homeId && game.housing?.tryStartProject(this)) return;
          if (!night && game.crops?.tryStartWork(this)) return;
        }
        if (!night && this.ageYears >= (game.config.monoliths?.minAge ?? 6) && game.monoliths) {
          // findPraySite sam ustawia stan, timer i miejsce w półkolu.
          if (game.monoliths.findPraySite(this)) return;
        }
        const wanderChance = night
          ? this.config.nightWanderChance ?? 0.1
          : this.config.dayWanderChance ?? 0.9;
        if (chance(wanderChance)) {
          this.state = "wander";
          this._pickWanderTarget(
            game,
            false,
            night ? this.config.nightWanderRadiusFactor ?? 0.45 : 1
          );
          this.stateTimer = night ? rand(1.5, 4) : rand(5, 10);
        } else {
          this.state = "idle";
          this.stateTimer = this._idleDuration(night);
        }
      }
      return;
    }

    if (this.state === "wander") {
      this.stateTimer -= dt;
      if (this.targetX == null) {
        this._pickWanderTarget(
          game,
          false,
          night ? this.config.nightWanderRadiusFactor ?? 0.45 : 1
        );
      }
      this._walkTowardsTarget(dt, game, waterInfo);

      if (
        this.targetX != null &&
        Math.abs(this.x - this.targetX) < this.map.tileSize * 0.55
      ) {
        this.state = "idle";
        this.stateTimer = this._idleDuration(night);
        this.targetX = null;
        this.moveDir = 0;
      } else if (this.stateTimer <= 0) {
        this.state = "idle";
        this.stateTimer = this._idleDuration(night);
        this.targetX = null;
        this.moveDir = 0;
      }
      return;
    }
  }

  _idleDuration(night = this.isNight) {
    if (night) {
      return rand(
        this.config.nightIdleMin ?? 1.5,
        this.config.nightIdleMax ?? 4
      );
    }
    return rand(this.config.idleMin, this.config.idleMax);
  }

  /** Nocą człowiek z domem wraca do chaty, jeśli nie oddalił się za bardzo. */
  /** Podmuch zrywa ubranie: postać staje zawstydzona i szuka chaty. */
  stripClothes(game) {
    if (this.stripped || !this.alive) return false;
    const cfg = game.config.wind || {};
    this.stripped = true;
    this.stripCooldown = cfg.stripCooldownSeconds ?? 35;
    this.panicTimer = 0;
    if (this.memorialSiteId != null) this._leaveMemorial();
    if (this.homeBuild) game.housing?.cancelProject(this);
    if (this.ladderBuild) game.ladders?.cancelProject(this);
    if (this.cropWork) game.crops?.cancelProject(this);
    this.state = "shame";
    this.stateTimer = rand(cfg.shameMin ?? 1.3, cfg.shameMax ?? 2.6);
    this.targetX = null;
    this.partnerTarget = null;
    this.moveDir = 0;
    this.vx = 0;
    this.sleepIndoors = false;
    return true;
  }

  _nearestHouse(game, avoidId = null) {
    const houses = game.housing?.houses || [];
    let best = null;
    let bestDist = Infinity;
    for (const house of houses) {
      if (house.burning || house.destroyed) continue;
      if (avoidId != null && house.id === avoidId) continue;
      const d = distance(this.x, this.y, house.x, house.y);
      if (d < bestDist) {
        bestDist = d;
        best = house;
      }
    }
    return best;
  }

  _startReclothe(game) {
    const house = this._nearestHouse(game, this._reclothAvoidId);
    this.state = "reclothe";
    this._reclothSearchTimer = 0;
    this._setReclotheHouse(house);
  }

  /** Ustawia dom, do którego idzie po ubranie (albo tryb szukania). */
  _setReclotheHouse(house) {
    this._reclothHouseId = house ? house.id : null;
    this._reclothStuckTimer = 0;
    this._reclothLastDist = null;
    if (!house) {
      this.targetX = null;
      this.moveDir = 0;
      return;
    }
    this.targetX = house.x;
    const dir = Math.sign(house.x - this.x);
    this.moveDir = dir;
    if (dir) this.facing = dir;
  }

  /** Chwilowo omiń dom, do którego nie da się dojść, i wybierz inny. */
  _avoidReclotheHouse(game, house) {
    this._reclothAvoidId = house ? house.id : null;
    this._reclothAvoidTimer = 12;
    this._setReclotheHouse(this._nearestHouse(game, this._reclothAvoidId));
  }

  /** Nie ma żadnego domu — chodzimy po okolicy i wypatrujemy nowego. */
  _searchForClothes(dt, game, waterInfo) {
    this._reclothSearchTimer -= dt;
    if (this.targetX == null || this._reclothSearchTimer <= 0) {
      this._pickWanderTarget(game, false, 0.8);
      this._reclothSearchTimer = rand(2.5, 5);
    }
    this.state = "reclothe";
    this._walkTowardsTarget(dt, game, waterInfo);
  }

  _reclotheStep(dt, game, waterInfo) {
    if (this._reclothAvoidTimer > 0) {
      this._reclothAvoidTimer -= dt;
      if (this._reclothAvoidTimer <= 0) this._reclothAvoidId = null;
    }

    let house = game.housing?.getHouse(this._reclothHouseId);
    if (!house || house.burning || house.destroyed) {
      house = this._nearestHouse(game, this._reclothAvoidId);
      this._setReclotheHouse(house);
    }

    if (!house) {
      // Bez domu nie ma skąd wziąć ubrania — zostajemy nadzy i szukamy dalej.
      this._searchForClothes(dt, game, waterInfo);
      return;
    }

    const ts = this.map.tileSize;
    if (
      Math.abs(this.x - house.x) < ts * 0.9 &&
      Math.abs(this.y - house.y) < ts * 2
    ) {
      this._getDressed(game);
      return;
    }

    // Jeśli przez dłuższy czas nie przybliżamy się do celu (woda, urwisko,
    // tłok), spróbuj innego domu zamiast stać w miejscu bez końca.
    const dist = distance(this.x, this.y, house.x, house.y);
    if (this._reclothLastDist != null && dist < this._reclothLastDist - 0.5) {
      this._reclothStuckTimer = 0;
    } else {
      this._reclothStuckTimer += dt;
    }
    this._reclothLastDist = dist;
    if (this._reclothStuckTimer > 6) {
      this._avoidReclotheHouse(game, house);
      return;
    }

    this.targetX = house.x;
    const dir = Math.sign(house.x - this.x);
    if (dir) {
      this.facing = dir;
      this.moveDir = dir;
    } else {
      this.moveDir = 0;
    }

    // Zbyt strome zejście w drodze do chaty: użyj gotowej drabiny albo
    // zbuduj ją, zamiast stać nago nad urwiskiem.
    if (dir && this._ledgeAhead(dir)) {
      this._registerHighDrop(dir);
      this.moveDir = 0;
      return;
    }

    // Biegnąc po ubranie, nie wchodź dobrowolnie w głęboką wodę. Jeśli
    // przejście jest odcięte, poszukaj innej chaty.
    if (waterInfo.depth < this.config.height * 0.7) {
      const ahead = this.water.waterInfoAtX(
        this.x + this.facing * ts * 0.9
      );
      if (ahead.depth > this.config.height * 0.9) {
        this._avoidReclotheHouse(game, house);
      }
    }
  }

  _getDressed(game) {
    const palette = game.config.theme?.clothes || ["#b45f4d"];
    this.stripped = false;
    this.clothesColor = choice(palette);
    this.pantsColor = mixColor(this.clothesColor, "#241b1c", 0.55);
    this.stripCooldown = game.config.wind?.stripCooldownSeconds ?? 35;
    this._reclothHouseId = null;
    this._reclothAvoidId = null;
    this._reclothAvoidTimer = 0;
    this._reclothSearchTimer = 0;
    this._reclothStuckTimer = 0;
    this._reclothLastDist = null;
    this.state = "idle";
    this.stateTimer = rand(0.6, 1.8);
    this.targetX = null;
    this.moveDir = 0;
    this.vx = 0;
    this.population?.game?.ui?.toast?.(
      `<strong>${this.name}</strong> zakłada nowe ubranie.`,
      "birth"
    );
  }

  _goHomeIfPossible(game) {
    if (this.homeId == null || !game.housing) return false;
    const house = game.housing.getHouse(this.homeId);
    if (!house || house.burning) return false;

    const ts = this.map.tileSize;
    if (
      Math.abs(this.x - house.x) < ts * 0.8 &&
      Math.abs(this.y - house.y) < ts * 2
    ) {
      this._fallAsleep(true);
      return true;
    }

    const maxDistance =
      (game.config.housing?.sleepHomeRadiusTiles ?? 40) * ts;
    if (distance(this.x, this.y, house.x, house.y) > maxDistance) {
      return false;
    }

    this.state = "home";
    this.stateTimer = 20;
    this.targetX = house.x;
    this.moveDir = Math.sign(house.x - this.x) || 0;
    return true;
  }

  _goHomeStep(dt, game, waterInfo) {
    if (!this.isNight) {
      this.state = "idle";
      this.stateTimer = rand(0.4, 1.4);
      this.targetX = null;
      this.moveDir = 0;
      return;
    }

    const house = this.homeId != null ? game.housing?.getHouse(this.homeId) : null;
    if (!house || house.burning) {
      this._fallAsleep(false);
      return;
    }

    const ts = this.map.tileSize;
    if (
      Math.abs(this.x - house.x) < ts * 0.8 &&
      Math.abs(this.y - house.y) < ts * 2
    ) {
      this._fallAsleep(true);
      return;
    }

    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      // Droga się przedłuża — noc jest krótsza niż wędrówka.
      this._fallAsleep(false);
      return;
    }

    // Jeśli droga do domu przechodzi przez zbyt wysoką skarpę, stawiamy
    // drabinę w dół, żeby dało się zejść bez skakania w przepaść.
    const homeTx = Math.floor(house.x / ts);
    if (!this._reachableColumn(homeTx)) {
      const dir = Math.sign(house.x - this.x) || this.facing || 1;
      if (dir !== 0) this._registerHighDrop(dir);
      // Projekt drabiny właśnie się rozpoczął — nie nadpisuj jego stanu
      // powrotem do domu, bo budowa nigdy by nie ruszyła.
      if (this.ladderBuild) return;
    }

    this.state = "home";
    this.targetX = house.x;
    this._walkTowardsTarget(dt, game, waterInfo);
    if (this.state !== "home") this._fallAsleep(false);
  }

  /** Ścinanie drzew i stawianie chaty. Budowa nocą czeka do świtu. */
  _workOnHome(dt, game, waterInfo) {
    const housing = game.housing;
    const project = this.homeBuild;
    if (!housing || !project) {
      this.homeBuild = null;
      this.state = "idle";
      this.stateTimer = this._idleDuration();
      return;
    }

    if (this.isNight) {
      this.state = "idle";
      this.stateTimer = this._idleDuration(true);
      this.targetX = null;
      this.moveDir = 0;
      this._chopTimer = 0;
      return;
    }

    const ts = this.map.tileSize;

    if (project.siteId != null) {
      const site = housing.getSite(project.siteId);
      if (!site) {
        project.siteId = null;
        if (!housing.resumeProject(this)) {
          this.state = "idle";
          this.stateTimer = this._idleDuration();
        }
        return;
      }

      this.state = "build";
      this.targetX = site.x;
      const dx = Math.abs(this.x - site.x);
      const dy = Math.abs(this.y - site.y);
      if (dx < ts * 0.75 && dy < ts * 2.5) {
        this.moveDir = 0;
        this.vx *= 0.85;
        this.facing = site.x >= this.x ? 1 : -1;
        site.progress = Math.min(1, site.progress + dt / housing.buildSeconds);
        if (chance(dt * 7)) {
          const px = site.x + rand(-site.w * 0.42, site.w * 0.42);
          const py = site.y - rand(1, site.wallH * 0.8);
          game.effects.burst(px, py, chance(0.5) ? "#c9a46b" : "#8a6a43", 2, {
            speed: 20,
            life: 0.55,
            size: 1.6,
            gravity: 120,
          });
        }
        if (site.progress >= 1) housing.completeSite(site, this);
      } else {
        this._walkTowardsTarget(dt, game, waterInfo);
      }
      return;
    }

    if (project.treeId == null) {
      if (!housing.assignTree(this, project)) {
        housing.cancelProject(this);
      }
      return;
    }

    const tree = game.vegetation.getTree(project.treeId);
    if (!tree || tree.felled || tree.stump || tree.burning) {
      project.treeId = null;
      this._chopTimer = 0;
      if (!housing.assignTree(this, project)) {
        housing.cancelProject(this);
      }
      return;
    }

    this.state = "chop";
    this.targetX = tree.x;
    if (Math.abs(this.x - tree.x) < ts * 0.75) {
      this.moveDir = 0;
      this.vx *= 0.85;
      this.facing = tree.x >= this.x ? 1 : -1;
      this._chopTimer += dt;
      if (chance(dt * 6)) {
        game.effects.burst(
          tree.x + rand(-3, 3),
          tree.y - rand(2, Math.max(4, tree.h * 0.35)),
          chance(0.5) ? "#c9a46b" : "#7a5a37",
          2,
          { speed: 22, life: 0.55, size: 1.7, gravity: 130 }
        );
      }
      if (this._chopTimer >= housing.chopSeconds) {
        if (game.vegetation.fellTree(tree, this.facing)) {
          project.wood += housing.woodPerTree;
          game.effects.burst(tree.x, tree.y - tree.h * 0.4, "#8fbf62", 12, {
            speed: 34,
            life: 0.9,
            size: 1.9,
            gravity: 60,
          });
        }
        project.treeId = null;
        this._chopTimer = 0;
        if (project.wood >= housing.woodRequired) {
          if (!housing.beginSite(this)) {
            this.state = "idle";
            this.stateTimer = this._idleDuration();
            this.targetX = null;
          }
        } else if (!housing.assignTree(this, project)) {
          housing.cancelProject(this);
        }
      }
      return;
    }

    this._walkTowardsTarget(dt, game, waterInfo);
  }

  /**
   * Praca w polu: zasiew lub żniwa. Noc przerywa pracę, ale pole zostaje
   * przydzielone, więc rano człowiek wraca do przerwanego zajęcia.
   */
  _workOnCrop(dt, game, waterInfo) {
    const crops = game.crops;
    const work = this.cropWork;
    if (!crops || !work) {
      this.cropWork = null;
      this.state = "idle";
      this.stateTimer = this._idleDuration();
      return;
    }

    const plot = crops.getPlot(work.plotId);
    if (!plot || plot.burning || plot.workerId !== this.id) {
      crops.cancelProject(this);
      return;
    }

    if (this.isNight) {
      this.state = "idle";
      this.stateTimer = this._idleDuration(true);
      this.targetX = null;
      this.moveDir = 0;
      this._cropTimer = 0;
      return;
    }

    const ts = this.map.tileSize;
    this.state = work.action;
    this.targetX = plot.x;
    const dx = Math.abs(this.x - plot.x);
    const dy = Math.abs(this.y - plot.y);

    if (dx < ts * 1.15 && dy < ts * 2.4) {
      this.moveDir = 0;
      this.vx *= 0.85;
      this.facing = plot.x >= this.x ? 1 : -1;
      this._cropTimer += dt;

      const harvesting = work.action === "harvest";
      if (chance(dt * (harvesting ? 8 : 5))) {
        game.effects.burst(
          plot.x + rand(-plot.w * 0.45, plot.w * 0.45),
          plot.y - (harvesting ? rand(4, 12) : rand(1, 4)),
          harvesting ? "#e2c063" : "#8a6a43",
          2,
          {
            speed: harvesting ? 26 : 18,
            life: 0.6,
            size: 1.6,
            gravity: harvesting ? 80 : 130,
          }
        );
      }

      const needed = harvesting
        ? crops.config.harvestSeconds ?? 2.6
        : crops.config.sowSeconds ?? 1.8;
      if (this._cropTimer >= needed) crops.completeWork(this, plot);
      return;
    }

    this._walkTowardsTarget(dt, game, waterInfo);
  }

  /**
   * Ścinanie drzew i wiązanie drabiny pod zbyt wysoką skarpą.
   * Wyższa przeszkoda wymaga więcej drzew, więc praca trwa dłużej.
   */
  _workOnLadder(dt, game, waterInfo) {
    const ladders = game.ladders;
    const plan = this.ladderBuild;
    if (!ladders || !plan) {
      this.ladderBuild = null;
      this.state = "idle";
      this.stateTimer = this._idleDuration();
      return;
    }

    if (this.isNight) {
      // Noc przerywa pracę, ale projekt czeka do rana.
      this.state = "idle";
      this.stateTimer = this._idleDuration(true);
      this.targetX = null;
      this.moveDir = 0;
      this._chopTimer = 0;
      return;
    }

    const ts = this.map.tileSize;

    if (plan.siteId != null) {
      const site = ladders.getSite(plan.siteId);
      if (!site) {
        plan.siteId = null;
        if (!ladders.resume(this)) {
          this.state = "idle";
          this.stateTimer = this._idleDuration();
        }
        return;
      }

      this.state = "ladderBuild";
      this.targetX = site.x;
      const dx = Math.abs(this.x - site.x);
      const dy = Math.abs(this.y - site.baseY);
      if (dx < ts * 0.8 && dy < ts * 2.2) {
        this.moveDir = 0;
        this.vx *= 0.85;
        this.facing = site.x >= this.x ? 1 : -1;
        // Drabina z gałęzi powstaje wyraźnie dłużej niż z dobrego drewna,
        // ale zawsze da się ją dokończyć.
        const buildTime = ladders.buildSeconds * (plan.gather ? 3 : 1);
        site.progress = Math.min(1, site.progress + dt / buildTime);
        if (chance(dt * 6)) {
          game.effects.burst(
            site.x + rand(-3, 3),
            site.baseY - rand(2, site.heightTiles * ts * 0.5),
            chance(0.5) ? "#c9a46b" : "#8a6a43",
            2,
            { speed: 20, life: 0.55, size: 1.6, gravity: 120 }
          );
        }
        if (site.progress >= 1) ladders.completeSite(site, this);
      } else {
        this._walkTowardsTarget(dt, game, waterInfo);
      }
      return;
    }

    if (plan.treeId == null) {
      if (!ladders.assignTree(this, plan) && !ladders.beginGather(this, plan)) {
        ladders.cancelProject(this);
      }
      return;
    }

    const tree = game.vegetation.getTree(plan.treeId);
    if (!tree || tree.felled || tree.stump || tree.burning) {
      plan.treeId = null;
      this._chopTimer = 0;
      if (!ladders.assignTree(this, plan) && !ladders.beginGather(this, plan)) {
        ladders.cancelProject(this);
      }
      return;
    }

    this.state = "ladderChop";
    this.targetX = tree.x;
    if (Math.abs(this.x - tree.x) < ts * 0.75) {
      this.moveDir = 0;
      this.vx *= 0.85;
      this.facing = tree.x >= this.x ? 1 : -1;
      this._chopTimer += dt;
      if (chance(dt * 6)) {
        game.effects.burst(
          tree.x + rand(-3, 3),
          tree.y - rand(2, Math.max(4, tree.h * 0.35)),
          chance(0.5) ? "#c9a46b" : "#7a5a37",
          2,
          { speed: 22, life: 0.55, size: 1.7, gravity: 130 }
        );
      }
      if (this._chopTimer >= ladders.chopSeconds) {
        if (game.vegetation.fellTree(tree, this.facing)) {
          plan.wood += ladders.woodPerTree;
          game.effects.burst(tree.x, tree.y - tree.h * 0.4, "#8fbf62", 12, {
            speed: 34,
            life: 0.9,
            size: 1.9,
            gravity: 60,
          });
        }
        plan.treeId = null;
        this._chopTimer = 0;
        if (plan.wood >= plan.woodRequired) {
          if (!ladders.beginSite(this)) {
            this.state = "idle";
            this.stateTimer = this._idleDuration();
            this.targetX = null;
          }
        } else if (!ladders.assignTree(this, plan)) {
          // Las się skończył — kończymy drabinę z gałęzi zamiast porzucać
          // całą pracę i zaczynać od zera przy następnej próbie.
          if (!ladders.beginGather(this, plan)) ladders.cancelProject(this);
        }
      }
      return;
    }

    this._walkTowardsTarget(dt, game, waterInfo);
  }

  /** Animowane wciągnięcie po drabinie na górny poziom. */
  _climbStep(dt) {
    const climb = this._climb;
    if (!climb) return;
    climb.t += dt;
    const t = clamp(climb.t / climb.duration, 0, 1);
    const eased = t * t * (3 - 2 * t);
    this.x = climb.fromX + (climb.toX - climb.fromX) * eased;
    this.y = climb.fromY + (climb.toY - climb.fromY) * eased;
    this.vx = 0;
    this.vy = 0;
    this.moveDir = 0;
    this.grounded = false;
    this.walkTime += dt * 2.4;
    this.state = "climb";

    if (t >= 1) {
      this._climb = null;
      this.x = climb.toX;
      this.y = climb.toY;
      this.grounded = true;
      this.state = "idle";
      this.stateTimer = rand(0.6, 1.8);
      this.targetX = null;
      this._needsLadder = false;
      this._trapCooldown = 1.5;
    }
  }

  /**
   * Wspólna decyzja o drabinie. `down` oznacza zejście ze skarpy, w
   * przeciwnym razie szukamy podejścia w górę.
   */
  _tryStartLadder(dir, down = false) {
    const ladders = this.population.game?.ladders;
    if (!ladders || !ladders.enabled) return;

    const wallTx = down
      ? this._findHighDropAhead(dir)
      : this._findHighWallAhead(dir);
    if (wallTx == null) {
      this._needsLadder = false;
      return;
    }
    this._needsLadder = true;

    // Gotowej drabiny może użyć każdy i o każdej porze — ograniczenia wieku,
    // nocy i paniki dotyczą wyłącznie budowy nowej (sprawdzane w ladders.tryStart).
    if (
      this._trapCooldown > 0 ||
      this.ladderBuild ||
      this.homeBuild ||
      this._climb
    ) {
      return;
    }

    const started = ladders.tryStart(this, { dir, wallTx, descent: down });
    this._trapCooldown = started
      ? 1.5
      : ladders.config.retrySeconds ?? 3;
    if (started) this._needsLadder = false;
  }

  /** Zbyt wysoka ściana przed postacią — próbuje zbudować drabinę w górę. */
  _registerFailedJump(dir) {
    this._tryStartLadder(dir, false);
  }

  /** Zbyt strome zejście — próbuje zbudować drabinę w dół. */
  _registerHighDrop(dir) {
    this._tryStartLadder(dir, true);
  }

  /** Pierwsza kolumna w danym kierunku, której grunt jest co najmniej 2 kafelki wyżej. */
  _findHighWallAhead(dir) {
    const ts = this.map.tileSize;
    const footRow = Math.round(this.y / ts);
    const startTx = Math.floor(this.x / ts);

    for (let k = 1; k <= 3; k++) {
      const tx = startTx + dir * k;
      if (tx < 1 || tx >= this.map.width - 1) return null;
      const topRow = this.map.surfaceRow(tx);
      if (footRow - topRow >= 2 && this.map.isSolidTile(tx, topRow)) {
        return tx;
      }
    }
    return null;
  }

  /** Najbliższa kolumna, pod którą grunt mocno opada (co najmniej 2 kafelki). */
  _findHighDropAhead(dir) {
    const ts = this.map.tileSize;
    const footRow = Math.round(this.y / ts);
    const startTx = Math.floor(this.x / ts);

    for (let k = 1; k <= 3; k++) {
      const tx = startTx + dir * k;
      if (tx < 1 || tx >= this.map.width - 1) return null;
      const aheadRow = this.map.surfaceRow(tx);
      if (aheadRow - footRow >= 2 && this.map.isSolidTile(tx, aheadRow)) {
        return tx;
      }
    }
    return null;
  }

  _fallAsleep(indoors = false) {
    if (this.memorialSiteId != null) this._leaveMemorial();
    this._needsLadder = false;
    this.sleepIndoors = indoors && this.homeId != null;
    this.state = "sleep";
    this.stateTimer = 0;
    this.targetX = null;
    this.partnerTarget = null;
    this.moveDir = 0;
    this.vx = 0;
    this.facing = chance(0.5) ? 1 : -1;
    this.sleepPhase = rand(0, 10);
  }

  _wake() {
    if (this.state !== "sleep") return;
    this.sleepIndoors = false;
    this.state = "idle";
    this.stateTimer = rand(0.4, 1.6);
    this.targetX = null;
    this.moveDir = 0;
  }

  _startMourn(site) {
    this.memorialSiteId = site.id;
    this.state = "mourn";
    this.stateTimer = rand(18, 28);
    this.targetX = this._memorialSpot(site);
    this.moveDir = 0;
  }

  /** Miejsce wokół obelisku, żeby żałobnicy nie stali w jednym punkcie. */
  _memorialSpot(site) {
    const ts = this.map.tileSize;
    const index = Math.max(0, site.participants.size - 1);
    const side = index % 2 === 0 ? 1 : -1;
    const ring = Math.ceil((index + 1) / 2);
    const offset = side * ring * ts * 0.55;
    return clamp(
      site.x + offset,
      ts * 2,
      this.map.pixelWidth - ts * 2
    );
  }

  _mourn(dt, game, waterInfo) {
    const site = game.memorials
      ? game.memorials.getSite(this.memorialSiteId)
      : null;
    if (!site) {
      this._leaveMemorial();
      this.state = "idle";
      this.stateTimer = this._idleDuration(this.isNight);
      this.targetX = null;
      this.moveDir = 0;
      return;
    }

    // Nocą żałoba się przerywa — ludzie wracają do snu.
    if (this.isNight && site.state !== "build") {
      this._leaveMemorial();
      this.state = "idle";
      this.stateTimer = rand(1, 2.5);
      this.targetX = null;
      this.moveDir = 0;
      return;
    }

    // Po wzniesieniu obelisku stoją jeszcze chwilę w ciszy.
    if (site.state === "done") {
      this.moveDir = 0;
      this.vx *= 0.8;
      this.facing = site.x >= this.x ? 1 : -1;
      return;
    }

    if (site.state !== "gather" && site.state !== "build") {
      this._leaveMemorial();
      this.state = "idle";
      this.stateTimer = this._idleDuration(this.isNight);
      this.targetX = null;
      this.moveDir = 0;
      return;
    }

    if (this.targetX == null) this.targetX = this._memorialSpot(site);
    if (Math.abs(this.x - this.targetX) < this.map.tileSize * 0.4) {
      this.targetX = null;
      this.moveDir = 0;
      this.vx *= 0.8;
      this.facing = site.x >= this.x ? 1 : -1;
      return;
    }

    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      // Nie dotarł na czas (np. drogę odcięła woda) — wraca do życia.
      this._leaveMemorial();
      this.state = "idle";
      this.stateTimer = this._idleDuration(this.isNight);
      this.targetX = null;
      this.moveDir = 0;
      return;
    }

    this._walkTowardsTarget(dt, game, waterInfo);
  }

  _leaveMemorial() {
    if (this.memorialSiteId == null) return;
    const memorials = this.population.game?.memorials;
    if (memorials) memorials.release(this);
    else this.memorialSiteId = null;
  }

  _flee(game, waterInfo, wadeDepth) {
    this.state = "flee";
    this.stateTimer -= 1 / 60;

    if (this.targetX == null || Math.abs(this.x - this.targetX) < this.map.tileSize * 0.7) {
      this.targetX = this._findHighGround(game);
      if (this.targetX == null) {
        this.targetX = this.x + (chance(0.5) ? -1 : 1) * this.map.tileSize * 8;
      }
    }

    if (this.targetX != null) {
      const dir = Math.sign(this.targetX - this.x) || 1;
      // Panika nie może popychać ludzi w przepaść. Bez tego uciekający
      // potrafili zbiec z wysokiej skarpy i utknąć na dnie.
      if (this._ledgeAhead(dir)) {
        this.targetX = null;
        this.facing = -dir;
        this.moveDir = -dir;
        this.stateTimer = Math.max(this.stateTimer, 0.4);
        return;
      }
      this.facing = dir;
      this.moveDir = dir;
    }

    // Uciekając, nie wchodź dobrowolnie w głęboką wodę.
    if (wadeDepth < this.config.height * 0.7) {
      const ahead = this.water.waterInfoAtX(this.x + this.facing * this.map.tileSize * 0.9);
      if (ahead.depth > this.config.height * 0.9) {
        this.moveDir = -this.facing;
        this.facing = this.moveDir;
        this.targetX = null;
      }
    }
  }

  _walkTowardsTarget(dt, game, waterInfo) {
    if (this.targetX == null) {
      this.moveDir = 0;
      return;
    }
    const dir = Math.sign(this.targetX - this.x);
    if (!dir) {
      this.moveDir = 0;
      return;
    }

    // Nie schodź dobrowolnie z wysokiej skarpy. Bez tego ludzie po wyjściu
    // po drabinie natychmiast wracali na krawędź i spadali z powrotem do dołu.
    // Sprawdzamy też tuż po starcie upadku (vy ~ 0), bo flaga `grounded`
    // migocze między klatkami, gdy grawitacja na moment unosi stopy.
    const ts = this.map.tileSize;
    const aheadTx = Math.floor((this.x + dir * ts * 1.15) / ts);
    const targetTx = Math.floor(this.targetX / ts);
    // Plac budowy drabiny w dół leży tuż przed krawędzią. Jeśli cel jest
    // jeszcze po tej stronie urwiska, dojdź do niego, zamiast anulować pracę.
    const targetBeyondLedge = (targetTx - aheadTx) * dir >= 0;
    if (
      this.state !== "flee" &&
      !this._climb &&
      this.vy < 140 &&
      this._ledgeAhead(dir) &&
      targetBeyondLedge
    ) {
      this.moveDir = 0;
      this.vx *= 0.5;
      if (this.state === "wander" || this.state === "social") {
        this.targetX = null;
        this.partnerTarget = null;
        this.state = "idle";
        this.stateTimer = rand(1, 2.5);
      } else if (this.state === "chop" || this.state === "build") {
        game?.housing?.cancelProject(this);
        this.state = "idle";
        this.stateTimer = rand(1, 2.5);
      } else if (this.state === "ladderChop" || this.state === "ladderBuild") {
        game?.ladders?.cancelProject(this);
        this.state = "idle";
        this.stateTimer = rand(1, 2.5);
      } else if (this.state === "sow" || this.state === "harvest") {
        game?.crops?.cancelProject(this);
        this.state = "idle";
        this.stateTimer = rand(1, 2.5);
      } else if (this.state === "home") {
        this.state = "idle";
        this.stateTimer = rand(1, 2.5);
        this.targetX = null;
      } else if (this.state === "pray") {
        // Miejsce kultu jest za urwiskiem — lepiej wrócić do życia niż
        // wpatrywać się w kamień z drugiej strony przepaści.
        game?.monoliths?.release(this);
        this.state = "idle";
        this.stateTimer = rand(1, 2.5);
        this.targetX = null;
      }
      return;
    }

    this.facing = dir;
    this.moveDir = dir;

    // Unikanie głębokiej wody podczas zwykłego spaceru.
    if (this.state !== "flee" && waterInfo.depth < this.config.height * 0.4) {
      const ahead = this.water.waterInfoAtX(this.x + dir * this.map.tileSize * 0.8);
      if (ahead.depth > this.config.height * 0.55) {
        // W drodze po ubranie nie porzucamy celu — po prostu nie wchodzimy
        // w wodę, a licznik i tak doprowadzi do ubrania.
        if (this.state === "reclothe") {
          this.moveDir = 0;
          return;
        }
        if (this.state === "pray") game?.monoliths?.release(this);
        this.targetX = null;
        this.state = "idle";
        this.stateTimer = rand(1, 2.5);
        this.moveDir = 0;
      }
    }
  }

  /** Czy tuż przed postacią grunt opada tak mocno, że nie da się wrócić? */
  _ledgeAhead(dir) {
    const ts = this.map.tileSize;
    const maxDrop = this.config.maxWalkDropTiles ?? 3;
    const fromTx = Math.floor(this.x / ts);
    const aheadTx = Math.floor((this.x + dir * ts * 1.15) / ts);
    if (aheadTx === fromTx) return false;
    const fromRow = this.map.surfaceRow(fromTx);
    const aheadRow = this.map.surfaceRow(aheadTx);
    return aheadRow - fromRow > maxDrop;
  }

  /**
   * Czy da się dojść do kolumny pieszo, bez wchodzenia na zbyt wysoką ścianę
   * i bez skoku w przepaść? Trasa jest sprawdzana kafelek po kafelku.
   */
  _reachableColumn(targetTx, maxDrop = this.config.maxWalkDropTiles ?? 3) {
    const ts = this.map.tileSize;
    const fromTx = Math.floor(this.x / ts);
    const step = Math.sign(targetTx - fromTx);
    if (!step) return true;
    let prev = this.map.surfaceRow(fromTx);
    for (let tx = fromTx + step; ; tx += step) {
      if (tx < 1 || tx >= this.map.width - 1) return false;
      const row = this.map.surfaceRow(tx);
      if (row < prev - 1) return false;
      if (row - prev > maxDrop) return false;
      prev = row;
      if (tx === targetTx) break;
    }
    return true;
  }

  _pickWanderTarget(game, preferLower = false, radiusScale = 1) {
    const ts = this.map.tileSize;
    const currentTx = Math.floor(this.x / ts);
    const housing = (game || this.population.game)?.housing;
    const home = this.homeId != null ? housing?.getHouse(this.homeId) : null;
    // Ludzie z domem krążą wokół niego, zamiast dryfować przez całą dolinę.
    const originTx = home && !preferLower ? Math.floor(home.x / ts) : currentTx;
    const originRow = this.map.surfaceRow(originTx);
    const currentRow = this.map.surfaceRow(currentTx);
    const spawnRow = this.map.surfaceRow(this.map.spawn.x);
    const highGround = originRow < spawnRow - 8;
    const seekLower = preferLower && highGround;
    const baseRadius = home && !preferLower
      ? this.config.homeWanderRadiusTiles ?? 12
      : (this.ageYears < this.config.childAge
        ? Math.max(4, this.config.wanderRadius * 0.55)
        : this.config.wanderRadius) * radiusScale;
    this.wanderCount++;
    // Co jakiś czas wybierz dalszy cel, żeby ludzie nie krążyli w kółko
    // po tym samym skrawku terenu (np. po jednym zboczu góry).
    // Nocą trasy są krótkie, więc dalsze wyprawy są wyłączone.
    const longTrip = this.wanderCount % 3 === 0;
    const explore = !home && !seekLower && radiusScale >= 0.8 && (longTrip || chance(0.18));
    const exploreRadius = this.ageYears < this.config.childAge
      ? Math.max(baseRadius, 10)
      : Math.max(baseRadius, 40);
    const radius = seekLower
      ? Math.max(baseRadius, 20)
      : explore
        ? exploreRadius
        : baseRadius;
    const attempts = seekLower ? 28 : 20;
    let best = null;
    let bestScore = -Infinity;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const tx = Math.round(originTx + rand(-radius, radius));
      if (tx < 3 || tx >= this.map.width - 3) continue;
      if (Math.abs(tx - originTx) < 2 && Math.abs(tx - currentTx) < 2) continue;
      const info = this.water.columnInfo(tx);
      if (info.depth > ts * 0.3) continue;
      const row = this.map.surfaceRow(tx);
      if (!this._reachableColumn(tx)) continue;
      const drop = row - originRow; // dodatnie = niżej
      const distanceFromOrigin = Math.abs(tx - originTx);
      const edge = Math.min(tx, this.map.width - 1 - tx);
      const edgePenalty = Math.max(0, 5 - edge) * 0.5;
      // Nie wybieraj krótkich, stromych wspinaczek na krawędź klifu:
      // kończyły się one chodzeniem w górę i w dół po tym samym murku.
      if (row < originRow - 2 && distanceFromOrigin < 5) continue;
      const uphillPenalty = drop < 0 ? -drop * 0.18 : 0;

      // Unikaj tłoku: cele blisko innych ludzi są mniej atrakcyjne.
      let crowd = 0;
      for (const other of this.population.people) {
        if (other === this) continue;
        if (Math.abs(other.x - (tx + 0.5) * ts) < ts * 2.4) crowd++;
      }

      // Po panice wyraźnie szukamy zejścia; na co dzień tylko na wysokim
      // gruncie delikatnie preferujemy niższy teren, żeby ludzie nie osiadali
      // na szczytach. Nisko położone skraje mapy nie przyciągają ich już w dół.
      const score = seekLower
        ? drop * 1.6 - distanceFromOrigin * 0.05 - crowd * 0.18 - edgePenalty + rand(0, 1.2)
        : highGround
          ? drop * 0.15 - uphillPenalty - distanceFromOrigin * 0.025 - crowd * 0.24 - edgePenalty + rand(0, 1.2)
          : -uphillPenalty - distanceFromOrigin * 0.025 - crowd * 0.24 - edgePenalty + rand(0, 1.2);
      if (score > bestScore) {
        bestScore = score;
        best = tx;
      }
    }

    if (best != null) {
      this.targetX = (best + 0.5) * ts;
      return;
    }
    this.state = "idle";
    this.stateTimer = rand(1, 3);
  }

  _findHighGround(game) {
    const ts = this.map.tileSize;
    const currentTx = Math.floor(this.x / ts);
    const currentRow = this.map.surfaceRow(currentTx);
    let best = null;
    let bestScore = -Infinity;

    for (let tx = currentTx - 15; tx <= currentTx + 15; tx += 2) {
      if (tx < 3 || tx >= this.map.width - 3) continue;
      const info = this.water.columnInfo(tx);
      if (info.depth > ts * 0.3) continue;
      const row = this.map.surfaceRow(tx);
      if (!this._reachableColumn(tx)) continue;
      const d = Math.abs(tx - currentTx);
      if (d < 2) continue;
      const score = (currentRow - row) * 1.5 - d * 0.12 + rand(0, 0.6);
      if (score > bestScore) {
        bestScore = score;
        best = tx;
      }
    }
    if (best == null) return null;
    return (best + 0.5) * ts;
  }

  _resolveOverlap() {
    const map = this.map;
    const step = 0.5;
    const maxShift = this.w * 2 + map.tileSize;

    for (let d = step; d <= maxShift; d += step) {
      if (!map.rectCollides(this.x - d, this.y, this.w, this.h)) {
        this.x -= d;
        return;
      }
      if (!map.rectCollides(this.x + d, this.y, this.w, this.h)) {
        this.x += d;
        return;
      }
    }

    // Awaryjnie: spróbuj podnieść postać o jeden kafelek.
    const up = this.y - map.tileSize;
    if (!map.rectCollides(this.x, up, this.w, this.h)) {
      this.y = up;
      this.grounded = false;
    }
  }

  _physics(dt) {
    const ts = this.map.tileSize;
    const map = this.map;
    const baseSpeed =
      this.state === "flee" || this.state === "reclothe"
        ? this.config.runSpeed
        : this.config.walkSpeed;

    const waterInfo = this.water.waterInfoAtX(this.x);
    let waterFactor = 1;
    if (waterInfo.depth > 0.8) {
      waterFactor = clamp(1 - waterInfo.depth / (this.h * 1.5), 0.18, 1) * this.config.waterSlowdown + 0.3;
    }

    let groupFactor = 1;
    if (this.group === "elder") groupFactor = 0.68;
    else if (this.group === "child") groupFactor = 0.82;

    let nightFactor = 1;
    if (this.isNight) nightFactor = this.config.nightSpeedFactor ?? 0.5;
    if (this.state === "flee" || this.state === "home" || this.state === "reclothe") nightFactor = 1;

    const speed = baseSpeed * this.speedVariation * groupFactor * waterFactor * nightFactor;
    const desiredVx = this.moveDir * speed;
    this.vx += (desiredVx - this.vx) * Math.min(1, dt * 11);

    // Wiatr popycha ciało w bok, niezależnie od woli postaci.
    if (Math.abs(this.windPush) > 0.5) {
      const wx = this.x + this.windPush * dt;
      if (!map.rectCollides(wx, this.y, this.w, this.h)) this.x = wx;
      this.windPush *= Math.max(0, 1 - dt * 5.5);
    } else {
      this.windPush = 0;
    }

    // Ruch poziomy + automatyczne wejście na krawędź wysokości jednego kafelka.
    if (Math.abs(this.vx) > 0.01) {
      const nx = this.x + this.vx * dt;
      if (!map.rectCollides(nx, this.y, this.w, this.h)) {
        this.x = nx;
        this.blockedTimer = Math.max(0, this.blockedTimer - dt);
      } else if (this.grounded) {
        const stepY = this.y - ts * 1.01;
        const dir = Math.sign(this.vx) || this.facing || 1;
        const stepX = nx + dir * (this.w * 0.55 + 1);
        if (!map.rectCollides(stepX, stepY, this.w, this.h)) {
          // Przesuń ciało na górny kafelek, nie tylko unieś je przy krawędzi.
          this.x = stepX;
          this.y = stepY;
          this.blockedTimer = Math.max(0, this.blockedTimer - dt);
        } else if (!map.rectCollides(nx, stepY, this.w, this.h)) {
          this.x = nx;
          this.y = stepY;
          this.blockedTimer = Math.max(0, this.blockedTimer - dt);
        } else {
          this.blockedTimer += dt;
          if (this.jumpCooldown <= 0 && chance(0.9)) {
            this.vy = -this.config.jumpVelocity;
            this.jumpCooldown = rand(0.7, 1.4);
            this.y -= 1;
            this._registerFailedJump(dir);
          }
        }
      } else {
        this.blockedTimer += dt;
      }
    }

    // Jeśli długo blokada, zawróć (chyba że ucieka albo właśnie próbuje
    // dostać się na zbyt wysoki poziom i czeka na drabinę).
    const ladderWork =
      this.ladderBuild ||
      this._climb ||
      this.state === "ladderChop" ||
      this.state === "ladderBuild" ||
      this.state === "climb";
    const checkDir = Math.sign(this.vx) || this.facing || 1;
    const highWall =
      ladderWork || this.blockedTimer < 0.3
        ? null
        : this._findHighWallAhead(checkDir);
    // Daj chwilę na rozpoczęcie budowy drabiny, ale nie stój w miejscu w
    // nieskończoność: po ~2,5 s zawróć i spróbuj innej drogi.
    const waitingForLadder =
      highWall != null && this._needsLadder && this.blockedTimer < 2.5;
    if (
      this.blockedTimer > 0.45 &&
      this.state !== "flee" &&
      this.state !== "shame" &&
      this.state !== "reclothe" &&
      !ladderWork &&
      !waitingForLadder
    ) {
      this._needsLadder = false;
      this.facing *= -1;
      this.moveDir = this.facing;
      this.targetX = null;
      this.state = "wander";
      this._pickWanderTarget(
        null,
        false,
        this.isNight ? this.config.nightWanderRadiusFactor ?? 0.45 : 1
      );
      this.blockedTimer = 0;
    }

    // Pion.
    this.vy = Math.min(this.vy + this.gravity * dt, 980);
    const dy = this.vy * dt;
    const steps = Math.max(1, Math.ceil(Math.abs(dy) / (ts * 0.5)));
    const stepDy = dy / steps;

    for (let s = 0; s < steps; s++) {
      const ny = this.y + stepDy;
      if (!map.rectCollides(this.x, ny, this.w, this.h)) {
        this.y = ny;
        this.grounded = false;
      } else if (stepDy > 0) {
        // Lądowanie: znalezienie górnej krawędzi kafelka pod stopami.
        let footRow = Math.floor((ny - 0.5) / ts);
        const tx = Math.floor(this.x / ts);
        while (footRow < map.height && !map.isSolidTile(tx, footRow)) footRow++;
        this.y = footRow * ts;
        this.vy = 0;
        this.grounded = true;
      } else {
        const headRow = Math.floor((ny - this.h) / ts);
        this.y = (headRow + 1) * ts + this.h;
        this.vy = 0;
      }
      if (this.grounded) break;
    }

    // Po upadku przy ścianie ciało może minimalnie wchodzić w kafelek.
    // Wypychamy je na najbliższą wolną stronę, żeby nie utknęło na krawędzi.
    if (map.rectCollides(this.x, this.y, this.w, this.h)) {
      this._resolveOverlap();
    }

    // Delikatna kolizja ze skrajami świata.
    const margin = this.w / 2 + 1;
    if (this.x < margin) this.x = margin;
    if (this.x > map.pixelWidth - margin) this.x = map.pixelWidth - margin;
    if (this.y > map.pixelHeight + 200) {
      this.population.kill(this, "przepaść");
    }
  }

  /** Przekazywane z pętli gry; noc wycisza aktywność, świt ją budzi. */
  setHour(hour) {
    const wasNight = this._isNight;
    this._hour = hour;
    const nowNight = this.isNight;

    if (wasNight === false && nowNight) {
      // Zmierzch: kończymy dłuższe spacery; ludzie szybko kładą się spać.
      if (this.state === "mourn") {
        this._leaveMemorial();
        this.state = "idle";
        this.stateTimer = rand(0.8, 2.4);
        this.targetX = null;
        this.moveDir = 0;
      } else if (
        this.state === "chop" ||
        this.state === "build" ||
        this.state === "ladderChop" ||
        this.state === "ladderBuild"
      ) {
        // Noc przerywa pracę; projekt czeka do rana.
        this.state = "idle";
        this.stateTimer = rand(0.6, 1.8);
        this.targetX = null;
        this.moveDir = 0;
        this._chopTimer = 0;
      } else if (this.state === "wander" || this.state === "idle") {
        const game = this.population.game;
        const house = this.homeId != null ? game.housing?.getHouse(this.homeId) : null;
        const ts = this.map.tileSize;
        let sentHome = false;
        if (house) {
          const maxDistance =
            (game.config.housing?.sleepHomeRadiusTiles ?? 40) * ts;
          const homeDistance = distance(this.x, this.y, house.x, house.y);
          if (homeDistance <= maxDistance && homeDistance > ts * 0.8) {
            this.state = "home";
            this.stateTimer = 20;
            this.targetX = house.x;
            this.moveDir = Math.sign(house.x - this.x) || 0;
            this.partnerTarget = null;
            sentHome = true;
          }
        }
        if (!sentHome) {
          if (this.state === "wander") {
            this.state = "idle";
            this.stateTimer = rand(0.8, 2.6);
            this.targetX = null;
            this.moveDir = 0;
            this.partnerTarget = null;
          } else {
            this.stateTimer = Math.min(this.stateTimer, rand(0.8, 2.8));
          }
        }
      }
    } else if (wasNight === true && !nowNight) {
      // Świt: śpiący wstają, a odpoczywający szybko wracają do spacerów.
      if (this.state === "sleep") {
        this.sleepIndoors = false;
        this.state = "idle";
        this.stateTimer = rand(0.3, 1.2);
        this.targetX = null;
        this.moveDir = 0;
      } else if (this.state === "home") {
        this.state = "idle";
        this.stateTimer = rand(0.4, 1.4);
        this.targetX = null;
        this.moveDir = 0;
      } else if (this.state === "idle") {
        this.stateTimer = Math.min(this.stateTimer, rand(0.2, 0.9));
      }
    }

    this._isNight = nowNight;
  }
}
