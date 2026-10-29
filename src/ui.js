import { clamp, formatHour } from "./utils.js?v=20261046-1";

export class UI {
  constructor(game) {
    this.game = game;
    this.el = {
      worldName: document.getElementById("world-name"),
      day: document.getElementById("stat-day"),
      clock: document.getElementById("stat-clock"),
      pop: document.getElementById("stat-pop"),
      ages: document.getElementById("stat-ages"),
      food: document.getElementById("stat-food"),
      foodWrap: document.getElementById("stat-food-wrap"),
      deaths: document.getElementById("stat-deaths"),
      energyFill: document.getElementById("energy-fill"),
      energyText: document.getElementById("energy-text"),
      lushRate: document.getElementById("lush-rate"),
      powerList: document.getElementById("power-list"),
      dock: document.getElementById("power-dock"),
      dockToggle: document.getElementById("btn-dock-toggle"),
      dockStatus: document.getElementById("dock-status"),
      dockStatusText: document.getElementById("dock-status-text"),
      btnDisarm: document.getElementById("btn-disarm"),
      toasts: document.getElementById("toasts"),
      tooltip: document.getElementById("tooltip"),
      speedControl: document.getElementById("speed-control"),
      intro: document.getElementById("intro"),
      pause: document.getElementById("pause"),
      btnStart: document.getElementById("btn-start"),
      btnResume: document.getElementById("btn-resume"),
      btnPause: document.getElementById("btn-pause"),
      btnAudio: document.getElementById("btn-audio"),
      btnSpeedMobile: document.getElementById("btn-speed-mobile"),
      fatal: document.getElementById("fatal"),
      fatalMessage: document.getElementById("fatal-message"),
      runtimeError: document.getElementById("runtime-error"),
      runtimeErrorMessage: document.getElementById("runtime-error-message"),
      btnRuntimeReload: document.getElementById("btn-runtime-reload"),
      btnRuntimeDismiss: document.getElementById("btn-runtime-dismiss"),
      gameOver: document.getElementById("game-over"),
      gameOverDays: document.getElementById("gameover-days"),
      gameOverDeaths: document.getElementById("gameover-deaths"),
      gameOverLush: document.getElementById("gameover-lush"),
      btnRestart: document.getElementById("btn-restart"),
    };
    this.powerCards = new Map();
    this.speedButtons = [];
    this.dockCollapsed = false;
    this._uiTimer = 0;
    this._last = {};
    this._lastDockStatus = "";
    this._activeChargeStop = null;
    this._runtimeErrorCount = 0;
    this._runtimeDismissedAt = 0;
    this._build();
  }

