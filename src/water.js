/**
 * Woda jako siatka poziomów (0..1) wypełniająca niepełne kafelki.
 * Deszcz dolewa wodę od góry, a grawitacja i wyrównywanie poziomów
 * rozprowadzają ją po zagłębieniach. Woda powoli paruje, więc jeziora
 * powstałe z deszczu są tymczasowe.
 */
export class WaterSystem {
  constructor(map, config) {
    this.map = map;
    this.config = config.water;
    this.theme = config.theme.water;
    this.w = map.width;
    this.h = map.height;
    this.maxLevel = this.config.maxLevel;
    this.levels = new Float32Array(this.w * this.h);
    this.fixed = new Uint8Array(this.w * this.h);
    this.time = 0;
    this.accumulator = 0;
    this._colCache = null;
    this._minTX = this.w;
    this._maxTX = -1;
    for (let i = 0; i < map.length; i++) {
      if (map.waterKind[i]) {
        this.levels[i] = this.maxLevel;
        this.fixed[i] = 1;
        const tx = i % this.w;
        if (tx < this._minTX) this._minTX = tx;
        if (tx > this._maxTX) this._maxTX = tx;
      }
    }
    // Gdy nie ma wody deszczowej, a jezioro jest pełne, tick nie ma nic do
    // zrobienia. Oszczędza to skanowanie całej mapy 24 razy na sekundę.
    this.active = false;
  }

  idx(tx, ty) {
    return ty * this.w + tx;
  }

  levelAt(tx, ty) {
    if (tx < 0 || tx >= this.w || ty < 0 || ty >= this.h) return 0;
    return this.levels[ty * this.w + tx];
  }

  update(dt) {
    this.time += dt;
    this.accumulator += dt;
    const step = 1 / (this.config.tickRate || 24);
    let guard = 0;
    while (this.accumulator >= step && guard < 4) {
      this.accumulator -= step;
      this.tick(step);
      guard++;
    }
  }

