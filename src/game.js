import { WorldMap } from "./map.js?v=20261046-1";
import { WaterSystem } from "./water.js?v=20261046-1";
import { Population } from "./population.js?v=20261046-1";
import { Memorials } from "./memorials.js?v=20261046-1";
import { Weather } from "./weather.js?v=20261046-1";
import { Vegetation } from "./vegetation.js?v=20261046-1";
import { Housing } from "./housing.js?v=20261046-1";
import { Ladders } from "./ladders.js?v=20261046-1";
import { Monoliths } from "./monoliths.js?v=20261046-1";
import { Crops } from "./crops.js?v=20261046-1";
import { WindSystem } from "./wind.js?v=20261046-1";
import { Powers } from "./powers.js?v=20261046-1";
import { Effects } from "./effects.js?v=20261046-1";
import { Camera } from "./camera.js?v=20261046-1";
import { Renderer } from "./renderer.js?v=20261046-1";
import { AudioSystem } from "./audio.js?v=20261046-1";
import { Input } from "./input.js?v=20261046-1";
import { UI } from "./ui.js?v=20261046-1";
import { clamp } from "./utils.js?v=20261046-1";

const FIXED_STEP = 1 / 60;
// Ile milisekund na klatkę wolno poświęcić symulacji. Bez tego limitu wolne
// urządzenie przy prędkości 4× próbuje nadrobić cały zaległy czas (do 12
// kroków na klatkę), co spowalnia kolejną klatkę i tworzy spiralę zamrożenia.
const FRAME_BUDGET_MS = 8;

export class Game {
  constructor(canvas, config, mapData) {
    this.canvas = canvas;
    this.config = config;
    this.map = new WorldMap(mapData, config);

    this.dayProgress = 0;
    this.day = config.time.startDay;
    this.hour = config.time.startHour;
    this.speed = config.time.defaultSpeed || 1;
    this.started = false;
    this.paused = false;
    this.gameOver = false;
    this.screenFlash = 0;
    this.hoveredPerson = null;
    this._hoverTimer = 0;
    this._accumulator = 0;
    this._lastTime = performance.now();
    this._lastFrameAt = this._lastTime;
    this._lastRafStamp = -1;
    this._rafScheduled = false;
    this._watchdogTimer = null;
    this._errorCount = 0;
    this._errorLogAt = 0;
    this._lastError = null;
    this._loop = this._loop.bind(this);

    this.audio = new AudioSystem();
    this.effects = new Effects(this);
    this.water = new WaterSystem(this.map, config);
    this.weather = new Weather(this);
    this.camera = new Camera(this);
    this.population = new Population(this);
    this.memorials = new Memorials(this);
    this.monoliths = new Monoliths(this);
    this.powers = new Powers(this);
    this.vegetation = new Vegetation(this);
    this.housing = new Housing(this);
    this.ladders = new Ladders(this);
    this.crops = new Crops(this);
    this.wind = new WindSystem(this);

    this.renderer = new Renderer(this);
    this.renderer.resize();

    const spawnX = (this.map.spawn.x + 0.5) * this.map.tileSize;
    const spawnGround = this.map.groundYAtWorldX(spawnX);
    this.camera.init(spawnX, spawnGround - 150);

    this.population.spawnInitial();
    this.ui = new UI(this);
    this.input = new Input(this);

    this._onResize = () => {
      this.renderer.resize();
    };
    window.addEventListener("resize", this._onResize);

    // Po powrocie z innej karty przeglądarka potrafi oddać bardzo dużą różnicę
    // czasu albo wstrzymać requestAnimationFrame. Czyścimy licznik czasu, żeby
    // gra nie próbowała „dogonić” świata po kilku minutach nieobecności.
    this._onVisibility = () => {
      this._lastTime = performance.now();
      this._lastFrameAt = this._lastTime;
      this._accumulator = 0;
    };
    document.addEventListener("visibilitychange", this._onVisibility);

    // Niezależnie od wersji main.js: skoro świat jest gotowy, odblokuj start.
    window.__badgoodReady?.();
  }