  _build() {
    const game = this.game;
    this.el.worldName.textContent = game.map.name;

    for (const power of game.powers.list) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "power-card";
      card.title = `${power.name} — ${power.description}`;
      card.style.setProperty("--power-color", power.color || "#e4573d");
      const levels = Math.max(1, power.strengthLevels ?? 1);
      const pips =
        levels > 1
          ? `<span class="power-strength">${Array.from(
              { length: levels },
              (_, i) =>
                `<span class="power-pip" data-level="${i + 1}" role="button" aria-label="Siła ${i + 1}"></span>`
            ).join("")}</span>`
          : "";
      card.innerHTML = `
        <span class="power-icon">${power.icon || "✦"}</span>
        <span class="power-info">
          <span class="power-name"><span>${power.name}</span><span class="power-cost">${game.powers.castCost(power)} Lush</span></span>
          <span class="power-desc">${power.description}</span>
          ${pips}
        </span>
      `;
      card.addEventListener("click", (event) => {
        // Po przytrzymaniu karty click jest tylko skutkiem ubocznym puszczenia
        // palca — nie może rozbroić właśnie uzbrojonej mocy.
        if (card.dataset.charging === "true") {
          delete card.dataset.charging;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const pip = event.target.closest(".power-pip");
        if (pip) {
          event.stopPropagation();
          game.powers.setStrength(power.id, Number(pip.dataset.level));
          this.refreshPowerCards();
          this._updatePowerCards();
          return;
        }
        // Kliknięcie karty uzbraja moc. Ponowne kliknięcie rozbraja ją
        // i przywraca domyślne przesuwanie mapy.
        game.powers.toggleArm(power.id);
        this.refreshPowerCards();
      });
      // Siłę mocy ładuje się przez przytrzymanie karty. Drobne stuknięcie
      // nadal uzbraja moc (jak dotychczas); dłuższe przytrzymanie podbija
      // poziom siły co kilkaset milisekund.
      let chargeTimeout = null;
      let chargeInterval = null;
      let didCharge = false;
      const stopCharge = () => {
        if (this._activeChargeStop === stopCharge) this._activeChargeStop = null;
        const wasCharging = chargeTimeout !== null || chargeInterval !== null;
        if (chargeTimeout) {
          window.clearTimeout(chargeTimeout);
          chargeTimeout = null;
        }
        if (chargeInterval) {
          window.clearInterval(chargeInterval);
          chargeInterval = null;
        }
        if (!wasCharging || !didCharge) return;
        didCharge = false;
        card.dataset.charging = "true";
        // Znacznik chroni przed potraktowaniem przytrzymania jako kliknięcia.
        // Zdejmujemy go sami, bo po puszczeniu palca poza kartą zdarzenie
        // click może nigdy nie przyjść i kolejne kliknięcie zostałoby zjedzone.
        window.setTimeout(() => delete card.dataset.charging, 700);
        game.powers.arm(power.id);
        game.ui.refreshPowerCards();
        game.ui._updatePowerCards?.();
      };
      card.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        const pip = event.target.closest(".power-pip");
        if (pip) return;
        // Nowe przytrzymanie anuluje poprzednie, nawet jeśli tamto zaczęło się
        // na innej karcie i nie doczekało się pointerup.
        this._activeChargeStop?.();
        didCharge = false;
        if (chargeTimeout) window.clearTimeout(chargeTimeout);
        if (chargeInterval) window.clearInterval(chargeInterval);
        this._activeChargeStop = stopCharge;
        chargeTimeout = window.setTimeout(() => {
          didCharge = true;
          const levels = Math.max(1, power.strengthLevels ?? 1);
          const current = game.powers.getStrength(power.id);
          const next = current >= levels ? 1 : current + 1;
          game.powers.setStrength(power.id, next);
          game.ui.refreshPowerCards();
          game.ui._updatePowerCards?.();
          chargeInterval = window.setInterval(() => {
            const now = game.powers.getStrength(power.id);
            const nxt = now >= levels ? 1 : now + 1;
            game.powers.setStrength(power.id, nxt);
            game.ui.refreshPowerCards();
            game.ui._updatePowerCards?.();
          }, 420);
        }, 380);
      });
      card.addEventListener("pointerup", stopCharge);
      card.addEventListener("pointerleave", stopCharge);
      card.addEventListener("pointercancel", stopCharge);