  tick(dt) {
    if (!this.active) return;
    const { levels, fixed, map } = this;
    const w = this.w;
    const h = this.h;
    const max = this.maxLevel;
    const evap = (this.config.evaporationPerSecond || 0) * dt;
    const refill = (this.config.refillFixedPerSecond || 0) * dt;

    // Skanujemy tylko kolumny, w których faktycznie może być woda (plus
    // margines na przepływ boczny). Mapa ma 260 kolumn, jezioro kilkanaście.
    const x0 = Math.max(0, this._minTX - 3);
    const x1 = Math.min(w - 1, this._maxTX + 3);
    let minTX = w;
    let maxTX = -1;
    let dynamic = false;
    let needsRefill = false;

    // Parowanie i uzupełnianie stałych zbiorników.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        const i = row + x;
        let lvl = levels[i];
        if (lvl <= 0) continue;
        if (fixed[i]) {
          if (lvl < max) {
            lvl = Math.min(max, lvl + refill);
            levels[i] = lvl;
            needsRefill = true;
          }
        } else {
          lvl -= evap;
          // Próg resztek jest bardzo niski, bo lekki deszcz dokłada wodę
          // wolniej niż paruje w ciągu jednego ticku. Przy wyższym progu
          // kałuże poziomu 1 nigdy by nie powstały.
          if (lvl < 0.0002) lvl = 0;
          levels[i] = lvl;
          if (lvl > 0) dynamic = true;
        }
        if (lvl > 0) {
          if (x < minTX) minTX = x;
          if (x > maxTX) maxTX = x;
        }
      }
    }

    const flowSpeed = this.config.flowSpeed ?? 0.7;
    const iterations = this.config.flowIterations || 2;
    const eps = 0.0005;

    for (let it = 0; it < iterations; it++) {
      // 1. Opadanie w dół (od dołu, żeby strumienie spadały płynnie).
      for (let y = h - 2; y >= 0; y--) {
        const row = y * w;
        const rowBelow = row + w;
        for (let x = x0; x <= x1; x++) {
          const i = row + x;
          const lvl = levels[i];
          if (lvl <= eps) continue;
          if (map.solid[i]) continue;
          const bi = rowBelow + x;
          if (map.solid[bi]) continue;
          const cap = max - levels[bi];
          if (cap <= eps) continue;
          const move = Math.min(lvl, cap);
          levels[i] -= move;
          levels[bi] += move;
        }
      }

      // 2. Wyrównywanie w poziomie. Woda przelewa się tylko z podpartego
      //    kafelka (stoi na ziemi lub na pełnej wodzie), więc kropelki
      //    w powietrzu nie rozmywają się na boki.
      for (let y = h - 1; y >= 0; y--) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          const a = row + x;
          const b = a + 1;
          if (map.solid[a] || map.solid[b]) continue;
          const la = levels[a];
          const lb = levels[b];
          const diff = la - lb;
          if (Math.abs(diff) <= 0.002) continue;

          let source = a;
          let target = b;
          if (diff < 0) {
            source = b;
            target = a;
          }
          const sourceLevel = levels[source];
          if (sourceLevel <= eps) continue;

          const belowSource = source + w;
          const supported =
            belowSource >= levels.length ||
            map.solid[belowSource] ||
            levels[belowSource] >= max - 0.01;
          if (!supported) continue;

          const cap = max - levels[target];
          if (cap <= eps) continue;
          const transfer = Math.min(cap, Math.abs(diff) * 0.5 * flowSpeed);
          if (transfer <= eps) continue;
          levels[source] -= transfer;
          levels[target] += transfer;
        }
      }
    }

    // Usuń resztki, żeby rendering nie rysował mgły wodnej. Renderer
    // i tak pomija lustra płytsze niż piksel, więc próg może być niski.
    // Przy okazji wyznaczamy nowe granice i stan aktywności.
    minTX = w;
    maxTX = -1;
    dynamic = false;
    needsRefill = false;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        const i = row + x;
        let lvl = levels[i];
        if (!fixed[i] && lvl < 0.0002) {
          levels[i] = 0;
          lvl = 0;
        }
        if (lvl <= 0) continue;
        if (x < minTX) minTX = x;
        if (x > maxTX) maxTX = x;
        if (fixed[i]) {
          if (lvl < max - 0.001) needsRefill = true;
        } else {
          dynamic = true;
        }
      }
    }

    this._minTX = minTX;
    this._maxTX = maxTX;
    this.active = minTX <= maxTX && (dynamic || needsRefill);
  }

  /** Dolewa deszcz do kolumn w promieniu. */
  addRain(worldX, radiusPx, amountPerSecond, dt) {
    const ts = this.map.tileSize;
    const radiusTiles = radiusPx / ts;
    const centerTile = Math.floor(worldX / ts);
    const x0 = Math.max(0, Math.floor(centerTile - radiusTiles));
    const x1 = Math.min(this.w - 1, Math.ceil(centerTile + radiusTiles));
    const max = this.maxLevel;
    if (x0 <= x1) {
      this.active = true;
      if (x0 < this._minTX) this._minTX = x0;
      if (x1 > this._maxTX) this._maxTX = x1;
    }

    for (let tx = x0; tx <= x1; tx++) {
      const dx = (tx - centerTile) / radiusTiles;
      const falloff = Math.max(0, 1 - dx * dx);
      if (falloff <= 0) continue;
      const ground = this.map.surfaceRow(tx);
      let ty = ground - 1;
      if (ty < 0) continue;
      let i = this.idx(tx, ty);
      if (this.map.solid[i]) continue;

      // Znajdź najwyższy możliwy kafelek w kolumnie (deszcz pada na szczyt).
      let guard = 0;
      while (ty > 0 && this.levels[i] >= max - 0.002 && !this.map.solid[i - this.w] && guard++ < 40) {
        ty--;
        i = this.idx(tx, ty);
      }
      if (this.levels[i] >= max - 0.001) continue;
      const add = amountPerSecond * falloff * dt;
      this.levels[i] = Math.min(max, this.levels[i] + add);
    }
  }

  /**
   * Informacje o słupie wody nad gruntem w danej kolumnie.
   * top = pikselowa wysokość lustra wody (null, gdy sucho).
   */
  /** Teren właśnie się zmienił: rozszerzamy skanowanie wody i pozwalany jej
   *  wypełnić nowe, puste kafelki. Po dosypaniu ziemi usuwamy też wodę
   *  z kafelków, które wciąż jej nie powinny zawierać. */
  terrainChanged(tx0 = 0, tx1 = this.w - 1) {
    const lo = Math.max(0, Math.min(tx0, tx1) - 2);
    const hi = Math.min(this.w - 1, Math.max(tx0, tx1) + 2);
    if (lo < this._minTX) this._minTX = lo;
    if (hi > this._maxTX) this._maxTX = hi;
    let hasWater = false;
    for (let x = lo; x <= hi; x++) {
      for (let y = 0; y < this.h; y++) {
        const i = y * this.w + x;
        if (this.map.solid[i]) {
          if (this.levels[i] > 0) { this.levels[i] = 0; }
          continue;
        }
        if (this.levels[i] > 0.001) hasWater = true;
      }
    }
    if (hasWater) this.active = true;
  }

  columnInfo(tx, out = {}) {
    if (tx < 0 || tx >= this.w) {
      out.groundRow = this.h;
      out.groundY = this.map.pixelHeight;
      out.top = null;
      out.depth = 0;
      return out;
    }
    const groundRow = this.map.surfaceRow(tx);
    const groundY = groundRow * this.map.tileSize;
    let ty = groundRow - 1;
    let top = null;
    let guard = 0;
    while (ty >= 0 && guard++ < 80) {
      const i = this.idx(tx, ty);
      if (this.map.solid[i]) break;
      const lvl = this.levels[i];
      if (lvl <= 0.012) break;
      top = (ty + (1 - Math.min(1, lvl))) * this.map.tileSize;
      ty--;
    }
    out.groundRow = groundRow;
    out.groundY = groundY;
    out.top = top;
    out.depth = top == null ? 0 : Math.max(0, groundY - top);
    return out;
  }

  waterInfoAtX(worldX) {
    return this.columnInfo(Math.floor(worldX / this.map.tileSize));
  }

  /** Czy punkt (np. głowa człowieka) jest pod lustrem wody? */
  isUnderwater(worldX, worldY) {
    const info = this.waterInfoAtX(worldX);
    return info.top != null && worldY > info.top && worldY < info.groundY;
  }

  /** Głębokość wody w pikselach pod daną pozycją X. */
  depthAt(worldX) {
    return this.waterInfoAtX(worldX).depth;
  }

  /** Czy w promieniu jest choć trochę wody? (dla zachowań ludzi) */
  hasWaterNear(worldX, radiusTiles = 3) {
    const ts = this.map.tileSize;
    const cx = Math.floor(worldX / ts);
    for (let tx = cx - radiusTiles; tx <= cx + radiusTiles; tx++) {
      const info = this.columnInfo(tx);
      if (info.depth > ts * 0.25) return true;
    }
    return false;
  }

  /** Wysokość lustra wody w pikselach (null gdy brak). Używane przez renderer. */
  surfaceYAt(tx) {
    return this.columnInfo(tx).top;
  }
}