  startLoop() {
    this._lastFrameAt = performance.now();
    this._scheduleNextFrame();
    // Strażnik: jeśli przeglądarka zgubi requestAnimationFrame (zdarza się po
    // uśpieniu telefonu), wznawiamy pętlę zamiast zostawiać martwy obraz.
    if (!this._watchdogTimer) {
      this._watchdogTimer = window.setInterval(() => this._watchdogTick(), 2000);
    }
    if (this.speed === 0) {
      this.paused = true;
      this.ui.setPaused(true);
    }
  }

  _scheduleNextFrame() {
    if (this._rafScheduled) return;
    this._rafScheduled = true;
    requestAnimationFrame(this._loop);
  }

  _watchdogTick() {
    if (document.hidden) {
      this._lastFrameAt = performance.now();
      return;
    }
    if (performance.now() - this._lastFrameAt < 1500) return;
    // Pętla nie żyje. Wyzeruj znacznik i poproś o kolejną klatkę; jeśli stara
    // klatka jednak wróci, jej znacznik czasu zostanie odrzucony w _loop.
    console.warn("Pętla gry zatrzymała się — wznawiam.");
    this._rafScheduled = false;
    this._lastTime = performance.now();
    this._accumulator = 0;
    this._scheduleNextFrame();
  }

  _loop(now) {
    this._rafScheduled = false;
    // Dwie klatki mogą trafić w ten sam znacznik czasu (np. po interwencji
    // strażnika). Drugą ignorujemy, żeby nie zdublować symulacji i rysowania.
    if (now === this._lastRafStamp) {
      this._scheduleNextFrame();
      return;
    }
    this._lastRafStamp = now;
    this._lastFrameAt = performance.now();

    try {
      this._frame(now);
    } catch (error) {
      this._handleLoopError(error);
    } finally {
      // Zawsze zamawiamy kolejną klatkę. Bez tego jeden wyjątek w dowolnym
      // systemie kończył grę na dobre — stąd zgłoszenia o całkowitym zawieszeniu.
      this._scheduleNextFrame();
    }
  }

  _frame(now) {
    const rawDt = Math.min(0.05, Math.max(0, (now - this._lastTime) / 1000));
    this._lastTime = now;

    if (this.started && !this.paused) {
      this._accumulator += rawDt * this.speed;
      let steps = 0;
      const start = performance.now();
      while (this._accumulator >= FIXED_STEP && steps < 12) {
        this._fixedUpdate(FIXED_STEP);
        this._accumulator -= FIXED_STEP;
        steps++;
        if (performance.now() - start >= FRAME_BUDGET_MS) break;
      }
      // Nie nadrabiamy zaległości ponad budżet klatki. Na wolnym telefonie
      // przy 4× resztki odkładały się z każdą klatką i gra stawała się coraz
      // wolniejsza, aż do całkowitego zamrożenia.
      if (this._accumulator >= FIXED_STEP) this._accumulator = 0;
    } else {
      this._accumulator = 0;
    }

    if (this.started) {
      this.camera.update(rawDt, this.input.keys);
      this.input.update();
      this._hoverTimer -= rawDt;
      if (this._hoverTimer <= 0 && this.input.mouse.inside && this.canCastNow()) {
        this._hoverTimer = 0.12;
        this.handleHover(this.input.mouse.x, this.input.mouse.y);
      }
    }

    const visualDt = this.started && this.paused ? 0 : rawDt;
    this.renderer.render(this, visualDt);
    this.ui.update(rawDt);
  }