      this.el.powerList.appendChild(card);
      this.powerCards.set(power.id, card);
    }
    this.refreshPowerCards();

    for (const speed of game.config.time.speedOptions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "speed-btn";
      btn.dataset.speed = String(speed);
      btn.textContent = speed === 0 ? "❚❚" : `${speed}×`;
      btn.title = speed === 0 ? "Pauza" : `Prędkość czasu ${speed}×`;
      btn.addEventListener("click", () => game.setSpeed(speed));
      this.el.speedControl.appendChild(btn);
      this.speedButtons.push(btn);
    }

    this.el.btnStart.addEventListener("click", () => {
      try {
        game.start();
      } catch (error) {
        console.error(error);
        game.started = false;
        this.showFatal(`Nie udało się rozpocząć gry: ${error.message}`);
      }
    });
    this.el.btnResume.addEventListener("click", () => game.togglePause(false));
    this.el.btnPause.addEventListener("click", () => game.togglePause());
    this.el.btnRestart?.addEventListener("click", () => {
      window.location.reload();
    });
    this.el.btnSpeedMobile?.addEventListener("click", () => game.cycleSpeed(1));
    this.el.btnAudio.addEventListener("click", () => {
      const muted = game.audio.toggleMute();
      this.setMuted(muted);
    });
    this.el.btnDisarm?.addEventListener("click", () => {
      game.powers.disarm();
      this.refreshPowerCards();
    });

    // Uchwyt zwijania panelu mocy (telefony). Zwinięty pasek można też
    // kliknąć w dowolnym miejscu, żeby go rozwinąć.
    this.el.dockToggle?.addEventListener("click", (event) => {
      event.stopPropagation();
      this._setDockCollapsed(!this.dockCollapsed);
    });
    this.el.dock?.addEventListener("click", (event) => {
      if (!this.dockCollapsed) return;
      if (event.target.closest("#btn-dock-toggle")) return;
      this._setDockCollapsed(false);
    });

    document.addEventListener("visibilitychange", () => {
      // Po powrocie do karty wskaźnik nie jest już wciśnięty — ładowanie
      // siły musi się wtedy skończyć, niezależnie od kierunku zdarzenia.
      this._activeChargeStop?.();
      this._activeChargeStop = null;
      if (document.hidden && game.started && !game.paused) {
        game.togglePause(true);
      }
    });

    // Przytrzymanie karty musi się skończyć także wtedy, gdy wskaźnik
    // opuści kartę albo okno straci fokus. Inaczej interwał podbijania siły
    // działał dalej w tle i po pewnym czasie zamulał grę.
    const stopActiveCharge = () => {
      const stop = this._activeChargeStop;
      this._activeChargeStop = null;
      stop?.();
    };
    document.addEventListener("pointerup", stopActiveCharge, true);
    document.addEventListener("pointercancel", stopActiveCharge, true);
    window.addEventListener("blur", stopActiveCharge);

    this.el.btnRuntimeReload?.addEventListener("click", () => {
      window.location.reload();
    });
    this.el.btnRuntimeDismiss?.addEventListener("click", () => {
      this._runtimeDismissedAt = performance.now();
      this.el.runtimeError?.classList.add("hidden");
    });
  }

  startIntroHide() {
    if (this.el.intro) this.el.intro.classList.add("hidden");
  }

  setPaused(paused) {
    this.el.pause.classList.toggle("hidden", !paused);
    this.el.btnPause.textContent = paused ? "▶" : "❚❚";
  }

  /** Ekran końca gry: nie ma już nikogo, kto mógłby oddawać cześć bogu. */
  showGameOver(stats = {}) {
    if (this.el.gameOverDays) {
      this.el.gameOverDays.textContent = Math.max(1, Math.floor(stats.day ?? 1));
    }
    if (this.el.gameOverDeaths) {
      this.el.gameOverDeaths.textContent = Math.max(
        0,
        Math.floor(stats.deaths ?? 0)
      );
    }
    if (this.el.gameOverLush) {
      this.el.gameOverLush.textContent = Math.max(
        0,
        Math.round(stats.lush ?? 0)
      );
    }
    this.el.pause?.classList.add("hidden");
    this.el.tooltip?.classList.add("hidden");
    this.el.gameOver?.classList.remove("hidden");
  }

  setMuted(muted) {
    this.el.btnAudio.classList.toggle("is-off", muted);
    this.el.btnAudio.textContent = muted ? "✕" : "♪";
    this.el.btnAudio.title = muted ? "Włącz dźwięk" : "Wycisz dźwięk";
  }

  refreshPowerCards() {
    const powers = this.game.powers;
    // Uzbrojenie mocy zawsze rozwija panel, żeby było widać stan i Anuluj.
    if (powers.armedId && this.dockCollapsed) {
      this._setDockCollapsed(false);
    }
    for (const [id, card] of this.powerCards) {
      const power = powers.getPower(id);
      const armed = id === powers.armedId;
      card.classList.toggle("active", id === powers.selectedId);
      card.classList.toggle("armed", armed);
      card.setAttribute("aria-pressed", armed ? "true" : "false");
      if (power) {
        card.title = armed
          ? `${power.name} — gotowa. Wskaż miejsce na planszy.`
          : `${power.name} — ${power.description}`;
      }
    }
    this._updateDockStatus(true);
  }

  _updateDockStatus(force = false) {
    if (!this.el.dockStatus) return;
    const powers = this.game.powers;
    const power = powers.armed;
    let key = "idle";
    let html =
      '<span class="status-mouse">Wybierz kartę mocy, potem kliknij planszę. Przeciągnij, aby przesunąć mapę.</span>' +
      '<span class="status-touch">Dotknij karty mocy, potem planszy. Przeciągnij planszę, aby ją przesunąć.</span>';

    if (power) {
      const can = powers.canCast(power).ok;
      const level = powers.getStrength(power);
      key = `armed:${power.id}:${level}:${can ? "ok" : "no"}`;
      const icon = power.icon || "✦";
      const strengthText =
        (power.strengthLevels ?? 1) > 1 ? ` · siła ${level}` : "";
      html = can
        ? `<strong>${icon} ${power.name}</strong>${strengthText} — wskaż miejsce na planszy.`
        : `<strong>${icon} ${power.name}</strong>${strengthText} — ${powers.canCast(power).reason}`;
    }

    if (!force && key === this._lastDockStatus) return;
    this._lastDockStatus = key;
    this.el.dockStatus.classList.toggle("is-armed", !!power);
    const statusText = this.el.dockStatusText || this.el.dockStatus;
    statusText.innerHTML = html;
    if (this.el.btnDisarm) this.el.btnDisarm.hidden = !power;
    this.game.input?.update(0);
  }

  _setDockCollapsed(collapsed) {
    this.dockCollapsed = !!collapsed;
    const dock = this.el.dock;
    if (!dock) return;
    dock.classList.toggle("is-collapsed", this.dockCollapsed);
    const toggle = this.el.dockToggle;
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", String(!this.dockCollapsed));
    toggle.title = this.dockCollapsed ? "Rozwiń panel mocy" : "Zwiń panel mocy";
    const label = toggle.querySelector(".dock-toggle-text");
    if (label) label.textContent = this.dockCollapsed ? "Moce" : "Zwiń";
  }

  update(dt) {
    const game = this.game;
    this._uiTimer += dt;
    if (this._uiTimer < 0.08) return;
    this._uiTimer = 0;

    const day = Math.floor(game.day);
    const clock = formatHour(game.hour);
    this._setText("day", day);
    this._setText("clock", clock);
    const counts = game.population.counts();
    this._setText("pop", game.population.aliveCount);
    this._setText("ages", `${counts.children} / ${counts.adults} / ${counts.elders}`);
    this._setText("deaths", game.population.stats.godKills);

    const crops = game.crops;
    const food = Math.floor(crops?.food ?? 0);
    if (this._last.food !== food) {
      this._last.food = food;
      this.el.food.textContent = food;
      this.el.food.classList.toggle("is-empty", food <= 0);
    }
    if (this.el.foodWrap && crops) {
      const hungry = game.population.people.filter(
        (p) => p.alive && p.hunger >= 0.85
      ).length;
      const title = `Zapasy ziarna: ${food} / ${crops.foodMax} · głodni: ${hungry}`;
      if (this._last.foodTitle !== title) {
        this._last.foodTitle = title;
        this.el.foodWrap.title = title;
      }
    }

    this._updateEnergy();
    this._updatePowerCards();
    this._updateSpeedButtons();
  }

  _setText(key, value) {
    if (this._last[key] === value) return;
    this._last[key] = value;
    const el = this.el[key];
    if (el) el.textContent = value;
  }

  _updateEnergy() {
    const powers = this.game.powers;
    const max = powers.lushMax;
    const pct = clamp((powers.energy / max) * 100, 0, 100);
    const pctText = pct.toFixed(1);
    if (this._last.energyPct !== pctText) {
      this._last.energyPct = pctText;
      this.el.energyFill.style.width = `${pctText}%`;
    }
    const text = `${Math.floor(powers.energy)}/${Math.floor(max)}`;
    if (this._last.energyText !== text) {
      this._last.energyText = text;
      this.el.energyText.textContent = text;
    }

    const full = powers.energy >= max - 0.05;
    const income = powers.panicIncome;
    let rateText = "";
    let rateTitle = "";
    if (full) {
      rateText = "pełny";
      rateTitle = "Zbiornik Lush jest pełny — nadmiar powoli powiększa pojemność. Wydaj moc, by zebrać więcej.";
    } else if (income >= 0.05) {
      rateText = `+${income.toFixed(1)}/s`;
      rateTitle = `Przerażeni ludzie sączą ${income.toFixed(1)} Lush na sekundę.`;
    }
    if (this._last.lushRate !== rateText) {
      this._last.lushRate = rateText;
      this.el.lushRate.textContent = rateText;
      this.el.lushRate.hidden = rateText === "";
      this.el.lushRate.title = rateTitle;
      this.el.lushRate.classList.toggle("is-full", full && rateText !== "");
    }

    this.el.dock?.classList.toggle(
      "is-harvesting",
      powers.panicRate >= 0.05 && !full
    );
    this.el.dock?.classList.toggle("is-pulse", powers.harvestPulse > 0.1);
  }

  _updatePowerCards() {
    const powers = this.game.powers;
    for (const power of powers.list) {
      const card = this.powerCards.get(power.id);
      if (!card) continue;
      const frac = powers.cooldownFraction(power);
      const level = powers.getStrength(power);
      card.style.setProperty("--cooldown", frac.toFixed(3));
      card.classList.toggle("cooling", frac > 0.002);
      card.classList.toggle("no-energy", powers.energy < powers.castCost(power));
      card.classList.toggle("active", power.id === powers.selectedId);
      card.classList.toggle("armed", power.id === powers.armedId);
      const cost = card.querySelector(".power-cost");
      if (cost) cost.textContent = `${powers.castCost(power)} Lush`;
      const pips = card.querySelectorAll(".power-pip");
      pips.forEach((pip, index) => {
        pip.classList.toggle("active", index < level);
      });
      card.title =
        power.id === powers.armedId
          ? `${power.name} — gotowa. Wskaż miejsce na planszy.`
          : `${power.name} — ${power.description} (siła ${level})`;
    }
    this._updateDockStatus();
  }

  _updateSpeedButtons() {
    const paused = this.game.paused;
    for (const btn of this.speedButtons) {
      const speed = Number(btn.dataset.speed);
      const active = paused ? speed === 0 : speed === this.game.speed && speed !== 0;
      btn.classList.toggle("active", active);
    }
    if (this.el.btnSpeedMobile) {
      const label = `${this.game.speed}×`;
      if (this.el.btnSpeedMobile.textContent !== label) {
        this.el.btnSpeedMobile.textContent = label;
      }
      this.el.btnSpeedMobile.title = paused
        ? `Czas wstrzymany. Kliknij, aby wznowić (${this.game.speed}×).`
        : `Prędkość czasu ${this.game.speed}×. Kliknij, aby zmienić.`;
    }
  }

  toast(html, type = "") {
    const div = document.createElement("div");
    div.className = `toast ${type}`.trim();
    div.innerHTML = html;
    this.el.toasts.appendChild(div);
    while (this.el.toasts.children.length > 4) {
      this.el.toasts.removeChild(this.el.toasts.firstChild);
    }
    setTimeout(() => {
      div.classList.add("leaving");
      setTimeout(() => div.remove(), 450);
    }, 4600);
  }

  showTooltip(person, sx, sy) {
    if (!person) {
      this.hideTooltip();
      return;
    }
    const cfg = this.game.config.agents;
    const isChild = person.ageYears < cfg.childAge;
    const isElder = person.ageYears >= cfg.elderAge;
    const male = person.sex === "m";
    const sex = isChild ? (male ? "chłopiec" : "dziewczynka") : (male ? "mężczyzna" : "kobieta");
    const group = isChild ? "" : isElder ? (male ? "starszy" : "starsza") : (male ? "dorosły" : "dorosła");
    const details = [sex, group, `${person.age} lat`].filter(Boolean).join(" · ");
    let extra = "";
    if (person.isPregnant) {
      extra = `<div class="tag">w ciąży · ${Math.max(1, Math.ceil(person.pregnancyDays))} dni</div>`;
    } else if (person.state === "drown") {
      extra = `<div class="tag">tonie!</div>`;
    } else if (person.state === "flee") {
      extra = `<div class="tag">w panice</div>`;
    } else if (person.state === "ladderChop") {
      extra = `<div class="tag">ścina drzewo na drabinę</div>`;
    } else if (person.state === "ladderBuild") {
      extra = person.ladderBuild?.gather
        ? `<div class="tag">spina drabinę z gałęzi</div>`
        : `<div class="tag">buduje drabinę</div>`;
    } else if (person.state === "climb") {
      extra = `<div class="tag">wspina się po drabinie</div>`;
    } else if (person._needsLadder && !person._climb && !person.ladderBuild) {
      extra = `<div class="tag">nie może się wspiąć</div>`;
    }
    let hungerInfo = "";
    if (person.hunger >= 0.6 && person.hunger < 0.95) {
      hungerInfo = `<div class="tag">jest głodny</div>`;
    }
    let homeInfo = "";
    if (person.homeId != null) {
      const house = this.game.housing?.getHouse(person.homeId);
      if (house) {
        homeInfo = `<div class="tag">dom · ${house.familyName}</div>`;
      }
    } else if (person.homeBuild) {
      homeInfo = `<div class="tag">buduje własny dom</div>`;
    } else if (person.ladderBuild) {
      homeInfo = `<div class="tag">szuka drewna na drabinę</div>`;
    }
    const powers = this.game.powers;
    let lushInfo = "";
    if (powers) {
      const bits = [`żniwo ${Math.round(powers.deathLushFor(person))} Lush`];
      if (person.panicTimer > 0) {
        bits.unshift(`+${powers.panicRateFor(person).toFixed(2)} Lush/s`);
      }
      lushInfo = `<div class="lush-info">${bits.join(" · ")}</div>`;
    }
    const mother = person.motherId ? this.game.population.byId.get(person.motherId) : null;
    const father = person.fatherId ? this.game.population.byId.get(person.fatherId) : null;
    const parents = [];
    if (mother) parents.push(`matka: ${mother.name}`);
    if (father) parents.push(`ojciec: ${father.name}`);
    const family = person.ageYears < 8 && parents.length
      ? `<div class="muted">${parents.join(" · ")}</div>`
      : "";
    this.el.tooltip.innerHTML = `
      <strong>${person.name}</strong>
      <div class="muted">${details}</div>
      <div>${person.displayState}</div>
      ${extra}
      ${hungerInfo}
      ${homeInfo}
      ${lushInfo}
      ${family}
    `;
    this.el.tooltip.classList.remove("hidden");
    const rect = this.el.tooltip.getBoundingClientRect();
    let x = sx + 18;
    let y = sy - rect.height - 10;
    if (x + rect.width > window.innerWidth - 12) x = sx - rect.width - 16;
    if (y < 12) y = sy + 20;
    this.el.tooltip.style.left = `${x}px`;
    this.el.tooltip.style.top = `${y}px`;
  }

  hideTooltip() {
    this.el.tooltip.classList.add("hidden");
  }

  /** Pokazuje czytelny komunikat zamiast zostawiać gracza na ekranie powitalnym. */
  showFatal(message) {
    if (this.el.intro) this.el.intro.classList.add("hidden");
    if (this.el.fatal) this.el.fatal.classList.remove("hidden");
    if (this.el.fatalMessage && message) {
      this.el.fatalMessage.textContent = message;
    }
  }

  /**
   * Błąd pojedynczej klatki. Pętla gry sama się wznawia, więc nie blokujemy
   * ekranu — pokazujemy tylko pasek z możliwością odświeżenia.
   */
  showRuntimeError(error) {
    this._runtimeErrorCount++;
    const message =
      (error && error.message) || String(error ?? "Nieznany błąd");
    if (this.el.runtimeErrorMessage) {
      this.el.runtimeErrorMessage.textContent =
        this._runtimeErrorCount > 1
          ? `${message} (liczba błędów: ${this._runtimeErrorCount})`
          : message;
    }
    const banner = this.el.runtimeError;
    if (!banner) return;
    // Jeśli gracz właśnie ukrył komunikat, nie zasypujemy go kolejnymi.
    if (this._runtimeDismissedAt && performance.now() - this._runtimeDismissedAt < 30000) {
      return;
    }
    banner.classList.remove("hidden");
  }
}