  _handleLoopError(error) {
    this._lastError = error;
    this._errorCount++;
    const now = performance.now();
    // Logujemy najwyżej raz na sekundę; błąd w rysowaniu powtarzałby się
    // w każdej klatce i zalał konsolę.
    if (now - this._errorLogAt > 1000) {
      this._errorLogAt = now;
      console.error("Błąd podczas klatki gry:", error);
    }
    // Wyjątek mógł przerwać rysowanie w połowie stanu canvasu. Przywracamy
    // stos zapisów, żeby kolejna klatka zaczynała od czystej planszy.
    this.renderer.resetAfterError?.();
    this._accumulator = 0;
    try {
      this.ui.showRuntimeError(error);
    } catch (uiError) {
      console.error("Nie udało się pokazać komunikatu o błędzie:", uiError);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    try {
      this.paused = false;
      this.ui.startIntroHide();
      this.ui.setPaused(false);
      try {
        this.audio.ensure();
      } catch (audioError) {
        // Brak dźwięku nie może blokować wejścia do gry.
        console.warn("Nie udało się uruchomić dźwięku:", audioError);
      }
      this.ui.toast(
        "Ludzie nie wiedzą, że ich obserwujesz. Panika sączy Lush — śmierć oddaje żniwo.",
        "rain"
      );
    } catch (error) {
      // Pozwól spróbować ponownie, zamiast zostawiać grę w połowicznym stanie.
      this.started = false;
      throw error;
    }
  }

  togglePause(force) {
    if (!this.started || this.gameOver) return;
    this.paused = force == null ? !this.paused : force;
    this.ui.setPaused(this.paused);
    if (!this.paused && this.speed === 0) this.speed = 1;
    this.audio.ensure();
  }

  setSpeed(value) {
    if (!this.started || this.gameOver) return;
    if (value === 0) {
      this.paused = true;
      this.ui.setPaused(true);
      return;
    }
    this.speed = value;
    this.paused = false;
    this.ui.setPaused(false);
  }

  cycleSpeed(dir) {
    if (!this.started) return;
    const options = this.config.time.speedOptions.filter((v) => v > 0);
    let idx = options.indexOf(this.speed);
    if (idx < 0) idx = 0;
    idx = (idx + dir + options.length) % options.length;
    this.setSpeed(options[idx]);
  }

  canCastNow() {
    return this.started && !this.paused;
  }

  handleCast(screenX, screenY) {
    if (!this.canCastNow()) return false;
    const power = this.powers.armed;
    if (!power) return false;
    const world = this.camera.screenToWorld(screenX, screenY);
    if (world.x < 0 || world.x > this.map.pixelWidth) return false;
    const cast = this.powers.castArmed(
      clamp(world.x, 4, this.map.pixelWidth - 4),
      clamp(world.y, 0, this.map.pixelHeight)
    );
    if (cast) {
      // Po udanym rzuceniu wracamy do domyślnego trybu przesuwania mapy.
      this.powers.disarm();
      this.ui.refreshPowerCards();
    }
    this.handleHover(screenX, screenY);
    return cast;
  }

  handleHover(screenX, screenY) {
    if (!this.started || this.paused || this.powers.armed) {
      this.hoveredPerson = null;
      this.ui.hideTooltip();
      return;
    }
    const world = this.camera.screenToWorld(screenX, screenY);
    const person = this.population.findAt(world.x, world.y);
    this.hoveredPerson = person;
    if (person) this.ui.showTooltip(person, screenX, screenY);
    else this.ui.hideTooltip();
  }

  hideTooltip() {
    this.hoveredPerson = null;
    this.ui.hideTooltip();
  }

  _fixedUpdate(dt) {
    if (this.gameOver) return;
    this.dayProgress += dt / this.config.time.secondsPerDay;
    this.day = this.config.time.startDay + Math.floor(this.dayProgress);
    const dayFraction = this.dayProgress % 1;
    this.hour = (this.config.time.startHour + dayFraction * 24) % 24;

    this.population.update(dt, this);
    if (this.population.aliveCount === 0) {
      this._triggerGameOver();
      return;
    }
    this.housing.update(dt);
    this.crops.update(dt);
    this.ladders.update(dt);
    this.memorials.update(dt);
    this.monoliths?.update(dt);
    this.weather.update(dt);
    this.vegetation.update(dt);
    this.wind.update(dt);
    this.water.update(dt);
    this.powers.update(dt);
    this.effects.update(dt);
    this.audio.update(dt, this.weather.cover);
    this.screenFlash = Math.max(0, this.screenFlash - dt * 3.4);

    if (this.hoveredPerson && !this.hoveredPerson.alive) {
      this.hoveredPerson = null;
      this.ui.hideTooltip();
    }
  }

  /** Gdy nie ma już nikogo, kto czciłby boga, dolina umiera razem z ludźmi. */
  _triggerGameOver() {
    if (this.gameOver) return;
    this.gameOver = true;
    this.paused = true;
    this.hoveredPerson = null;
    this.ui.hideTooltip?.();
    this.ui.showGameOver({
      day: this.day,
      deaths: this.population.stats.deaths,
      births: this.population.stats.births,
      lush: this.powers.totalLush,
    });
  }
}
