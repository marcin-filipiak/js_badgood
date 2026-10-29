import {
  TAU,
  clamp,
  smoothstep,
  hash2,
  mixColor,
  rgba,
  rand,
  lerp,
  ageGroup,
} from "./utils.js?v=20261046-1";

/** Gładki szum wartościowy (0..1) bez prostokątnej siatki. */
function valueNoise2(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

export class Renderer {
  constructor(game) {
    this.game = game;
    this.canvas = game.canvas;
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.time = 0;
    this.terrainChunks = [];
    this.terrainLayer = null;
    // `?terrain=direct` jest awaryjnym trybem dla przeglądarek, które nie
    // potrafią wyświetlić terenu z pomocniczych canvasów.
    const terrainParam = new URLSearchParams(window.location.search).get("terrain");
    this.terrainMode = terrainParam === "direct" ? "direct" : "chunks";
    this._mainTerrainProbeDone = false;
    this.vignette = null;
    this.personShadow = null;
    this.stars = [];
    this.starField = null;
    this.decorClouds = [];
    this.foreground = [];
    this.terrainColors = null;
    this._initAtmosphere();
    this._buildTerrainColors();
    this._buildTerrain();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.game.camera.resize(w, h);
    this._buildVignette();
    this.starField = null;
    this._buildStarField();
  }

  /** Gwiazdy rysowane raz do warstwy; co klatkę wystarczy drawImage. */
  _buildStarField() {
    if (this.width <= 0 || this.height <= 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(this.width));
    canvas.height = Math.max(1, Math.round(this.height));
    const g = canvas.getContext("2d");
    if (!g) return;
    for (const s of this.stars) {
      const alpha = 0.55 + 0.45 * Math.sin(s.phase);
      g.fillStyle = `rgba(235, 242, 255, ${alpha.toFixed(3)})`;
      g.beginPath();
      g.arc(s.x * canvas.width, s.y * canvas.height, s.r, 0, TAU);
      g.fill();
    }
    this.starField = canvas;
  }

  _initAtmosphere() {
    for (let i = 0; i < 130; i++) {
      this.stars.push({
        x: Math.random(),
        y: Math.random() * 0.7,
        r: rand(0.5, 1.5),
        phase: rand(0, TAU),
        speed: rand(0.5, 1.7),
      });
    }
    for (let i = 0; i < 12; i++) {
      this.decorClouds.push({
        x: rand(-400, 3000),
        y: rand(40, 280),
        w: rand(110, 280),
        h: rand(20, 55),
        alpha: rand(0.1, 0.35),
        speed: rand(2, 7),
        seed: rand(0, 100),
      });
    }
  }

  _buildTerrainColors() {
    const map = this.game.map;
    const theme = this.game.config.theme;
    this.terrainColors = new Array(map.length).fill(null);
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const i = ty * map.width + tx;
        if (!map.solid[i]) continue;
        const ch = map.tiles[i];
        const def = map.legend[ch] || map.legend["#"];
        const surface = def.surface || "grass";
        const depth = Math.max(0, ty - map.surface[tx]);
        const depthT = clamp(depth / 38, 0, 1);

        // Nieregularne łaty i warstwy zamiast twardej siatki 4x5 kafelków.
        // Gleba nadal ma czytelne "bloki" tonu, ale ich krawędzie są miękkie,
        // więc nie widać prostych pionowych ani poziomych szwów.
        const patch =
          valueNoise2(tx / 4.6, ty / 3.4, 1) * 0.62 +
          valueNoise2(tx / 1.9, ty / 1.5, 9) * 0.38;
        const strata =
          0.5 + 0.5 * Math.sin(ty * 0.52 + valueNoise2(tx / 7, ty / 6, 21) * 2.4);
        const tone = clamp(patch * 0.72 + strata * 0.28, 0, 1);
        // Kwantyzacja ogranicza liczbę kolorów, ale jej schodki są zbyt subtelne,
        // by zbudować widoczną krawędź.
        const toneQ = Math.round(tone * 32) / 32;

        if (surface === "snow") {
          this.terrainColors[i] = mixColor("#cfdbe4", "#eef6fa", toneQ);
          continue;
        }
        const palette = surface === "rock" || ch === "m" ? theme.rock : theme.soil;
        const base = mixColor(palette[0], palette[2] || palette[0], toneQ * 0.3);
        const depthQ = Math.round(depthT * 24) / 24;
        this.terrainColors[i] = mixColor(base, "#2e2118", depthQ * 0.5);
      }
    }
  }

  _buildTerrain() {
    const map = this.game.map;
    const ts = map.tileSize;
    // Nie rysuj całej mapy na jednym wielkim canvasie. Mniejsze kawałki są
    // bezpieczniejsze dla Firefoksa i kart graficznych z niskim limitem tekstury.
    // Rozmiar można zmienić w config/game.json -> terrain.chunkSize.
    const configuredChunk = Number(this.game.config.terrain.chunkSize) || 512;
    const chunkSize = Math.max(128, Math.min(1024, Math.floor(configuredChunk)));
    this.terrainChunkSize = chunkSize;
    this.terrainChunks = [];
    if (this.terrainMode === "direct") return;

    this._ensureTerrainLayer();

    for (let cy = 0; cy < map.pixelHeight; cy += chunkSize) {
      for (let cx = 0; cx < map.pixelWidth; cx += chunkSize) {
        const w = Math.min(chunkSize, map.pixelWidth - cx);
        const h = Math.min(chunkSize, map.pixelHeight - cy);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.className = "terrain-chunk";
        canvas.setAttribute("aria-hidden", "true");
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;

        // Firefox potrafi nie namalować canvasu, który nie jest częścią DOM.
        // Trzymamy więc warstwy terenu w ukrytym, ale podłączonym kontenerze.
        this.terrainLayer.appendChild(canvas);
        this.terrainChunks.push({ canvas, x: cx, y: cy, w, h });
        this._paintTerrainChunkCanvas(canvas, cx, cy, w, h);
      }
    }

    this._probeTerrainChunks();
    console.info(
      `[Bad Good] Terrain renderer: ${this.terrainMode}` +
        (this.terrainMode === "chunks"
          ? ` (${this.terrainChunks.length} chunks @ ${this.terrainChunkSize}px)`
          : "")
    );
  }

  _ensureTerrainLayer() {
    if (this.terrainLayer) {
      this.terrainLayer.replaceChildren();
      return;
    }
    const layer = document.createElement("div");
    layer.className = "terrain-layer";
    layer.setAttribute("aria-hidden", "true");
    // Styl także inline, żeby stara wersja styles.css nie odsłoniła warstw.
    layer.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;overflow:visible;" +
      "opacity:0.01;pointer-events:none;z-index:-1;";
    document.body.appendChild(layer);
    this.terrainLayer = layer;
  }

  _probeTerrainChunks() {
    if (this.terrainMode === "direct" || !this.terrainChunks.length) return;
    try {
      const map = this.game.map;
      const ts = map.tileSize;
      let index = -1;
      for (let i = 0; i < map.solid.length; i++) {
        if (map.solid[i]) {
          index = i;
          break;
        }
      }
      if (index < 0) return;
      const tx = index % map.width;
      const ty = Math.floor(index / map.width);
      const wx = tx * ts + ts / 2;
      const wy = ty * ts + ts / 2;
      const chunk = this.terrainChunks.find(
        (c) => wx >= c.x && wx < c.x + c.w && wy >= c.y && wy < c.y + c.h
      );
      if (!chunk) return;

      const probe = document.createElement("canvas");
      probe.width = 1;
      probe.height = 1;
      const pctx = probe.getContext("2d", { willReadFrequently: true });
      if (!pctx) return;
      pctx.drawImage(chunk.canvas, wx - chunk.x, wy - chunk.y, 1, 1, 0, 0, 1, 1);
      const pixel = pctx.getImageData(0, 0, 1, 1).data;
      if (pixel[3] === 0) {
        console.warn(
          "[Bad Good] Terrain chunks are empty in this browser; switching to direct terrain rendering."
        );
        this.terrainMode = "direct";
        this.terrainChunks = [];
        if (this.terrainLayer) this.terrainLayer.replaceChildren();
      }
    } catch (error) {
      // Odczyt piksela może być zablokowany przez ochronę canvasu. Bezpieczniej
      // jest wtedy rysować teren wprost, niż pokazać pustą dolinę.
      console.warn(
        "[Bad Good] Terrain chunk probe was blocked; using direct terrain rendering.",
        error
      );
      this.terrainMode = "direct";
      this.terrainChunks = [];
      if (this.terrainLayer) this.terrainLayer.replaceChildren();
    }
  }

  _paintTerrainTile(ctx, map, tx, ty, ts) {
    const i = ty * map.width + tx;
    if (!map.solid[i]) return;
    const ch = map.tiles[i];
    const def = map.legend[ch] || map.legend["#"];
    const surface = def.surface || "grass";
    const x = tx * ts;
    const y = ty * ts;
    const h1 = hash2(tx, ty, 1);
    const h2 = hash2(tx, ty, 7);

    ctx.fillStyle = (this.terrainColors && this.terrainColors[i]) || "#5f4129";
    ctx.fillRect(x, y, ts + 1, ts + 1);

    // Tekstura podziemi.
    if (h2 < 0.18) {
      ctx.fillStyle = "rgba(20, 12, 8, 0.18)";
      ctx.fillRect(x + 3 + h1 * 8, y + 4 + h2 * 8, 2, 2);
    }
    if (h2 > 0.88) {
      ctx.fillStyle = "rgba(255, 230, 190, 0.06)";
      ctx.fillRect(x + 2, y + 7, 5, 1);
    }

    const aboveAir = ty === 0 || !map.solid[(ty - 1) * map.width + tx];
    if (aboveAir) this._paintSurface(ctx, map, tx, ty, x, y, ts, surface, ch, h1, h2);

    // Krawędzie klifów.
    const leftAir = tx === 0 || !map.solid[ty * map.width + tx - 1];
    const rightAir = tx === map.width - 1 || !map.solid[ty * map.width + tx + 1];
    if (leftAir) {
      ctx.fillStyle = "rgba(255, 236, 200, 0.08)";
      ctx.fillRect(x, y, 2, ts);
    }
    if (rightAir) {
      ctx.fillStyle = "rgba(15, 10, 8, 0.22)";
      ctx.fillRect(x + ts - 2, y, 2, ts);
    }
  }

  _paintTerrainChunkCanvas(canvas, cx, cy, w, h, map = this.game.map, ts = this.game.map.tileSize) {
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(-cx, -cy);
    const tx0 = Math.max(0, Math.floor(cx / ts));
    const tx1 = Math.min(map.width - 1, Math.ceil((cx + w) / ts));
    const ty0 = Math.max(0, Math.floor(cy / ts));
    const ty1 = Math.min(map.height - 1, Math.ceil((cy + h) / ts));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        this._paintTerrainTile(ctx, map, tx, ty, ts);
      }
    }
    this._paintTerrainStrata(ctx, map, tx0, tx1, ty0, ty1, ts);
  }

  refreshTerrainRegion(tx0, ty0, tx1, ty1) {
    if (this.terrainMode === "direct" || !this.terrainChunks || !this.terrainChunks.length) return;
    const map = this.game.map;
    const ts = map.tileSize;
    this._buildTerrainColors();
    const left = tx0 * ts;
    const right = (tx1 + 1) * ts;
    const top = ty0 * ts;
    const bottom = (ty1 + 1) * ts;
    for (const chunk of this.terrainChunks) {
      if (
        chunk.x + chunk.w < left ||
        chunk.x > right ||
        chunk.y + chunk.h < top ||
        chunk.y > bottom
      ) continue;
      this._paintTerrainChunkCanvas(chunk.canvas, chunk.x, chunk.y, chunk.w, chunk.h, map, ts);
    }
  }

  /**
   * Warstwy geologiczne rysowane w świecie, a nie per kafelek. Dzięki temu
   * linia nie zaczyna się i nie kończy na granicy kafelka/chunka, tylko płynie
   * łagodną falą przez całą szerokość odsłoniętej gleby.
   */
  _paintTerrainStrata(ctx, map, tx0, tx1, ty0, ty1, ts) {
    // Fala rośnie z odległością w świecie, więc sąsiednie chunki trafiają
    // dokładnie w te same punkty.
    const wave = (wx, band) =>
      Math.sin(wx * 0.016 + band * 1.7) * 1.8 +
      Math.sin(wx * 0.041 - band * 0.9) * 0.9;

    ctx.lineWidth = 1;
    ctx.lineCap = "butt";

    for (let ty = ty0; ty <= ty1; ty++) {
      const bands = [];
      if (hash2(0, ty, 15) < 0.34) {
        bands.push({ offset: 0, style: "rgba(38, 24, 14, 0.10)" });
      }
      if (hash2(0, ty, 19) > 0.87) {
        bands.push({ offset: 3, style: "rgba(255, 224, 176, 0.035)" });
      }
      if (!bands.length) continue;

      for (const band of bands) {
        const baseY = ty * ts + ((ty * 7) % ts) + band.offset;
        ctx.beginPath();
        let pen = false;
        for (let tx = tx0; tx <= tx1; tx++) {
          const i = ty * map.width + tx;
          // Tylko ukryta gleba/skała, nigdy trawa ani odsłonięta powierzchnia.
          const underground = map.solid[i] && ty > 0 && map.solid[i - map.width];
          if (!underground) {
            pen = false;
            continue;
          }
          const x = tx * ts;
          const y1 = baseY + wave(x, ty);
          const y2 = baseY + wave(x + ts, ty);
          if (!pen) ctx.moveTo(x, y1);
          else ctx.lineTo(x, y1);
          ctx.lineTo(x + ts, y2);
          pen = true;
        }
        ctx.strokeStyle = band.style;
        ctx.stroke();
      }
    }
  }

  _paintSurface(ctx, map, tx, ty, x, y, ts, surface, ch, h1, h2) {
    const theme = this.game.config.theme;
    if (surface === "grass" || surface === "forest") {
      const colors = surface === "forest" ? theme.forest : theme.grass;
      const base = colors[Math.floor(h1 * colors.length) % colors.length];
      ctx.fillStyle = base;
      ctx.fillRect(x, y, ts + 1, surface === "forest" ? 7 : 6);
      ctx.fillStyle = rgba(base, 0.55);
      ctx.fillRect(x, y, ts + 1, 2);

      // Trawa.
      const blades = 2 + Math.floor(h2 * 4);
      ctx.strokeStyle = rgba(base, 0.8);
      ctx.lineWidth = 1;
      for (let i = 0; i < blades; i++) {
        const bx = x + 2 + ((i * 7 + h1 * 12) % (ts - 3));
        const bh = 3 + ((i * 3 + h2 * 7) % 5);
        ctx.beginPath();
        ctx.moveTo(bx, y + 1);
        ctx.lineTo(bx + (h1 - 0.5) * 2, y - bh);
        ctx.stroke();
      }

      // Kwiaty i zioła.
      if (surface === "grass" && h2 > 0.58) {
        const fx = x + 3 + h1 * (ts - 6);
        const petal = h2 > 0.82 ? "#e8c873" : h2 > 0.7 ? "#c9b4e8" : "#f0f0dc";
        ctx.fillStyle = petal;
        ctx.beginPath();
        ctx.arc(fx, y - 3, 1.1, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = "rgba(60, 90, 40, 0.5)";
        ctx.beginPath();
        ctx.moveTo(fx, y - 2);
        ctx.lineTo(fx, y + 1);
        ctx.stroke();
      }
      if (surface === "forest" && h2 > 0.72) {
        const fx = x + 4 + h1 * (ts - 8);
        ctx.fillStyle = "rgba(110, 90, 40, 0.55)";
        ctx.beginPath();
        ctx.ellipse(fx, y - 1.5, 1.2, 0.8, h1 * 2, 0, TAU);
        ctx.fill();
      }
    } else if (surface === "rock") {
      ctx.fillStyle = "#7d828d";
      ctx.beginPath();
      ctx.moveTo(x, y + 2);
      for (let i = 0; i <= 4; i++) {
        const px = x + (i / 4) * ts;
        const py = y + 1 + hash2(tx * 4 + i, ty, 3) * 4;
        ctx.lineTo(px, py);
      }
      ctx.lineTo(x + ts, y + 6);
      ctx.lineTo(x, y + 6);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(240, 245, 255, 0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + 2);
      ctx.lineTo(x + ts, y + 2);
      ctx.stroke();
    } else if (surface === "dirt") {
      const base = mixColor(theme.soil[0], theme.soil[2] || theme.soil[0], h1 * 0.12);
      ctx.fillStyle = base;
      ctx.fillRect(x, y, ts + 1, surface === "dirt" ? 4 : 6);
      ctx.fillStyle = rgba(base, 0.35);
      ctx.fillRect(x, y, ts + 1, 2);
      // Bryłki ziemi na nasypie — widać, że to nie darń, tylko fresh posyp.
      ctx.fillStyle = `rgba(21, 15, 10, 0.16)`;
      for (let i = 0; i < 2 + Math.floor(h2 * 3); i++) {
        const dx = 2 + Math.floor(hash2(tx + i, ty, 2) * (ts - 4));
        const dy = 1 + Math.floor(hash2(tx, ty + i, 3) * 2);
        ctx.fillRect(x + dx, y + dy, 2, 1);
      }
    } else if (surface === "snow") {
      ctx.fillStyle = "#f3f8fb";
      ctx.beginPath();
      ctx.moveTo(x, y + 5);
      ctx.quadraticCurveTo(x + ts * 0.5, y - 4 - h1 * 3, x + ts, y + 4);
      ctx.lineTo(x + ts, y + 7);
      ctx.lineTo(x, y + 7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(160, 190, 210, 0.5)";
      ctx.fillRect(x, y + 6, ts, 1);
    }

    // Ciemniejsza linia pod darnią / śniegiem.
    if (surface !== "rock" && surface !== "dirt") {
      ctx.fillStyle = "rgba(25, 18, 12, 0.18)";
      ctx.fillRect(x, y + 7, ts + 1, 1);
    }
  }

  _buildVignette() {
    const c = document.createElement("canvas");
    c.width = Math.max(2, this.width);
    c.height = Math.max(2, this.height);
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(
      c.width / 2,
      c.height * 0.46,
      Math.min(c.width, c.height) * 0.32,
      c.width / 2,
      c.height * 0.5,
      Math.max(c.width, c.height) * 0.72
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.72, "rgba(0,0,0,0.12)");
    g.addColorStop(1, "rgba(0,0,0,0.46)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    this.vignette = c;
  }

  _buildPersonShadow() {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 32);
    g.addColorStop(0, "rgba(12, 16, 12, 0.3)");
    g.addColorStop(0.55, "rgba(12, 16, 12, 0.16)");
    g.addColorStop(1, "rgba(12, 16, 12, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.personShadow = c;
  }

  render(game, dt) {
    this.time += dt;
    const ctx = this.ctx;
    const camera = game.camera;
    const hour = game.hour;
    const daylight = this._daylight(hour);
    const dusk = this._dusk(hour);

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawSky(ctx, daylight, dusk, game);
    this._drawRidges(ctx, daylight, dusk, game);
    this._drawDecorClouds(ctx, daylight, game);

    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.offsetX, -camera.offsetY);

    const view = this._viewRect(camera);
    this._drawTerrainWorld(ctx, view, camera);
    this._drawDecals(ctx, game);
    this._drawMemorials(ctx, game, view);
    this._drawMonoliths(ctx, game, view);
    this._drawHouses(ctx, game, view);
    this._drawCrops(ctx, game, view);
    this._drawTrees(ctx, view, game);
    this._drawLadders(ctx, game, view);
    this._drawPeople(ctx, game, view);
    this._drawWater(ctx, view, game, daylight);
    this._drawRain(ctx, game, view, daylight);
    this._drawWind(ctx, game, view);
    this._drawEffects(ctx, game, view);
    this._drawCursorWorld(ctx, game);
    ctx.restore();

    // Nakładki ekranowe.
    this._drawWeatherTint(ctx, game);
    this._drawNightTint(ctx, daylight);
    if (this.vignette) ctx.drawImage(this.vignette, 0, 0, this.width, this.height);
    this._drawScreenFlash(ctx, game);
    this._drawCursorUI(ctx, game);
    ctx.restore();
  }

  /**
   * Po wyjątku w środku klatki stos save/restore może zostać otwarty.
   * restore() na pustym stosie nic nie robi, więc kilka wywołań jest
   * bezpieczne i przywraca czysty stan przed kolejną klatką.
   */
  resetAfterError() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (let i = 0; i < 8; i++) {
      try {
        ctx.restore();
      } catch (error) {
        break;
      }
    }
    try {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    } catch (error) {
      // Canvas mógł zostać utracony (np. po uśpieniu telefonu). Nic więcej
      // nie zrobimy tutaj; kolejna klatka spróbuje narysować od nowa.
    }
  }

  /* ------------------------------------------------------------------ */
  /* NIEBO I TŁO                                                         */
  /* ------------------------------------------------------------------ */

  _daylight(hour) {
    const alt = Math.sin(((hour - 6) / 24) * TAU);
    return smoothstep(-0.12, 0.22, alt);
  }

  _dusk(hour) {
    const alt = Math.sin(((hour - 6) / 24) * TAU);
    return clamp(1 - Math.abs(alt) / 0.42, 0, 1);
  }

  _drawSky(ctx, daylight, dusk, game) {
    const sky = game.config.theme.sky;
    const top = mixColor(sky.nightTop, sky.dayTop, daylight);
    const bottom = mixColor(sky.nightBottom, sky.dayBottom, daylight);
    const topDusk = mixColor(top, sky.duskTop, dusk * 0.8);
    const bottomDusk = mixColor(bottom, sky.duskBottom, dusk * 0.85);

    const grad = ctx.createLinearGradient(0, 0, 0, this.height);
    grad.addColorStop(0, topDusk);
    grad.addColorStop(0.62, bottomDusk);
    grad.addColorStop(1, mixColor(bottomDusk, "#2a2b2f", 0.25 * (1 - daylight) + 0.06));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.width, this.height);

    // Gwiazdy.
    if (daylight < 0.9) {
      if (!this.starField) this._buildStarField();
      if (this.starField) {
        ctx.save();
        ctx.globalAlpha = (1 - daylight) * 0.9;
        ctx.drawImage(this.starField, 0, 0, this.width, this.height);
        ctx.restore();
      }
    }

    // Słońce / księżyc.
    const sunAlt = Math.sin(((game.hour - 6) / 24) * TAU);
    if (sunAlt > -0.12) {
      const t = (game.hour - 6) / 12;
      const sx = this.width * (0.07 + t * 0.86);
      const sy = this.height * 0.62 - Math.sin(clamp(t, 0, 1) * Math.PI) * this.height * 0.44;
      const glow = ctx.createRadialGradient(sx, sy, 6, sx, sy, 120);
      glow.addColorStop(0, "rgba(255, 234, 175, 0.5)");
      glow.addColorStop(0.3, "rgba(255, 214, 140, 0.16)");
      glow.addColorStop(1, "rgba(255, 210, 140, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(sx - 120, sy - 120, 240, 240);
      ctx.fillStyle = sky.sun;
      ctx.beginPath();
      ctx.arc(sx, sy, 18, 0, TAU);
      ctx.fill();
    } else {
      const t = ((game.hour + 6) % 24) / 12;
      const sx = this.width * (0.07 + t * 0.86);
      const sy = this.height * 0.62 - Math.sin(clamp(t, 0, 1) * Math.PI) * this.height * 0.42;
      const glow = ctx.createRadialGradient(sx, sy, 4, sx, sy, 70);
      glow.addColorStop(0, "rgba(220, 235, 255, 0.3)");
      glow.addColorStop(1, "rgba(220, 235, 255, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(sx - 70, sy - 70, 140, 140);
      ctx.fillStyle = sky.moon;
      ctx.beginPath();
      ctx.arc(sx, sy, 12, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(170, 190, 220, 0.25)";
      ctx.beginPath();
      ctx.arc(sx - 3, sy - 2, 2.4, 0, TAU);
      ctx.arc(sx + 4, sy + 4, 1.8, 0, TAU);
      ctx.fill();
    }

    // Ciepła poświata przy horyzoncie.
    if (dusk > 0.02) {
      const hg = ctx.createLinearGradient(0, this.height * 0.45, 0, this.height * 0.8);
      hg.addColorStop(0, "rgba(255, 160, 100, 0)");
      hg.addColorStop(0.6, `rgba(255, 145, 90, ${dusk * 0.2})`);
      hg.addColorStop(1, "rgba(255, 120, 80, 0)");
      ctx.fillStyle = hg;
      ctx.fillRect(0, this.height * 0.4, this.width, this.height * 0.45);
    }
  }

  _drawRidges(ctx, daylight, dusk, game) {
    const camera = game.camera;
    const shift = (camera.cy - game.map.pixelHeight * 0.65) * 0.03;
    const farBase = this.height * 0.63 - shift;
    const nearBase = this.height * 0.76 - shift * 1.5;

    const farColor = mixColor(
      mixColor("#2c3d4d", "#93aeb0", daylight),
      "#7c6a67",
      dusk * 0.32
    );
    const nearColor = mixColor(
      mixColor("#1a2b2a", "#4f6b52", daylight),
      "#4f4a46",
      dusk * 0.28
    );

    ctx.save();
    this._mountainPath(ctx, farBase, 92, camera.cx * 0.03, 330, 0.42);
    const farGrad = ctx.createLinearGradient(0, farBase - 110, 0, farBase + 60);
    farGrad.addColorStop(0, rgba(farColor, 0.34));
    farGrad.addColorStop(0.55, rgba(farColor, 0.58));
    farGrad.addColorStop(1, rgba(farColor, 0.3));
    ctx.fillStyle = farGrad;
    ctx.fill();

    // Odległe, zamglone bory na pierwszym grzbiecie.
    ctx.fillStyle = rgba(mixColor(farColor, "#1c3a2c", 0.42), 0.34);
    ctx.beginPath();
    ctx.moveTo(-20, farBase + 46);
    for (let sx = -20; sx <= this.width + 30; sx += 9) {
      const wx = sx + camera.cx * 0.03;
      const y = this._mountainY(wx, farBase, 92, 330, 0.42);
      const hx = hash2(Math.floor(wx / 9), 5, 7);
      const th = 2 + hx * 5.5;
      if (hx > 0.52) {
        ctx.lineTo(sx, y - th);
        ctx.lineTo(sx + 4.4, y - th * 0.32);
      } else {
        ctx.quadraticCurveTo(sx + 4.5, y - th * 1.12, sx + 9, y - th * 0.24);
      }
    }
    ctx.lineTo(this.width + 30, farBase + 46);
    ctx.closePath();
    ctx.fill();

    // Mgła nad horyzontem.
    const haze = ctx.createLinearGradient(0, this.height * 0.36, 0, this.height * 0.74);
    haze.addColorStop(0, "rgba(210, 228, 230, 0)");
    haze.addColorStop(0.68, `rgba(205, 225, 228, ${0.2 + dusk * 0.12})`);
    haze.addColorStop(1, "rgba(205, 225, 228, 0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, this.height * 0.34, this.width, this.height * 0.42);

    this._mountainPath(ctx, nearBase, 86, camera.cx * 0.075, 230, 3.1);
    const nearGrad = ctx.createLinearGradient(0, nearBase - 100, 0, nearBase + 90);
    nearGrad.addColorStop(0, rgba(nearColor, 0.72));
    nearGrad.addColorStop(0.7, rgba(nearColor, 0.92));
    nearGrad.addColorStop(1, rgba(nearColor, 0.55));
    ctx.fillStyle = nearGrad;
    ctx.fill();

    // Ciemna ściana lasu na bliższym grzbiecie — świerki przeplatane koronami liściastymi.
    ctx.fillStyle = rgba(mixColor(nearColor, "#0a1a12", 0.62), 0.9);
    ctx.beginPath();
    ctx.moveTo(-20, nearBase + 52);
    for (let sx = -20; sx <= this.width + 30; sx += 8) {
      const wx = sx + camera.cx * 0.075;
      const y = this._mountainY(wx, nearBase, 86, 230, 3.1);
      const hx = hash2(Math.floor(wx / 8), 3, 9);
      const th = 4 + hx * 13;
      if (hx > 0.42) {
        // Świerk: ostry wierzchołek i szeroka podstawa.
        ctx.lineTo(sx, y - th);
        ctx.lineTo(sx + 3.6, y - th * 0.38);
      } else {
        // Dąb lub lipa: zaokrąglona korona.
        ctx.quadraticCurveTo(sx + 4, y - th * 1.08, sx + 8, y - th * 0.28);
      }
    }
    ctx.lineTo(this.width + 30, nearBase + 52);
    ctx.closePath();
    ctx.fill();

    // Ciepła smuga łąk u podnóża lasu.
    ctx.strokeStyle = rgba(
      mixColor("#8fa85a", "#ffe9a8", dusk * 0.4),
      0.12 + daylight * 0.16
    );
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let sx = -20; sx <= this.width + 30; sx += 11) {
      const y = this._mountainY(sx + camera.cx * 0.075, nearBase, 86, 230, 3.1);
      if (sx === -20) ctx.moveTo(sx, y + 1.2);
      else ctx.lineTo(sx, y + 1.2);
    }
    ctx.stroke();
    ctx.restore();
  }

  _valueNoise(x, seed) {
    const i = Math.floor(x);
    const f = x - i;
    const t = f * f * (3 - 2 * f);
    const a = hash2(i, seed, 41);
    const b = hash2(i + 1, seed, 41);
    return a + (b - a) * t;
  }

  _mountainY(wx, base, amp, scale, seed) {
    let n = 0;
    let a = 1;
    let total = 0;
    let freq = 1 / scale;
    for (let o = 0; o < 4; o++) {
      n += this._valueNoise(wx * freq, seed + o * 13) * a;
      total += a;
      a *= 0.52;
      freq *= 2.1;
    }
    n /= total;
    return base - Math.pow(n, 1.55) * amp;
  }

  _mountainPath(ctx, base, amp, offset, scale, seed) {
    ctx.beginPath();
    ctx.moveTo(-20, this.height + 20);
    for (let sx = -20; sx <= this.width + 30; sx += 7) {
      const wx = sx + offset;
      ctx.lineTo(sx, this._mountainY(wx, base, amp, scale, seed));
    }
    ctx.lineTo(this.width + 30, this.height + 20);
    ctx.closePath();
  }

  _drawDecorClouds(ctx, daylight, game) {
    const camera = game.camera;
    for (const c of this.decorClouds) {
      const x = ((c.x - camera.cx * 0.12 + this.time * c.speed) % (this.width + 500)) - 250;
      const y = c.y - (camera.cy - game.map.pixelHeight * 0.6) * 0.02;
      const alpha = c.alpha * (0.4 + daylight * 0.6);
      ctx.fillStyle = `rgba(245, 248, 250, ${alpha})`;
      for (let i = 0; i < 5; i++) {
        const ox = (i - 2) * c.w * 0.2;
        const oy = Math.sin(i * 1.7 + c.seed) * c.h * 0.18;
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, c.w * (0.24 + 0.06 * (i % 3)), c.h * (0.55 + 0.1 * (i % 2)), 0, 0, TAU);
        ctx.fill();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* ŚWIAT                                                              */
  /* ------------------------------------------------------------------ */

  _viewRect(camera) {
    return {
      left: camera.offsetX - this.width / (2 * camera.zoom) - 40,
      right: camera.offsetX + this.width / (2 * camera.zoom) + 40,
      top: camera.offsetY - this.height / (2 * camera.zoom) - 40,
      bottom: camera.offsetY + this.height / (2 * camera.zoom) + 40,
      pxPerTile: camera.zoom,
    };
  }

  _drawTerrainWorld(ctx, view, camera) {
    if (this.terrainMode === "direct") {
      this._drawTerrainDirect(ctx, view);
      return;
    }
    if (!this.terrainChunks || !this.terrainChunks.length) {
      // Nie zostawiaj gracza z dziurą w świecie, jeśli chunki nie powstały.
      this.terrainMode = "direct";
      this._drawTerrainDirect(ctx, view);
      return;
    }

    // Jednorazowa kontrola: upewnij się, że drawImage() naprawdę trafia na
    // główny canvas. Jeśli nie, przełączamy się na rysowanie kafelków wprost.
    if (!this._mainTerrainProbeDone) {
      this._mainTerrainProbeDone = true;
      const probe = this._findTerrainProbe(view, camera);
      if (probe) {
        let before = null;
        try {
          before = ctx.getImageData(probe.px, probe.py, 1, 1).data;
        } catch (error) {
          before = null;
        }
        this._drawTerrainChunks(ctx, view);
        if (before) {
          try {
            const after = ctx.getImageData(probe.px, probe.py, 1, 1).data;
            if (
              after[0] === before[0] &&
              after[1] === before[1] &&
              after[2] === before[2] &&
              after[3] === before[3]
            ) {
              console.warn(
                "[Bad Good] Terrain chunks were not painted; switching to direct terrain rendering."
              );
              this.terrainMode = "direct";
              this.terrainChunks = [];
              if (this.terrainLayer) this.terrainLayer.replaceChildren();
              this._drawTerrainDirect(ctx, view);
            }
          } catch (error) {
            // Ochrona canvasu może blokować getImageData; zostajemy przy chunkach.
          }
        }
        return;
      }
    }

    this._drawTerrainChunks(ctx, view);
  }

  _drawTerrainChunks(ctx, view) {
    for (const chunk of this.terrainChunks) {
      if (
        chunk.x + chunk.w < view.left ||
        chunk.x > view.right ||
        chunk.y + chunk.h < view.top ||
        chunk.y > view.bottom
      ) {
        continue;
      }
      ctx.drawImage(chunk.canvas, chunk.x, chunk.y);
    }
  }

  _findTerrainProbe(view, camera) {
    const map = this.game.map;
    const ts = map.tileSize;
    const tx0 = Math.max(0, Math.floor(view.left / ts));
    const tx1 = Math.min(map.width - 1, Math.ceil(view.right / ts));
    const ty0 = Math.max(0, Math.floor(view.top / ts));
    const ty1 = Math.min(map.height - 1, Math.ceil(view.bottom / ts));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = ty * map.width + tx;
        if (!map.solid[i]) continue;
        // Wybierz głęboki kafelek, którego nie zasłoni woda, drzewo ani człowiek.
        if (ty - map.surface[tx] < 3) continue;
        const screen = camera.worldToScreen(tx * ts + ts / 2, ty * ts + ts / 2);
        if (
          screen.x < 8 ||
          screen.y < 8 ||
          screen.x > this.width - 8 ||
          screen.y > this.height - 8
        ) {
          continue;
        }
        return {
          px: Math.floor(screen.x * this.dpr),
          py: Math.floor(screen.y * this.dpr),
        };
      }
    }
    return null;
  }

  _drawTerrainDirect(ctx, view) {
    const map = this.game.map;
    const ts = map.tileSize;
    const tx0 = Math.max(0, Math.floor(view.left / ts));
    const tx1 = Math.min(map.width - 1, Math.ceil(view.right / ts));
    const ty0 = Math.max(0, Math.floor(view.top / ts));
    const ty1 = Math.min(map.height - 1, Math.ceil(view.bottom / ts));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        this._paintTerrainTile(ctx, map, tx, ty, ts);
      }
    }
    this._paintTerrainStrata(ctx, map, tx0, tx1, ty0, ty1, ts);
  }

  _drawDecals(ctx, game) {
    const map = game.map;
    const ts = map.tileSize;
    for (const d of game.effects.decals) {
      if (
        d.type !== "scorch" &&
        d.type !== "mud" &&
        d.type !== "straw" &&
        d.type !== "dust"
      ) {
        continue;
      }
      if (d.x < -80 || d.x > map.pixelWidth + 80) continue;

      // Ślad zawsze przylega do gruntu. Wcześniej elipsa była wyśrodkowana
      // na linii terenu, więc jej górna połowa rysowała się nad ziemią.
      const groundY = map.groundYAtWorldX(d.x);
      const life = clamp(d.life / d.maxLife, 0, 1);
      const muddy = d.type === "mud";
      const straw = d.type === "straw";
      const dust = d.type === "dust";
      const scorch = !muddy && !straw && !dust;

      // Płaski, szeroki ślad zamiast wysokiego cienia.
      const w = clamp(d.w, 5, ts * 7);
      const h = clamp(d.h, 2, ts * 0.38);
      const alpha =
        life * (scorch ? 0.4 : straw ? 0.3 : muddy ? 0.34 : 0.28);
      const core = straw
        ? `rgba(178, 148, 82, ${alpha})`
        : dust
          ? `rgba(110, 97, 82, ${alpha})`
          : muddy
            ? `rgba(48, 55, 51, ${alpha})`
            : `rgba(20, 16, 12, ${alpha})`;
      const edge = straw
        ? `rgba(150, 124, 66, ${alpha * 0.55})`
        : dust
          ? `rgba(126, 112, 96, ${alpha * 0.5})`
          : muddy
            ? `rgba(66, 76, 68, ${alpha * 0.55})`
            : `rgba(40, 31, 23, ${alpha * 0.55})`;
      const fade = straw
        ? "rgba(150, 124, 66, 0)"
        : dust
          ? "rgba(126, 112, 96, 0)"
          : muddy
            ? "rgba(66, 76, 68, 0)"
            : "rgba(40, 31, 23, 0)";

      const cx = d.x;
      // Górna krawędź plamy leży tuż pod linią gruntu, nigdy nad nią.
      const cy = groundY + h / 2 + 0.75;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, h / w);
      const radius = w / 2;
      const grad = ctx.createRadialGradient(
        0,
        0,
        radius * 0.06,
        0,
        0,
        radius
      );
      grad.addColorStop(0, core);
      grad.addColorStop(0.6, edge);
      grad.addColorStop(1, fade);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TAU);
      ctx.fill();
      ctx.restore();

      // Wypalenie ma nieregularne, zwęglone płaty i jaśniejszy popiół
      // w środku — dzięki temu czyta się jak spalona ziemia, nie jak cień.
      if (scorch) {
        for (let i = 0; i < 3; i++) {
          const u = (hash2(i, Math.round(d.x), 37) - 0.5) * w * 0.42;
          const v = (hash2(i, Math.round(cy), 43) - 0.5) * h * 0.24;
          ctx.fillStyle = `rgba(22, 17, 13, ${alpha * (0.34 - i * 0.06)})`;
          ctx.beginPath();
          ctx.ellipse(
            cx + u,
            cy + v,
            w * (0.2 + 0.08 * hash2(i, 5, 47)),
            Math.max(1, h * (0.3 + 0.06 * i)),
            0,
            0,
            TAU
          );
          ctx.fill();
        }
        ctx.fillStyle = `rgba(156, 142, 120, ${alpha * 0.55})`;
        ctx.beginPath();
        ctx.ellipse(
          cx + (hash2(3, Math.round(d.x), 53) - 0.5) * w * 0.16,
          cy - h * 0.04,
          w * 0.18,
          Math.max(1, h * 0.24),
          0,
          0,
          TAU
        );
        ctx.fill();
        const flecks = 7;
        for (let i = 0; i < flecks; i++) {
          const u = hash2(i, Math.round(d.x), 17) - 0.5;
          const v = hash2(i, Math.round(cy), 29) - 0.5;
          const ash = i % 2 === 0;
          ctx.fillStyle = ash
            ? `rgba(196, 176, 144, ${alpha * 0.5})`
            : `rgba(26, 21, 16, ${alpha * 0.7})`;
          ctx.fillRect(
            cx + u * w * 0.72,
            cy + v * h * 0.6,
            1 + (i % 2) * 0.8,
            1
          );
        }
      }

      if (straw) {
        ctx.strokeStyle = `rgba(214, 186, 112, ${alpha * 0.9})`;
        ctx.lineWidth = 0.7;
        for (let i = 0; i < 8; i++) {
          const u = (hash2(i, Math.round(d.x), 13) - 0.5) * w * 0.62;
          const v = (hash2(i, Math.round(cy), 23) - 0.5) * h * 0.5;
          ctx.beginPath();
          ctx.moveTo(cx + u, cy + v);
          ctx.lineTo(
            cx + u + 2 + hash2(i, 7, 5) * 3,
            cy + v + 0.6
          );
          ctx.stroke();
        }
      }
    }
  }

  _drawMonoliths(ctx, game, view) {
    const monoliths = game.monoliths;
    if (!monoliths) return;

    // Najpierw ziemia i cień pod każdym kamieniem, potem same monolity —
    // dzięki temu blask jednego nie zasłania podstawy drugiego.
    for (const site of monoliths.sites) {
      if (site.x < view.left - 90 || site.x > view.right + 90) continue;
      if (site.y < view.top - 140 || site.y > view.bottom + 60) continue;
      this._drawMonolithGround(ctx, site, game);
    }

    for (const m of monoliths.monoliths || []) {
      if (m.x < view.left - 90 || m.x > view.right + 90) continue;
      if (m.y < view.top - 140 || m.y > view.bottom + 60) continue;
      this._drawMonolith(ctx, m, game);
    }
  }

  /** Wydeptana, wypalona ziemia i kamienie wokół monolitu. */
  _drawMonolithGround(ctx, site, game) {
    const ts = game.map.tileSize;
    const w = site.monolith?.w ?? site.w ?? 9;
    const seed = Math.floor(site.id ?? 1);
    // Krąg wydeptanej ziemi obejmuje całe półkole czcicieli.
    const spacing = (game.config.monoliths?.prayerSpacingTiles ?? 1.1) * ts;
    const maxPrayers = game.config.monoliths?.maxPrayers ?? 10;
    const ringR = Math.max(w * 3.1, Math.ceil(maxPrayers / 2) * spacing * 0.92);

    ctx.save();
    // Ciemna, ubita ziemia w promieniu kultu.
    ctx.fillStyle = "rgba(35, 28, 20, 0.32)";
    ctx.beginPath();
    ctx.ellipse(site.x, site.y + 1.4, ringR, 4.2, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(58, 45, 28, 0.16)";
    ctx.beginPath();
    ctx.ellipse(site.x, site.y + 2.2, ringR * 0.7, 3, 0, 0, TAU);
    ctx.fill();

    // Wytarty pierścień, jak po setkach stóp.
    ctx.strokeStyle = "rgba(76, 62, 42, 0.34)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(site.x, site.y + 1.8, ringR * 0.84, 3.2, 0, 0, TAU);
    ctx.stroke();

    // Drobne kamienie i odłamki rozrzucone dokoła.
    for (let i = 0; i < 10; i++) {
      const a = hash2(seed, i, 11) * TAU;
      const r = (0.55 + hash2(seed, i, 23) * 2.35) * w;
      const sx = site.x + Math.cos(a) * r;
      const sy = site.y + Math.sin(a) * 1.55 + 0.6;
      const sr = 0.7 + hash2(seed, i, 37) * 1.65;
      ctx.fillStyle = rgba("#77705f", 0.38 + hash2(seed, i, 41) * 0.28);
      ctx.beginPath();
      ctx.ellipse(sx, sy, sr, sr * 0.58, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(220, 207, 180, 0.14)";
      ctx.beginPath();
      ctx.ellipse(sx - sr * 0.2, sy - sr * 0.25, sr * 0.55, sr * 0.28, 0, 0, TAU);
      ctx.fill();
    }

    // Kępki trawy, które przeżyły mimo wypalonej ziemi.
    for (let i = 0; i < 4; i++) {
      const a = hash2(seed, i, 53) * TAU;
      const r = (1.1 + hash2(seed, i, 61) * 2.2) * w;
      const gx = site.x + Math.cos(a) * r;
      const gy = site.y + Math.sin(a) * 1.3;
      ctx.strokeStyle = rgba("#5f7d3d", 0.34);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx - 1.4, gy - 2.4, gx - 2.1, gy - 3.6);
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + 0.6, gy - 2.7, gx + 1.3, gy - 4.1);
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + 1.7, gy - 1.8, gx + 2.3, gy - 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawMonolith(ctx, m, game) {
    const site = m.site || game.monoliths.byId.get(m.siteId);
    const h = m.h || 44;
    const w = m.w || 9;
    const rise = clamp(m.rise ?? 1, 0, 1);
    const seed = Math.floor(m.seed ?? 1);
    const night = 1 - this._daylight(game.hour);
    const glow = clamp(site?.glow ?? 0, 0, 1);
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 1.7 + (m.phase || 0));
    const participants = site ? site.participants.size : 0;
    const awake = site ? site.state !== "idle" : false;

    const baseW = w * 0.72;
    const topW = w * 0.42;
    const capH = Math.max(2.5, w * 0.55);
    const topY = m.y - h + capH;
    const j = (a, b) => hash2(seed, a, b) - 0.5;

    const bL = baseW * (1 + j(1, 2) * 0.12);
    const bR = baseW * (1 + j(2, 2) * 0.12);
    const tL = topW * (1 + j(3, 2) * 0.18);
    const tR = topW * (1 + j(4, 2) * 0.18);
    const midY = m.y - h * 0.5;
    const mL = (bL + tL) * 0.5 + j(5, 2) * w * 0.18;
    const mR = (bR + tR) * 0.5 + j(6, 2) * w * 0.18;

    ctx.save();

    // Miękka poświata wokół kamienia — im żywszy kult, tym mocniejsza.
    const auraR = h * (0.9 + glow * 0.4) + w * 1.6;
    const presence = 0.3 + 0.7 * rise;
    const aura = ctx.createRadialGradient(
      m.x,
      m.y - h * 0.46,
      2,
      m.x,
      m.y - h * 0.46,
      auraR
    );
    const a0 = (0.035 + glow * 0.15 + night * 0.045) * presence;
    aura.addColorStop(0, `rgba(255, 207, 124, ${a0})`);
    aura.addColorStop(0.4, `rgba(255, 156, 66, ${a0 * 0.42})`);
    aura.addColorStop(1, "rgba(255, 120, 30, 0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(m.x, m.y - h * 0.46, auraR, 0, TAU);
    ctx.fill();

    // Słup światła widoczny zwłaszcza nocą i podczas obrzędu.
    if (glow > 0.16 && rise > 0.22) {
      const shaft = ctx.createLinearGradient(m.x, m.y - h * 1.85, m.x, m.y);
      shaft.addColorStop(0, "rgba(255, 190, 92, 0)");
      shaft.addColorStop(
        0.5,
        `rgba(255, 186, 86, ${(0.018 + glow * 0.035) * presence})`
      );
      shaft.addColorStop(
        1,
        `rgba(255, 214, 138, ${(0.045 + glow * 0.07) * presence})`
      );
      ctx.fillStyle = shaft;
      ctx.beginPath();
      ctx.moveTo(m.x - w * 0.44, m.y);
      ctx.lineTo(m.x - w * 1.65, m.y - h * 1.85);
      ctx.lineTo(m.x + w * 1.65, m.y - h * 1.85);
      ctx.lineTo(m.x + w * 0.44, m.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Cień rzucany przez kamień.
    ctx.fillStyle = `rgba(10, 13, 15, ${0.2 + rise * 0.14})`;
    ctx.beginPath();
    ctx.ellipse(m.x + w * 0.7, m.y + 1.2, w * 1.75, 3.4, 0, 0, TAU);
    ctx.fill();

    // Podstawa z odłamków — zawsze widoczna, także w trakcie wynurzania.
    this._drawMonolithRubble(ctx, m, w, rise, seed);

    // Sam kamień wynurza się z ziemi podczas budowy.
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.x - w * 3.4, m.y - h - 14, w * 6.8, h + 14);
    ctx.clip();
    ctx.translate(0, (1 - rise) * (h + 5));

    // Kamienny ołtarz z otoczaków i ubitej ziemi.
    const plinthH = Math.max(2.5, h * 0.05);
    const plinthW = baseW * 1.3;
    ctx.fillStyle = "#4b463d";
    ctx.beginPath();
    ctx.moveTo(m.x - plinthW, m.y + 1);
    ctx.lineTo(m.x - plinthW * 0.84, m.y - plinthH);
    ctx.lineTo(m.x + plinthW * 0.84, m.y - plinthH);
    ctx.lineTo(m.x + plinthW, m.y + 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(186, 178, 152, 0.2)";
    for (let i = 0; i < 5; i++) {
      const px = m.x - plinthW * 0.7 + (plinthW * 1.4 * (i + 0.5)) / 5;
      ctx.beginPath();
      ctx.ellipse(px, m.y - plinthH * 0.75, plinthW * 0.12, plinthH * 0.3, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(232, 217, 184, 0.13)";
    ctx.beginPath();
    ctx.moveTo(m.x - plinthW * 0.84, m.y - plinthH);
    ctx.lineTo(m.x + plinthW * 0.84, m.y - plinthH);
    ctx.lineTo(m.x + plinthW * 0.68, m.y - plinthH + 1.2);
    ctx.lineTo(m.x - plinthW * 0.68, m.y - plinthH + 1.2);
    ctx.closePath();
    ctx.fill();

    // Rzeźbiony drewniany słup — słowiański bożek z twarzą i znakiem słońca.
    const grad = ctx.createLinearGradient(m.x - bL, 0, m.x + bR, 0);
    grad.addColorStop(0, "#2e1a0e");
    grad.addColorStop(0.2, "#5b351c");
    grad.addColorStop(0.48, "#8a5a2d");
    grad.addColorStop(0.7, "#73451f");
    grad.addColorStop(1, "#3a2112");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(m.x - bL, m.y + 1);
    ctx.lineTo(m.x - mL, midY);
    ctx.lineTo(m.x - tL, topY);
    ctx.lineTo(m.x + tR, topY);
    ctx.lineTo(m.x + mR, midY);
    ctx.lineTo(m.x + bR, m.y + 1);
    ctx.closePath();
    ctx.fill();

    // Słoje drewna biegnące wzdłuż pnia.
    ctx.strokeStyle = "rgba(36, 20, 9, 0.36)";
    ctx.lineWidth = Math.max(0.45, w * 0.045);
    ctx.lineCap = "round";
    for (let i = 0; i < 6; i++) {
      const t = 0.12 + i * 0.15;
      const x0 = m.x - bL + (bL + bR) * t;
      const x1 = m.x - tL + (tL + tR) * t;
      ctx.beginPath();
      ctx.moveTo(x0, m.y - 2);
      ctx.bezierCurveTo(
        x0 + (hash2(seed, i, 11) - 0.5) * w * 0.5,
        m.y - h * 0.32,
        x1 + (hash2(seed, i, 13) - 0.5) * w * 0.35,
        m.y - h * 0.66,
        x1,
        topY + 2
      );
      ctx.stroke();
    }
    // Jasne smugi i sęki.
    ctx.strokeStyle = "rgba(255, 218, 158, 0.13)";
    ctx.lineWidth = Math.max(0.4, w * 0.03);
    for (let i = 0; i < 3; i++) {
      const t = 0.24 + i * 0.24;
      const x0 = m.x - bL + (bL + bR) * t;
      ctx.beginPath();
      ctx.moveTo(x0, m.y - h * 0.12);
      ctx.quadraticCurveTo(
        x0 + w * 0.12,
        m.y - h * 0.42,
        x0 - w * 0.05,
        m.y - h * 0.7
      );
      ctx.stroke();
    }
    for (let i = 0; i < 3; i++) {
      const kx = m.x + (hash2(seed, i, 23) - 0.5) * bL * 1.2;
      const ky = m.y - h * (0.28 + hash2(seed, i, 29) * 0.34);
      ctx.fillStyle = "rgba(42, 23, 10, 0.45)";
      ctx.beginPath();
      ctx.ellipse(kx, ky, w * 0.09, w * 0.055, 0.3, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 216, 156, 0.16)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.ellipse(kx, ky - 0.4, w * 0.09, w * 0.055, 0.3, 0, TAU);
      ctx.stroke();
    }

    // Mrok po bokach pnia.
    ctx.fillStyle = "rgba(20, 12, 7, 0.28)";
    ctx.beginPath();
    ctx.moveTo(m.x - bL, m.y);
    ctx.lineTo(m.x - bL + w * 0.12, midY + h * 0.06);
    ctx.lineTo(m.x - mL + w * 0.08, midY);
    ctx.lineTo(m.x - mL, midY);
    ctx.lineTo(m.x - bL, m.y);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 226, 174, 0.1)";
    ctx.beginPath();
    ctx.moveTo(m.x + bR, m.y);
    ctx.lineTo(m.x + bR - w * 0.16, midY + h * 0.08);
    ctx.lineTo(m.x + mR - w * 0.06, midY);
    ctx.lineTo(m.x + mR, midY);
    ctx.closePath();
    ctx.fill();

    // Rzeźbione poprzeczne pierścienie.
    ctx.strokeStyle = "rgba(38, 21, 9, 0.45)";
    ctx.lineWidth = Math.max(0.5, w * 0.06);
    for (const tt of [0.44, 0.47]) {
      const ry = m.y - h * tt;
      const halfW = w * (0.37 - tt * 0.12);
      ctx.beginPath();
      ctx.moveTo(m.x - halfW, ry);
      ctx.lineTo(m.x + halfW, ry + 0.4);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255, 218, 158, 0.15)";
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    ctx.moveTo(m.x - w * 0.3, m.y - h * 0.445);
    ctx.lineTo(m.x + w * 0.3, m.y - h * 0.445);
    ctx.stroke();

    // Twarz bożka: groźne brwi, puste oczy i długi wąs.
    const faceY = m.y - h * 0.79;
    const faceR = w * 0.52;
    ctx.fillStyle = "rgba(30, 16, 7, 0.5)";
    ctx.beginPath();
    ctx.ellipse(m.x, faceY, faceR * 0.92, faceR * 1.02, 0, 0, TAU);
    ctx.fill();
    // Policzki i czoło.
    ctx.fillStyle = "rgba(150, 100, 52, 0.32)";
    ctx.beginPath();
    ctx.ellipse(
      m.x - faceR * 0.18,
      faceY - faceR * 0.1,
      faceR * 0.55,
      faceR * 0.62,
      -0.1,
      0,
      TAU
    );
    ctx.fill();
    // Brwi.
    ctx.strokeStyle = "rgba(28, 15, 6, 0.85)";
    ctx.lineWidth = Math.max(0.7, w * 0.085);
    ctx.lineCap = "round";
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(m.x + side * faceR * 0.16, faceY - faceR * 0.34);
      ctx.quadraticCurveTo(
        m.x + side * faceR * 0.46,
        faceY - faceR * 0.48,
        m.x + side * faceR * 0.76,
        faceY - faceR * 0.28
      );
      ctx.stroke();
    }
    // Oczy — w mroku rozżarzone.
    const eyeGlow = clamp(0.16 + glow * 0.54 + night * 0.2, 0, 0.95);
    for (const side of [-1, 1]) {
      const ex = m.x + side * faceR * 0.4;
      const ey = faceY - faceR * 0.06;
      ctx.fillStyle = "rgba(22, 11, 5, 0.9)";
      ctx.beginPath();
      ctx.ellipse(ex, ey, faceR * 0.2, faceR * 0.13, 0, 0, TAU);
      ctx.fill();
      if (rise > 0.5) {
        ctx.save();
        ctx.fillStyle = rgba("#ffd27e", eyeGlow);
        ctx.shadowColor = "rgba(255, 170, 62, 0.9)";
        ctx.shadowBlur = 2 + glow * 6;
        ctx.beginPath();
        ctx.ellipse(ex, ey, faceR * 0.1, faceR * 0.075, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
    // Nos.
    ctx.strokeStyle = "rgba(46, 24, 10, 0.7)";
    ctx.lineWidth = Math.max(0.55, w * 0.055);
    ctx.beginPath();
    ctx.moveTo(m.x, faceY - faceR * 0.02);
    ctx.lineTo(m.x - faceR * 0.07, faceY + faceR * 0.28);
    ctx.lineTo(m.x + faceR * 0.09, faceY + faceR * 0.3);
    ctx.stroke();
    // Wąs i usta.
    ctx.strokeStyle = "rgba(34, 17, 7, 0.85)";
    ctx.lineWidth = Math.max(0.6, w * 0.07);
    ctx.beginPath();
    ctx.moveTo(m.x - faceR * 0.62, faceY + faceR * 0.42);
    ctx.quadraticCurveTo(m.x, faceY + faceR * 0.56, m.x + faceR * 0.62, faceY + faceR * 0.42);
    ctx.stroke();
    ctx.lineWidth = Math.max(0.45, w * 0.045);
    ctx.beginPath();
    ctx.moveTo(m.x - faceR * 0.24, faceY + faceR * 0.58);
    ctx.quadraticCurveTo(m.x, faceY + faceR * 0.64, m.x + faceR * 0.24, faceY + faceR * 0.58);
    ctx.stroke();
    // Rzeźbione promienie wokół twarzy.
    ctx.strokeStyle = "rgba(46, 24, 10, 0.42)";
    ctx.lineWidth = Math.max(0.4, w * 0.04);
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * 0.86 + (i / 6) * Math.PI * 0.72;
      ctx.beginPath();
      ctx.moveTo(
        m.x + Math.cos(a) * faceR * 1.02,
        faceY + Math.sin(a) * faceR * 1.12
      );
      ctx.lineTo(
        m.x + Math.cos(a) * faceR * 1.28,
        faceY + Math.sin(a) * faceR * 1.4
      );
      ctx.stroke();
    }

    // Słoneczny znak na piersi bożka.
    const sunY = m.y - h * 0.58;
    const sunR = w * 0.32;
    ctx.save();
    const sunAlpha = clamp(0.2 + glow * 0.5 + night * 0.14, 0, 0.9);
    ctx.strokeStyle = rgba("#ffd27e", sunAlpha);
    ctx.shadowColor = "rgba(255, 170, 62, 0.75)";
    ctx.shadowBlur = 1.5 + glow * 5;
    ctx.lineWidth = Math.max(0.5, w * 0.055);
    ctx.beginPath();
    ctx.arc(m.x, sunY, sunR * 0.42, 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      ctx.beginPath();
      ctx.moveTo(
        m.x + Math.cos(a) * sunR * 0.62,
        sunY + Math.sin(a) * sunR * 0.62
      );
      ctx.lineTo(
        m.x + Math.cos(a) * sunR,
        sunY + Math.sin(a) * sunR
      );
      ctx.stroke();
    }
    ctx.restore();

    // Świecące runy na dolnej części słupa — serce kultu.
    if (h > 22 && rise > 0.55) {
      const runeAlpha = clamp(0.22 + glow * 0.58 + night * 0.18, 0, 0.95);
      ctx.save();
      ctx.strokeStyle = rgba("#ffd27e", runeAlpha);
      ctx.fillStyle = rgba("#ffd27e", runeAlpha);
      ctx.shadowColor = "rgba(255, 174, 66, 0.85)";
      ctx.shadowBlur = 2 + glow * 7 + pulse * 1.5;
      ctx.lineWidth = Math.max(0.45, w * 0.055);
      ctx.lineCap = "round";
      for (let row = 0; row < 2; row++) {
        const t = 0.16 + row * 0.13;
        const ry = m.y - h * t;
        const halfW = w * (0.4 - t * 0.14);
        for (let col = -1; col <= 1; col++) {
          const rx = m.x + col * halfW * 0.8;
          const s = w * 0.1 * (0.85 + hash2(seed, row, col + 2) * 0.3);
          const glyph = (row * 3 + col + 3 + seed) % 4;
          ctx.beginPath();
          if (glyph === 0) {
            ctx.moveTo(rx - s, ry + s * 0.65);
            ctx.lineTo(rx, ry - s * 0.75);
            ctx.lineTo(rx + s, ry + s * 0.65);
          } else if (glyph === 1) {
            ctx.moveTo(rx, ry - s * 0.8);
            ctx.lineTo(rx, ry + s * 0.8);
            ctx.moveTo(rx - s * 0.7, ry - s * 0.15);
            ctx.lineTo(rx + s * 0.7, ry - s * 0.15);
          } else if (glyph === 2) {
            ctx.moveTo(rx - s * 0.7, ry - s * 0.55);
            ctx.lineTo(rx + s * 0.55, ry + s * 0.7);
            ctx.moveTo(rx + s * 0.7, ry - s * 0.55);
            ctx.lineTo(rx - s * 0.2, ry + s * 0.15);
          } else {
            ctx.moveTo(rx - s * 0.65, ry);
            ctx.lineTo(rx + s * 0.65, ry);
            ctx.moveTo(rx, ry - s * 0.65);
            ctx.lineTo(rx, ry + s * 0.65);
            ctx.moveTo(rx + s * 0.55, ry - s * 0.55);
            ctx.lineTo(rx + s * 0.9, ry - s * 0.85);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Ciemny mech u podstawy słupa.
    for (let i = 0; i < 4; i++) {
      const mx = m.x - bL + hash2(seed, i, 29) * (bL + bR) * 0.7;
      const my = m.y - h * (0.035 + hash2(seed, i, 31) * 0.12);
      const mw = w * (0.13 + hash2(seed, i, 33) * 0.22);
      ctx.fillStyle = rgba("#617a43", 0.2 + hash2(seed, i, 35) * 0.18);
      ctx.beginPath();
      ctx.ellipse(mx, my, mw, mw * 0.6, 0, 0, TAU);
      ctx.fill();
    }

    // Drewniana czapa bożka z rzeźbionym słońcem.
    const capW = Math.max(tL, tR) * 1.45;
    ctx.fillStyle = "#3a2112";
    ctx.beginPath();
    ctx.ellipse(m.x, topY + 0.8, capW, Math.max(1.6, capH * 0.26), 0, 0, TAU);
    ctx.fill();
    const capGrad = ctx.createLinearGradient(m.x - capW, 0, m.x + capW, 0);
    capGrad.addColorStop(0, "#402513");
    capGrad.addColorStop(0.45, "#7c4b26");
    capGrad.addColorStop(0.75, "#91602f");
    capGrad.addColorStop(1, "#3a2112");
    ctx.fillStyle = capGrad;
    ctx.beginPath();
    ctx.moveTo(m.x - capW * 0.58, topY);
    ctx.quadraticCurveTo(m.x, topY - capH * 0.96, m.x + capW * 0.58, topY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(42, 23, 10, 0.5)";
    ctx.lineWidth = 0.6;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(m.x + i * capW * 0.16, topY - 0.5);
      ctx.quadraticCurveTo(
        m.x + i * capW * 0.11,
        topY - capH * 0.5,
        m.x + i * capW * 0.05,
        topY - capH * 0.82
      );
      ctx.stroke();
    }

    // Jasna krawędź od strony światła.
    ctx.strokeStyle = "rgba(255, 226, 174, 0.18)";
    ctx.lineWidth = Math.max(0.6, w * 0.07);
    ctx.beginPath();
    ctx.moveTo(m.x + tR * 0.9, topY + 1);
    ctx.lineTo(m.x + mR * 0.92, midY);
    ctx.lineTo(m.x + bR * 0.96, m.y - 1);
    ctx.stroke();

    ctx.restore(); // koniec przycinania/wynurzania

    // Pył i drobne odłamki podczas wynurzania.
    if (rise < 0.99) {
      const dust = (1 - rise) * 0.5;
      ctx.save();
      ctx.fillStyle = `rgba(198, 184, 156, ${dust})`;
      for (let i = 0; i < 7; i++) {
        const a = hash2(seed, i, 43) * TAU;
        const r = (0.4 + hash2(seed, i, 47) * 1.7) * w;
        ctx.beginPath();
        ctx.ellipse(
          m.x + Math.cos(a) * r,
          m.y - hash2(seed, i, 59) * h * 0.18,
          1 + hash2(seed, i, 61) * 2.4,
          0.7 + hash2(seed, i, 67) * 1.2,
          0,
          0,
          TAU
        );
        ctx.fill();
      }
      ctx.restore();
    }

    // Złote iskry unoszące się wokół monolitu.
    if (rise > 0.35 && (glow > 0.08 || participants > 0)) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 11; i++) {
        const hx = hash2(seed, i, 71);
        const t = (this.time * (0.05 + hx * 0.06) + hash2(seed, i, 83)) % 1;
        const px =
          m.x +
          (hash2(seed, i, 91) * 2 - 1) * w * 2.2 +
          Math.sin(this.time * 0.8 + hx * TAU) * 2.6;
        const py = m.y - h * 0.12 - t * h * 1.18;
        const alpha = Math.sin(Math.PI * t) * (0.12 + glow * 0.42 + (awake ? 0.08 : 0));
        ctx.fillStyle = `rgba(255, 209, 124, ${clamp(alpha, 0, 0.75)})`;
        ctx.beginPath();
        ctx.arc(px, py, 0.35 + hx * 0.85, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  _drawMonolithRubble(ctx, m, w, rise, seed) {
    const baseY = m.y + 1;
    for (let i = 0; i < 5; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const rx = m.x + side * w * (0.55 + hash2(seed, i, 97) * 0.9);
      const ry = baseY - hash2(seed, i, 101) * 2.6;
      const rw = w * (0.16 + hash2(seed, i, 103) * 0.24);
      const rh = rw * (0.5 + hash2(seed, i, 107) * 0.35);
      ctx.fillStyle = i % 2 === 0 ? "#5b574e" : "#6d675a";
      ctx.beginPath();
      ctx.ellipse(rx, ry, rw, rh, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(224, 212, 184, 0.16)";
      ctx.beginPath();
      ctx.ellipse(rx - rw * 0.18, ry - rh * 0.35, rw * 0.55, rh * 0.38, 0, 0, TAU);
      ctx.fill();
    }

    // Pierścień kurzu przy podstawie w trakcie wynurzania.
    if (rise < 0.99) {
      ctx.strokeStyle = `rgba(195, 181, 153, ${(1 - rise) * 0.3})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(m.x, baseY, w * (2.2 + rise * 0.5), 3.2 + rise, 0, 0, TAU);
      ctx.stroke();
    }
  }

  _drawMemorials(ctx, game, view) {
    const memorials = game.memorials;
    if (!memorials) return;

    for (const site of memorials.sites) {
      if (site.x < view.left - 60 || site.x > view.right + 60) continue;
      if (site.y < view.top - 80 || site.y > view.bottom + 40) continue;
      this._drawMemorialSite(ctx, site, game);
    }

    for (const obelisk of memorials.obelisks) {
      if (obelisk.x < view.left - 60 || obelisk.x > view.right + 60) continue;
      if (obelisk.y < view.top - 80 || obelisk.y > view.bottom + 40) continue;
      this._drawObelisk(ctx, obelisk);
    }
  }

  _drawMemorialSite(ctx, site, game) {
    const ts = game.map.tileSize;
    const alpha = site.state === "done" ? 0.1 : 0.18;

    // Wydeptana, ciemniejsza ziemia w miejscu tragedii.
    ctx.fillStyle = `rgba(48, 39, 30, ${alpha})`;
    ctx.beginPath();
    ctx.ellipse(site.x, site.y + 1.5, ts * 0.85, 2.7, 0, 0, TAU);
    ctx.fill();

    // Drobne kamienie i żwir wokół miejsca pamięci.
    for (let i = 0; i < 6; i++) {
      const hx = hash2(site.id, i, 17);
      const hy = hash2(site.id, i, 29);
      const px = site.x + (hx * 2 - 1) * ts * 0.9;
      const py = site.y - hy * 1.4;
      ctx.fillStyle = rgba("#8a8376", 0.4 + hy * 0.25);
      ctx.beginPath();
      ctx.ellipse(px, py, 1.1 + hy * 1.3, 0.6 + hy * 0.5, 0, 0, TAU);
      ctx.fill();
    }

    // Podczas budowy obelisk wyraźnie wyrasta z ziemi.
    if (site.state === "build") {
      const total = Math.max(0.001, game.config.memorials?.buildSeconds ?? 1.8);
      const progress = clamp(1 - site.timer / total, 0, 1);
      const h = (site.obeliskH ?? 28) * progress;
      if (h > 2) {
        this._drawObelisk(ctx, {
          x: site.x,
          y: site.y,
          h,
          w: site.obeliskW ?? 6,
          seed: site.id,
        });
      }
    }
  }

  _drawObelisk(ctx, obelisk) {
    const { x, y, h, w } = obelisk;
    const seed = Math.floor((obelisk.seed ?? 1) * 1000);
    // Kopiec jest stały, a drewniany znaczek wyrasta z niego w trakcie budowy.
    const moundW = Math.max(14, w * 3.6);
    const moundH = Math.max(3.6, w * 0.82);
    const postH = Math.max(2.5, h * 0.86);
    const postBase = y - moundH * 0.5;
    const postTop = postBase - postH;
    const bottomW = Math.max(2.1, w * 0.5);
    const topW = Math.max(1.6, bottomW * 0.76);
    const capW = topW * 2.15;
    const capH = Math.max(1.8, w * 0.52);

    ctx.save();

    // Cień kopca.
    ctx.fillStyle = "rgba(12, 14, 11, 0.24)";
    ctx.beginPath();
    ctx.ellipse(x + 2, y + 0.8, moundW * 1.05, 3.1, 0, 0, TAU);
    ctx.fill();

    // Mały kopiec ziemny porośnięty trawą.
    const moundGrad = ctx.createLinearGradient(x - moundW, y - moundH, x + moundW, y);
    moundGrad.addColorStop(0, "#5a4028");
    moundGrad.addColorStop(0.34, "#755233");
    moundGrad.addColorStop(0.72, "#654529");
    moundGrad.addColorStop(1, "#4a3320");
    ctx.fillStyle = moundGrad;
    ctx.beginPath();
    ctx.moveTo(x - moundW, y);
    ctx.quadraticCurveTo(x - moundW * 0.54, y - moundH * 1.75, x, y - moundH);
    ctx.quadraticCurveTo(x + moundW * 0.54, y - moundH * 1.75, x + moundW, y);
    ctx.closePath();
    ctx.fill();

    // Jaśniejsza grzęda i darń na szczycie.
    ctx.fillStyle = "rgba(255, 225, 178, 0.1)";
    ctx.beginPath();
    ctx.moveTo(x - moundW, y);
    ctx.quadraticCurveTo(x - moundW * 0.54, y - moundH * 1.75, x, y - moundH);
    ctx.quadraticCurveTo(x - moundW * 0.14, y - moundH * 1.1, x - moundW * 0.22, y - moundH * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(86, 116, 62, 0.42)";
    ctx.beginPath();
    ctx.ellipse(x, y - moundH * 0.92, moundW * 0.44, moundH * 0.34, 0, 0, TAU);
    ctx.fill();

    // Kępki trawy i drobne kwiaty na kopcu.
    for (let i = 0; i < 7; i++) {
      const t = hash2(seed, i, 13);
      const gx = x + (t * 2 - 1) * moundW * 0.82;
      const gy = y - moundH * (0.16 + hash2(seed, i, 17) * 0.62);
      ctx.strokeStyle = rgba("#5f7d3d", 0.34 + hash2(seed, i, 19) * 0.2);
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx - 1.1, gy - 2.2, gx - 1.7, gy - 3.4);
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + 0.5, gy - 2.5, gx + 1.2, gy - 3.8);
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + 1.5, gy - 1.6, gx + 2.1, gy - 2.8);
      ctx.stroke();
      if (i % 3 === 0) {
        ctx.fillStyle = i % 2 ? "#c2543f" : "#d8c46b";
        ctx.beginPath();
        ctx.arc(gx + 0.6, gy - 3.6, 0.7, 0, TAU);
        ctx.fill();
      }
    }
    // Otoczaki u podnóża kopca.
    for (let i = 0; i < 4; i++) {
      const hx = hash2(seed + i, 23, 5);
      const px = x + (hx * 2 - 1) * moundW * 0.92;
      ctx.fillStyle = i % 2 ? "rgba(108, 105, 96, 0.7)" : "rgba(128, 121, 106, 0.62)";
      ctx.beginPath();
      ctx.ellipse(px, y - 1.2, 1.2 + hx * 1.5, 0.7 + hx * 0.4, 0, 0, TAU);
      ctx.fill();
    }

    // Drewniany słupek przodków z daszkiem.
    if (postH > 3.2) {
      const postGrad = ctx.createLinearGradient(x - bottomW, 0, x + bottomW, 0);
      postGrad.addColorStop(0, "#3a2112");
      postGrad.addColorStop(0.4, "#6b4223");
      postGrad.addColorStop(0.74, "#84542b");
      postGrad.addColorStop(1, "#3a2112");
      ctx.fillStyle = postGrad;
      ctx.beginPath();
      ctx.moveTo(x - bottomW, postBase);
      ctx.lineTo(x - topW, postTop);
      ctx.lineTo(x + topW, postTop);
      ctx.lineTo(x + bottomW, postBase);
      ctx.closePath();
      ctx.fill();
      // Słoje.
      ctx.strokeStyle = "rgba(40, 22, 9, 0.35)";
      ctx.lineWidth = 0.45;
      for (let i = 1; i < 3; i++) {
        const t = i / 3;
        const lx0 = x - bottomW + bottomW * 2 * t;
        const lx1 = x - topW + topW * 2 * t;
        ctx.beginPath();
        ctx.moveTo(lx0, postBase - 0.5);
        ctx.lineTo(lx1, postTop + 0.5);
        ctx.stroke();
      }
      // Rzeźbiona twarz.
      if (postH > 9) {
        const fy = postTop + postH * 0.2;
        const fr = Math.min(topW * 0.78, postH * 0.12);
        ctx.fillStyle = "rgba(32, 17, 7, 0.42)";
        ctx.beginPath();
        ctx.ellipse(x, fy, fr * 1.05, fr * 1.2, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "rgba(24, 12, 5, 0.85)";
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(x + side * fr * 0.42, fy - fr * 0.1, fr * 0.17, fr * 0.11, 0, 0, TAU);
          ctx.fill();
        }
        ctx.strokeStyle = "rgba(36, 19, 8, 0.75)";
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.moveTo(x - fr * 0.5, fy + fr * 0.42);
        ctx.quadraticCurveTo(x, fy + fr * 0.66, x + fr * 0.5, fy + fr * 0.42);
        ctx.stroke();
        // Znak słońca pod twarzą.
        ctx.strokeStyle = "rgba(255, 214, 138, 0.42)";
        ctx.lineWidth = 0.55;
        const sy = postTop + postH * 0.48;
        ctx.beginPath();
        ctx.arc(x, sy, fr * 0.34, 0, TAU);
        ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(a) * fr * 0.46, sy + Math.sin(a) * fr * 0.46);
          ctx.lineTo(x + Math.cos(a) * fr * 0.7, sy + Math.sin(a) * fr * 0.7);
          ctx.stroke();
        }
      }
      // Daszek z dwóch desek.
      ctx.fillStyle = "#4a2c18";
      ctx.beginPath();
      ctx.moveTo(x - capW, postTop + capH * 0.32);
      ctx.lineTo(x, postTop - capH);
      ctx.lineTo(x + capW, postTop + capH * 0.32);
      ctx.lineTo(x, postTop + capH * 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255, 226, 174, 0.18)";
      ctx.beginPath();
      ctx.moveTo(x - capW * 0.92, postTop + capH * 0.24);
      ctx.lineTo(x, postTop - capH * 0.9);
      ctx.lineTo(x, postTop - capH * 0.1);
      ctx.lineTo(x - capW * 0.28, postTop + capH * 0.14);
      ctx.closePath();
      ctx.fill();
      // Czerwona wstążka ofiarna.
      const ribbon = Math.sin(seed) * 1.2;
      ctx.fillStyle = "rgba(168, 58, 44, 0.85)";
      ctx.beginPath();
      ctx.moveTo(x + topW * 0.6, postTop + capH * 0.28);
      ctx.quadraticCurveTo(
        x + topW * 1.2 + ribbon,
        postTop + postH * 0.2,
        x + topW * 0.9 + ribbon,
        postTop + postH * 0.34
      );
      ctx.lineTo(x + topW * 0.72 + ribbon, postTop + postH * 0.33);
      ctx.quadraticCurveTo(
        x + topW * 0.96,
        postTop + postH * 0.2,
        x + topW * 0.48,
        postTop + capH * 0.3
      );
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  _drawHouses(ctx, game, view) {
    const housing = game.housing;
    if (!housing) return;

    for (const site of housing.sites) {
      if (site.x < view.left - 70 || site.x > view.right + 70) continue;
      if (site.y < view.top - 90 || site.y > view.bottom + 40) continue;
      this._drawHouseSite(ctx, site, game);
    }

    for (const house of housing.houses) {
      if (house.x < view.left - 70 || house.x > view.right + 70) continue;
      if (house.y < view.top - 90 || house.y > view.bottom + 40) continue;
      this._drawHouse(ctx, house, game);
    }
  }

  _drawHouse(ctx, house, game) {
    const housingTheme = game.config.theme.house || {};
    const wallPalette = housingTheme.wall || ["#8a5a34", "#7a4d2c", "#96663c"];
    const roofPalette = housingTheme.roof || ["#5d3b2a", "#4a3024", "#6b4430"];
    const trim = housingTheme.trim || "#d8c49a";
    const windowColor = housingTheme.window || "#ffd98a";

    const w = house.w ?? 46;
    const wallH = house.wallH ?? 27;
    const roofH = house.roofH ?? 16;
    const seed = Math.floor(house.seed ?? 1);
    const burn = house.burning
      ? clamp(
          (house.burnTimer ?? 0) / Math.max(0.001, house.burnDuration ?? 1),
          0,
          1
        )
      : 0;
    const washMax = game.config.housing?.rainWashSeconds ?? 9;
    const wash = house.wash ? clamp(house.wash / washMax, 0, 1) : 0;
    const wall = mixColor(
      mixColor(
        wallPalette[seed % wallPalette.length],
        "#1e140d",
        burn * 0.78
      ),
      "#4f6570",
      wash * 0.28
    );
    const roof = mixColor(
      mixColor(
        roofPalette[Math.floor(seed / 3) % roofPalette.length],
        "#17100c",
        burn * 0.82
      ),
      "#3f545e",
      wash * 0.3
    );
    const wallDark = mixColor(wall, "#1d120c", 0.42);
    const wallLight = mixColor(wall, "#ffe2b8", 0.18);
    const roofDark = mixColor(roof, "#160f0a", 0.35);

    const x = house.x;
    const y = house.y;
    const half = w / 2;
    const wallTop = y - wallH;
    const peak = wallTop - roofH;
    const overhang = 6;

    const agents = game.config.agents || {};
    const night =
      game.hour >= (agents.nightStartHour ?? 21) ||
      game.hour < (agents.dayStartHour ?? 6);

    ctx.save();

    // Podmyta chata przechyla się i osiada, zanim zniknie.
    const stress = clamp(house.windStress || 0, 0, 1);
    if (wash > 0 || stress > 0) {
      const leanDir = house.windLeanDir ?? (seed % 2 ? 1 : -1);
      ctx.translate(x, y);
      ctx.rotate(
        (wash > 0 ? (seed % 2 ? 1 : -1) * 0.06 * wash : 0) +
          stress * 0.16 * leanDir
      );
      ctx.translate(-x, -y + wash * 5);
      ctx.globalAlpha *= 1 - wash * 0.32;
    }

    // Cień chaty.
    ctx.fillStyle = "rgba(12, 14, 11, 0.25)";
    ctx.beginPath();
    ctx.ellipse(x + 3, y + 1.2, half * 1.18, 4.6, 0, 0, TAU);
    ctx.fill();

    // Drewniana podwalina — chata stoi na belkach zamiast na kamieniu.
    ctx.fillStyle = mixColor("#3a2414", wallDark, 0.4);
    ctx.fillRect(x - half - 2, y - 4.5, w + 4, 4.5);
    ctx.fillStyle = roofDark;
    ctx.fillRect(x - half - 1.6, y - 1.2, w + 3.2, 1.2);
    for (let i = 0; i < 5; i++) {
      const rx = x - half + 2 + (w - 4) * (i / 4);
      ctx.fillStyle = i % 2 ? "#4d311c" : "#3a2414";
      ctx.fillRect(rx, y - 4.6, Math.max(2, w * 0.04), 3);
    }

    // Ściana z bali — poziome belki z ciemnymi szwami i wypustem w węgłach.
    const wallGrad = ctx.createLinearGradient(x - half, 0, x + half, 0);
    wallGrad.addColorStop(0, wallDark);
    wallGrad.addColorStop(0.22, wall);
    wallGrad.addColorStop(0.72, wallLight);
    wallGrad.addColorStop(1, wallDark);
    ctx.fillStyle = wallGrad;
    ctx.fillRect(x - half, wallTop, w, wallH);

    const logStep = Math.max(3.2, wallH / 7);
    ctx.lineWidth = 0.75;
    for (let ly = wallTop + logStep; ly < y - 5; ly += logStep) {
      ctx.strokeStyle = "rgba(35, 22, 12, 0.42)";
      ctx.beginPath();
      ctx.moveTo(x - half + 1, ly);
      ctx.lineTo(x + half - 1, ly);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255, 226, 180, 0.12)";
      ctx.beginPath();
      ctx.moveTo(x - half + 2, ly + 0.9);
      ctx.lineTo(x + half - 2, ly + 0.9);
      ctx.stroke();
    }
    // Styk bali w mijankę.
    ctx.strokeStyle = "rgba(30, 19, 11, 0.3)";
    ctx.lineWidth = 0.6;
    for (let ly = wallTop + logStep, row = 0; ly < y - 5; ly += logStep, row++) {
      const seamX = x + (row % 2 ? -1 : 1) * half * (0.16 + (row % 3) * 0.12);
      ctx.beginPath();
      ctx.moveTo(seamX, ly - logStep + 1);
      ctx.lineTo(seamX, ly - 0.8);
      ctx.stroke();
    }
    // Ciemne słupy węgłowe i wystające końce bali.
    ctx.fillStyle = wallDark;
    ctx.fillRect(x - half - 1.4, wallTop, 2.8, wallH - 5);
    ctx.fillRect(x + half - 1.4, wallTop, 2.8, wallH - 5);
    ctx.fillStyle = "rgba(255, 226, 180, 0.16)";
    ctx.fillRect(x - half - 1.1, wallTop + 0.6, 0.8, wallH - 6);
    ctx.fillRect(x + half - 1.1, wallTop + 0.6, 0.8, wallH - 6);
    for (let i = 0; i < 3; i++) {
      const ly = wallTop + logStep * (i + 1.35);
      ctx.fillStyle = i % 2 ? wallDark : wall;
      ctx.beginPath();
      ctx.ellipse(x - half - 1.8, ly, 1.7, 1.05, 0, 0, TAU);
      ctx.ellipse(x + half + 1.8, ly, 1.7, 1.05, 0, 0, TAU);
      ctx.fill();
    }

    // Górna belka (oczep) pod słomą.
    ctx.fillStyle = roofDark;
    ctx.fillRect(x - half - 1.6, wallTop - 0.4, w + 3.2, 2.6);
    ctx.fillStyle = "rgba(255, 231, 186, 0.16)";
    ctx.fillRect(x - half - 1.2, wallTop - 0.2, w + 2.4, 0.7);

    // Dach kryty słomą — gruby, postrzępiony okap i zaokrąglona kalenica.
    const eaveY = wallTop + 2.8;
    const eaveX = half + overhang + 2;
    const strawLight = mixColor(roof, "#f4d58d", 0.34);
    const strawShade = mixColor(roof, "#5a3f1f", 0.4);

    // Dach dwuspadowy: dwie proste połacie schodzące z kalenicy do okapu.
    const strawGrad = ctx.createLinearGradient(0, peak, 0, eaveY + 4);
    strawGrad.addColorStop(0, strawLight);
    strawGrad.addColorStop(0.42, roof);
    strawGrad.addColorStop(1, strawShade);
    ctx.fillStyle = strawGrad;
    ctx.beginPath();
    ctx.moveTo(x, peak - 1.5);
    ctx.lineTo(x - eaveX, eaveY + 1.5);
    ctx.lineTo(x - eaveX + 1, eaveY + 4.6);
    // Postrzępiony spód słomy.
    const fringe = 9;
    for (let i = 1; i <= fringe; i++) {
      const t = i / fringe;
      const fx = x - eaveX + eaveX * 2 * t;
      const jag = (hash2(seed, i, 21) * 2.6 - 1.3) * (1 - Math.abs(t - 0.5) * 1.1);
      ctx.lineTo(fx, eaveY + 3.4 + jag);
    }
    ctx.lineTo(x + eaveX - 1, eaveY + 4.6);
    ctx.lineTo(x + eaveX, eaveY + 1.5);
    ctx.lineTo(x, peak - 1.5);
    ctx.closePath();
    ctx.fill();

    // Ciepłe światło na lewej połaci.
    ctx.fillStyle = "rgba(255, 230, 170, 0.18)";
    ctx.beginPath();
    ctx.moveTo(x, peak - 1);
    ctx.lineTo(x - eaveX * 0.92, eaveY + 2.4);
    ctx.lineTo(x - eaveX * 0.38, eaveY + 2.8);
    ctx.lineTo(x, peak + 1.5);
    ctx.closePath();
    ctx.fill();

    // Słoma: pasma źdźbeł układane od kalenicy ku okapowi. Bez przycinania
    // ścieżką — końce i tak mieszczą się w połaciach, a clip był kosztowny
    // przy kilku chatach na ekranie.
    ctx.lineWidth = 0.55;
    const strawCount = w > 40 ? 16 : 10;
    for (let i = 0; i < strawCount; i++) {
      const t = i / (strawCount - 1);
      const sx0 = x + (t - 0.5) * w * 0.1;
      const dir = t < 0.5 ? -1 : 1;
      const reach = 0.38 + hash2(seed, i, 41) * 0.52;
      const ex = x + dir * eaveX * reach;
      const ey = peak + (eaveY - peak) * (0.7 + hash2(seed, i, 43) * 0.3);
      ctx.strokeStyle =
        i % 3 === 0
          ? "rgba(255, 232, 172, 0.32)"
          : i % 3 === 1
            ? "rgba(84, 58, 28, 0.28)"
            : "rgba(214, 178, 112, 0.3)";
      ctx.beginPath();
      ctx.moveTo(sx0 + (hash2(seed, i, 47) - 0.5) * 3, peak + 1.5);
      ctx.quadraticCurveTo(
        x + dir * eaveX * reach * 0.5,
        peak + (eaveY - peak) * 0.46,
        ex,
        ey
      );
      ctx.stroke();
    }
    // Ciemniejsze wiązania słomy.
    ctx.strokeStyle = "rgba(72, 48, 22, 0.24)";
    ctx.lineWidth = 0.7;
    for (let i = 1; i <= 2; i++) {
      const t = i / 3;
      ctx.beginPath();
      ctx.moveTo(x - eaveX * (1 - t * 0.34), eaveY - (eaveY - peak) * t * 0.32);
      ctx.quadraticCurveTo(
        x,
        peak + (eaveY - peak) * (0.18 + t * 0.26),
        x + eaveX * (1 - t * 0.34),
        eaveY - (eaveY - peak) * t * 0.32
      );
      ctx.stroke();
    }

    // Gruba, ciemna krawędź okapu.
    ctx.strokeStyle = "rgba(64, 42, 20, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - eaveX + 1, eaveY + 4.4);
    for (let i = 1; i <= fringe; i++) {
      const t = i / fringe;
      const fx = x - eaveX + eaveX * 2 * t;
      const jag = (hash2(seed, i, 21) * 2.6 - 1.3) * (1 - Math.abs(t - 0.5) * 1.1);
      ctx.lineTo(fx, eaveY + 3.4 + jag);
    }
    ctx.stroke();

    // Kalenica: gruby zwój słomy spinający obie połacie.
    ctx.strokeStyle = strawShade;
    ctx.lineWidth = Math.max(2.4, roofH * 0.18);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - half * 0.12, peak + 2);
    ctx.quadraticCurveTo(x, peak - 2.2, x + half * 0.12, peak + 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 235, 180, 0.32)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x - half * 0.1, peak + 0.4);
    ctx.quadraticCurveTo(x, peak - 2.4, x + half * 0.1, peak + 0.4);
    ctx.stroke();

    // Zerwany dach: ciemna wyrwa i trzepoczące pasma słomy.
    if (house.roofTorn) {
      const flap = Math.sin(this.time * 9 + seed) * 1.6;
      ctx.fillStyle = "rgba(14, 16, 18, 0.82)";
      ctx.beginPath();
      ctx.moveTo(x - half * 0.42, wallTop + 2.5);
      ctx.lineTo(x - half * 0.12, wallTop - roofH * 0.55);
      ctx.lineTo(x + half * 0.18, wallTop + 2.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = strawShade;
      ctx.beginPath();
      ctx.moveTo(x + half * 0.1, wallTop - roofH * 0.28);
      ctx.lineTo(x + half * 0.46 + flap, wallTop + 1.5);
      ctx.lineTo(x + half * 0.3, wallTop + 4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(248, 224, 172, 0.36)";
      ctx.lineWidth = 0.65;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(x - half * (0.3 - i * 0.08), wallTop + 1.4);
        ctx.lineTo(x - half * (0.16 - i * 0.03), wallTop - roofH * (0.32 + i * 0.1));
        ctx.stroke();
      }
    }

    // Drzwi z desek, z drewnianą futryną i kutym uchwytem.
    const doorW = Math.max(7, w * 0.22);
    const doorH = Math.min(wallH * 0.86, 19);
    const doorX = x - half * 0.42 - doorW * 0.5;
    const doorFrame = mixColor(trim, "#5c3b24", 0.42);
    ctx.fillStyle = "#2e1c11";
    ctx.fillRect(doorX - 1.8, y - doorH - 1.8, doorW + 3.6, doorH + 1.8);
    ctx.fillStyle = doorFrame;
    ctx.fillRect(doorX - 1.1, y - doorH - 1.1, doorW + 2.2, doorH + 1.1);
    const doorGrad = ctx.createLinearGradient(doorX, 0, doorX + doorW, 0);
    doorGrad.addColorStop(0, mixColor("#4a2c1a", wallDark, 0.3));
    doorGrad.addColorStop(0.55, "#5c3b24");
    doorGrad.addColorStop(1, "#3c2517");
    ctx.fillStyle = doorGrad;
    ctx.fillRect(doorX, y - doorH, doorW, doorH);
    ctx.strokeStyle = "rgba(24, 14, 8, 0.55)";
    ctx.lineWidth = 0.6;
    for (let i = 1; i < 4; i++) {
      const px = doorX + (doorW * i) / 4;
      ctx.beginPath();
      ctx.moveTo(px, y - doorH + 1);
      ctx.lineTo(px, y - 1);
      ctx.stroke();
    }
    // Ukośna deska wzmacniająca.
    ctx.strokeStyle = "rgba(30, 18, 10, 0.42)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(doorX + 1, y - doorH * 0.22);
    ctx.lineTo(doorX + doorW - 1, y - doorH * 0.78);
    ctx.stroke();
    ctx.fillStyle = "#2c2520";
    ctx.beginPath();
    ctx.arc(doorX + doorW * 0.76, y - doorH * 0.46, 1.1, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(220, 200, 168, 0.35)";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.arc(doorX + doorW * 0.76, y - doorH * 0.46, 1.1, 0, TAU);
    ctx.stroke();
    // Rzeźbiony nadprożnik.
    ctx.fillStyle = mixColor(trim, "#6a4326", 0.28);
    ctx.fillRect(doorX - 1.6, y - doorH - 3, doorW + 3.2, 2.1);
    ctx.strokeStyle = "rgba(54, 32, 16, 0.45)";
    ctx.lineWidth = 0.55;
    for (let i = 0; i < 3; i++) {
      const px = doorX + doorW * (0.18 + i * 0.32);
      ctx.beginPath();
      ctx.moveTo(px - 1.1, y - doorH - 2.7);
      ctx.lineTo(px, y - doorH - 1.2);
      ctx.lineTo(px + 1.1, y - doorH - 2.7);
      ctx.stroke();
    }

    // Rzeźbiony znak słońca na ścianie — opieka domowego ognia.
    if (wallH > 15) {
      const sunR = Math.min(4.6, w * 0.09);
      const sunX = x + half * 0.02;
      const sunY = wallTop + wallH * 0.16;
      ctx.strokeStyle = mixColor(trim, "#6a4326", 0.25);
      ctx.lineWidth = Math.max(0.55, 0.55 * (w / 46));
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunR * 0.55, 0, TAU);
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        ctx.beginPath();
        ctx.moveTo(
          sunX + Math.cos(a) * sunR * 0.82,
          sunY + Math.sin(a) * sunR * 0.82
        );
        ctx.lineTo(
          sunX + Math.cos(a) * sunR * 1.28,
          sunY + Math.sin(a) * sunR * 1.28
        );
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(72, 44, 22, 0.35)";
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunR * 0.2, 0, TAU);
      ctx.fill();
    }

    // Okno z okiennicami: nocą ciepło bije na zewnątrz.
    const winW = Math.max(6.5, w * 0.19);
    const winH = Math.min(wallH * 0.42, 11.5);
    const winX = x + half * 0.32 - winW * 0.5;
    const winY = wallTop + wallH * 0.3;
    const shutterW = Math.max(2.6, winW * 0.36);
    const shutterColor = mixColor(
      game.config.theme.folk?.embroidery ?? "#a83a2c",
      "#3a1c16",
      0.35
    );
    for (const side of [-1, 1]) {
      const sx =
        side < 0 ? winX - shutterW - 0.6 : winX + winW + 0.6;
      ctx.fillStyle = shutterColor;
      ctx.fillRect(sx, winY - 1, shutterW, winH + 2);
      ctx.strokeStyle = "rgba(40, 18, 12, 0.4)";
      ctx.lineWidth = 0.5;
      for (let i = 1; i < 3; i++) {
        const sy = winY + (winH * i) / 3;
        ctx.beginPath();
        ctx.moveTo(sx + 0.6, sy);
        ctx.lineTo(sx + shutterW - 0.6, sy);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(255, 220, 170, 0.2)";
      ctx.fillRect(sx + 0.6, winY, 0.7, winH);
    }
    if (night && burn < 0.7) {
      const glow = ctx.createRadialGradient(
        winX + winW / 2,
        winY + winH / 2,
        1,
        winX + winW / 2,
        winY + winH / 2,
        22
      );
      glow.addColorStop(0, "rgba(255, 207, 120, 0.55)");
      glow.addColorStop(1, "rgba(255, 170, 70, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(winX - 24, winY - 24, winW + 48, winH + 48);
      ctx.fillStyle = windowColor;
    } else {
      ctx.fillStyle = "#26333a";
    }
    ctx.fillRect(winX, winY, winW, winH);
    ctx.strokeStyle = mixColor(trim, "#5c3b24", 0.3);
    ctx.lineWidth = 1.6;
    ctx.strokeRect(winX - 0.8, winY - 0.8, winW + 1.6, winH + 1.6);
    ctx.strokeStyle = "#3a2518";
    ctx.lineWidth = 0.8;
    ctx.strokeRect(winX, winY, winW, winH);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(winX + winW / 2, winY);
    ctx.lineTo(winX + winW / 2, winY + winH);
    ctx.moveTo(winX, winY + winH / 2);
    ctx.lineTo(winX + winW, winY + winH / 2);
    ctx.stroke();
    // Kwiaty w drewnianej skrzynce pod oknem.
    if (wallH > 20 && w > 34) {
      const boxY = winY + winH + 1.6;
      ctx.fillStyle = "#4e3320";
      ctx.fillRect(winX - 1, boxY, winW + 2, 2.4);
      ctx.fillStyle = "#5f4128";
      ctx.fillRect(winX - 0.6, boxY, winW + 1.2, 0.9);
      for (let i = 0; i < 4; i++) {
        const fx = winX + 1 + (winW - 2) * (i / 3);
        ctx.fillStyle = i % 2 ? "#c2543f" : "#d7c46b";
        ctx.beginPath();
        ctx.arc(fx, boxY - 1.1 - (i % 2) * 0.5, 0.85, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = "rgba(64, 96, 52, 0.7)";
        ctx.lineWidth = 0.45;
        ctx.beginPath();
        ctx.moveTo(fx, boxY);
        ctx.lineTo(fx, boxY - 1.4);
        ctx.stroke();
      }
    }

    // Deski i słupki przy ścianie.
    ctx.fillStyle = "rgba(52, 34, 20, 0.55)";
    ctx.fillRect(x - half, y - 5, 2.2, 5);
    ctx.fillRect(x + half - 2.2, y - 5, 2.2, 5);

    if (wash > 0) this._drawHouseWash(ctx, house, w, wallH, wash);
    if (burn > 0) this._drawHouseFire(ctx, house, w, wallH, roofH, burn);

    ctx.restore();
  }

  /** Strugi deszczu i woda podmywająca chatę. */
  _drawHouseWash(ctx, house, w, wallH, wash) {
    const x = house.x;
    const y = house.y;
    const half = w / 2;
    const t = this.time;

    ctx.save();

    // Rozmokłe, ciemniejsze ściany.
    ctx.fillStyle = `rgba(58, 78, 88, ${0.3 * wash})`;
    ctx.fillRect(x - half, y - wallH, w, wallH);

    // Strugi wody spływające po deskach.
    ctx.strokeStyle = `rgba(174, 214, 230, ${0.5 * wash})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const seed = hash2(i, house.seed ?? 1, 17);
      const sx = x - half + w * (0.06 + seed * 0.88);
      const fall = (t * (26 + seed * 30) + seed * 40) % (wallH + 14);
      const sy = y - wallH + fall;
      const len = 4 + seed * 7;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 0.4, Math.min(y + 1, sy + len));
      ctx.stroke();
    }

    // Kałuża u stóp chaty.
    ctx.fillStyle = `rgba(150, 190, 206, ${0.35 * wash})`;
    ctx.beginPath();
    ctx.ellipse(x, y + 1.5, half * 1.06, 3.4, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `rgba(200, 230, 240, ${0.4 * wash})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.ellipse(x, y + 1.5, half * (0.7 + 0.3 * wash), 2.2, 0, 0, TAU);
    ctx.stroke();

    // Krople spadające z okapu.
    ctx.fillStyle = `rgba(190, 224, 236, ${0.55 * wash})`;
    for (let i = 0; i < 6; i++) {
      const seed = hash2(i, house.seed ?? 1, 29);
      const dx = x - half - 4 + (w + 8) * seed;
      const drop = (t * 70 + seed * 50) % 28;
      ctx.beginPath();
      ctx.ellipse(dx, y - wallH + drop, 0.9, 2.2, 0, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  /** Płomienie obejmujące ściany i dach. */
  _drawHouseFire(ctx, house, w, wallH, roofH, burn) {
    const x = house.x;
    const y = house.y;
    const top = y - wallH - roofH;
    const t = this.time;

    const flame = (cx, baseY, fw, fh, seed) => {
      const sway = Math.sin(t * 8 + seed * 12) * fw * 0.8;
      const grad = ctx.createLinearGradient(0, baseY, 0, baseY - fh);
      grad.addColorStop(0, "rgba(255, 92, 26, 0.82)");
      grad.addColorStop(0.45, "rgba(255, 168, 48, 0.75)");
      grad.addColorStop(1, "rgba(255, 236, 160, 0.04)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(cx - fw, baseY);
      ctx.quadraticCurveTo(cx - fw * 0.9, baseY - fh * 0.55, cx + sway, baseY - fh);
      ctx.quadraticCurveTo(cx + fw * 0.9, baseY - fh * 0.55, cx + fw, baseY);
      ctx.closePath();
      ctx.fill();
    };

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (let i = 0; i < 8; i++) {
      const seed = hash2(i, house.id ?? 1, 47);
      const fx = x + (seed * 2 - 1) * w * 0.55;
      const baseY = y - wallH * (0.05 + seed * 0.6);
      const flicker = 0.86 + 0.14 * Math.sin(t * 11 + seed * 9);
      const fh = (10 + 20 * seed) * (0.75 + burn * 0.55) * flicker;
      const fw = 2.4 + 3 * seed;
      flame(fx, baseY, fw, fh, seed);
    }

    // Płomień buchający z dachu.
    const roofFlame =
      (13 + 15 * burn) * (0.88 + 0.12 * Math.sin(t * 12 + house.firePhase));
    flame(x + 3, top + roofH * 0.55, w * 0.16, roofFlame, 0.37);

    const glowR = Math.max(34, w * 2.4);
    const grad = ctx.createRadialGradient(
      x,
      y - wallH * 0.7,
      2,
      x,
      y - wallH * 0.7,
      glowR
    );
    grad.addColorStop(0, "rgba(255, 170, 70, 0.28)");
    grad.addColorStop(1, "rgba(255, 80, 20, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y - wallH * 0.7, glowR, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  _drawHouseSite(ctx, site, game) {
    const housingTheme = game.config.theme.house || {};
    const wallPalette = housingTheme.wall || ["#8a5a34", "#7a4d2c", "#96663c"];
    const wall = wallPalette[Math.floor(site.seed ?? 1) % wallPalette.length];
    const progress = clamp(site.progress ?? 0, 0, 1);
    const w = site.w ?? 46;
    const wallH = site.wallH ?? 27;
    const half = w / 2;
    const x = site.x;
    const y = site.y;

    ctx.save();

    // Wydeptana ziemia i fundament.
    ctx.fillStyle = "rgba(70, 55, 36, 0.28)";
    ctx.beginPath();
    ctx.ellipse(x, y - 1, half * 1.2, 4, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#5c564c";
    ctx.fillRect(x - half, y - 4, w, 4);

    // Pale i poziome belki.
    const postH = 5 + wallH * 0.7 * (0.25 + progress * 0.75);
    ctx.strokeStyle = "#6b4a2f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - half + 3, y);
    ctx.lineTo(x - half + 3, y - postH);
    ctx.moveTo(x + half - 3, y);
    ctx.lineTo(x + half - 3, y - postH);
    ctx.stroke();
    ctx.strokeStyle = "rgba(176, 130, 76, 0.65)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - half + 3, y - wallH * 0.55);
    ctx.lineTo(x + half - 3, y - wallH * 0.55);
    ctx.stroke();

    // Stos ściętych pni.
    const logs = Math.min(6, Math.max(0, site.wood ?? 0));
    for (let i = 0; i < logs; i++) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const lx = x + half * 0.55 + col * 4.6;
      const ly = y - 2.6 - row * 4.4;
      ctx.fillStyle = "#6b4a2f";
      ctx.beginPath();
      ctx.ellipse(lx, ly, 2.2, 2.2, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#c9a46b";
      ctx.beginPath();
      ctx.ellipse(lx, ly, 1.1, 1.1, 0, 0, TAU);
      ctx.fill();
    }

    // Ściany rosną z postępem budowy.
    if (progress > 0.03) {
      const builtH = wallH * progress;
      ctx.fillStyle = rgba(wall, 0.82);
      ctx.fillRect(x - half + 2, y - 4 - builtH, w - 4, builtH);
      ctx.strokeStyle = "rgba(38, 24, 14, 0.32)";
      ctx.lineWidth = 0.7;
      for (let px = x - half + 7; px < x + half - 2; px += 6.5) {
        ctx.beginPath();
        ctx.moveTo(px, y - 4 - builtH);
        ctx.lineTo(px, y - 4);
        ctx.stroke();
      }
    }

    // Szkielet dachu pojawia się pod koniec.
    if (progress > 0.62) {
      const roofH = site.roofH ?? 16;
      const roofAlpha = clamp((progress - 0.62) / 0.38, 0, 1);
      ctx.strokeStyle = `rgba(93, 59, 42, ${0.35 + roofAlpha * 0.5})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - half - 5, y - wallH - 1);
      ctx.lineTo(x, y - wallH - roofH);
      ctx.lineTo(x + half + 5, y - wallH - 1);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawCrops(ctx, game, view) {
    const crops = game.crops;
    if (!crops) return;
    for (const plot of crops.plots) {
      if (plot.x + plot.w < view.left - 30 || plot.x - plot.w > view.right + 30) {
        continue;
      }
      if (plot.y < view.top - 50 || plot.y > view.bottom + 30) continue;
      this._drawCropPlot(ctx, plot, game.camera?.zoom ?? 1);
    }
  }

  _drawCropPlot(ctx, plot, zoom = 1) {
    const w = plot.w;
    const soilH = 5;
    const wet =
      plot.wet ||
      plot.rot > 0.05 ||
      (plot.rainWet || 0) > 0.04 ||
      (plot.soilMoisture || 0) > 0.2;
    ctx.save();
    ctx.translate(plot.x, plot.y);

    // Zaorana ziemia.
    ctx.fillStyle = wet ? "rgba(49, 42, 33, 0.92)" : "rgba(81, 57, 37, 0.94)";
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.5, soilH, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = wet
      ? "rgba(64, 56, 44, 0.55)"
      : "rgba(104, 75, 48, 0.55)";
    ctx.beginPath();
    ctx.ellipse(0, -1.2, w * 0.46, soilH * 0.62, 0, 0, TAU);
    ctx.fill();

    // Bruzdy.
    ctx.strokeStyle = "rgba(43, 30, 19, 0.5)";
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 4; i++) {
      const fy = -soilH + 1.4 + i * 1.15;
      ctx.beginPath();
      ctx.moveTo(-w * 0.42, fy);
      ctx.quadraticCurveTo(0, fy + 0.6, w * 0.42, fy);
      ctx.stroke();
    }

    const showCrop =
      plot.state === "growing" ||
      plot.state === "ripe" ||
      plot.burning;
    const ripe = plot.state === "ripe" || plot.burning;
    const growth = plot.burning ? 1 : plot.growth;
    const rot = plot.rot || 0;

    if (showCrop) {
      // Przy oddalonej kamerze gęste źdźbła zlewają się w plamę — mniej
      // linii daje ten sam obraz przy ułamku kosztu.
      const stems =
        zoom < 0.8
          ? Math.max(6, Math.round(w / 6.5))
          : Math.max(16, Math.round(w / 3.4));
      const baseColor = ripe ? "#d8b24a" : "#6f9a44";
      const tipColor = ripe ? "#f0d98a" : "#9cc766";

      for (let i = 0; i < stems; i++) {
        const seed = hash2(plot.id, i, 7);
        const u = (i + 0.5) / stems - 0.5;
        const sx = u * w * 0.9;
        const stemH =
          (plot.burning ? 6 : 2.2 + growth * 10.5) * (0.82 + seed * 0.34);
        const sway =
          Math.sin(this.time * 1.9 + i * 0.85 + plot.seed) *
          (0.35 + growth * 0.75);
        const windBend = (plot.windBend || 0) * (0.55 + seed * 0.9);
        const bend = rot * (seed > 0.5 ? 1 : -1) * 2.4 + windBend;
        const color = plot.burning
          ? "#5a4030"
          : mixColor(baseColor, tipColor, seed * 0.8);
        const alpha = plot.burning
          ? 1 - (plot.burnTimer / Math.max(0.01, plot.burnDuration)) * 0.55
          : 1 - rot * 0.55;

        ctx.strokeStyle = rgba(color, Math.max(0, alpha));
        ctx.lineWidth = 1.05;
        ctx.beginPath();
        ctx.moveTo(sx, -soilH + 0.5);
        ctx.quadraticCurveTo(
          sx + sway * 0.4 + bend * 0.5,
          -stemH * 0.55,
          sx + sway + bend,
          -stemH
        );
        ctx.stroke();

        // Kłosy dojrzewają na końcach źdźbeł.
        if (ripe && !plot.burning && growth > 0.55) {
          ctx.fillStyle = rgba(tipColor, alpha * 0.95);
          ctx.beginPath();
          ctx.ellipse(
            sx + sway + bend,
            -stemH - 0.4,
            0.8,
            1.8,
            0.18 * sway,
            0,
            TAU
          );
          ctx.fill();
        }
      }
    } else {
      // Ściernisko po żniwach.
      ctx.strokeStyle = "rgba(190, 164, 96, 0.45)";
      ctx.lineWidth = 0.8;
      for (let i = 0; i < 6; i++) {
        const sx = ((i + 0.5) / 6 - 0.5) * w * 0.8;
        ctx.beginPath();
        ctx.moveTo(sx, -1);
        ctx.lineTo(sx + 0.5, -2.2);
        ctx.stroke();
      }
    }

    // Płomienie trawiące pole.
    if (plot.burning) {
      const flicker = 0.7 + 0.3 * Math.sin(this.time * 13 + plot.seed);
      const charred = clamp(
        plot.burnTimer / Math.max(0.01, plot.burnDuration),
        0,
        1
      );
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 7; i++) {
        const seed = hash2(plot.id, i, 31);
        const fx = (seed * 2 - 1) * w * 0.46;
        const fh = (5 + 9 * seed) * flicker;
        ctx.fillStyle = "rgba(255, 140, 35, 0.82)";
        ctx.beginPath();
        ctx.ellipse(fx, -fh * 0.55, 2 + seed * 2, fh, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "rgba(255, 232, 140, 0.85)";
        ctx.beginPath();
        ctx.ellipse(fx, -fh * 0.38, 1 + seed, fh * 0.5, 0, 0, TAU);
        ctx.fill();
      }
      const glow = ctx.createRadialGradient(0, -5, 2, 0, -5, w * 0.6);
      glow.addColorStop(0, `rgba(255, 170, 70, ${0.32 * (1 - charred * 0.4)})`);
      glow.addColorStop(1, "rgba(255, 80, 20, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(0, -5, w * 0.6, 18, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  _drawStump(ctx, stump, game) {
    const x = stump.x;
    const y = stump.y;
    const r = Math.max(2.2, stump.r ?? 3);
    const h = Math.max(2.5, stump.h ?? 4);
    ctx.save();
    ctx.fillStyle = "rgba(12, 18, 12, 0.16)";
    ctx.beginPath();
    ctx.ellipse(x + 2, y + 0.8, r * 1.6, 1.6, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#4a3322";
    ctx.fillRect(x - r, y - h, r * 2, h);
    ctx.fillStyle = "#8a6640";
    ctx.beginPath();
    ctx.ellipse(x, y - h, r, r * 0.45, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(74, 51, 34, 0.7)";
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    ctx.ellipse(x, y - h, r * 0.55, r * 0.25, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /** Drabiny i place budowy pod zbyt wysokimi skarpami. */
  _drawLadders(ctx, game, view) {
    const ladders = game.ladders;
    if (!ladders) return;

    for (const site of ladders.sites) {
      if (site.x < view.left - 80 || site.x > view.right + 80) continue;
      if (
        site.baseY < view.top - 170 ||
        site.baseY > view.bottom + 40
      ) {
        continue;
      }
      this._drawLadderSite(ctx, site);
    }

    for (const ladder of ladders.ladders) {
      if (ladder.x < view.left - 80 || ladder.x > view.right + 80) continue;
      if (
        ladder.baseY < view.top - 170 ||
        ladder.baseY > view.bottom + 40
      ) {
        continue;
      }
      this._drawLadder(ctx, ladder, 1);
    }
  }

  _drawLadder(ctx, ladder, progress = 1) {
    const baseX = ladder.x;
    const baseY = ladder.baseY;
    const topX = ladder.topX;
    const topY = ladder.topY + 1;
    const t = clamp(progress, 0.05, 1);
    const woodDark = "#4b341f";
    const wood = "#c9a46b";
    const woodLight = "#e8cb95";

    ctx.save();
    ctx.lineCap = "round";

    // Cień rzucany na ścianę.
    ctx.strokeStyle = "rgba(18, 13, 9, 0.22)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(baseX + 1.4, baseY);
    ctx.lineTo(baseX + 1.4 + (topX - baseX) * t, baseY + (topY - baseY) * t);
    ctx.stroke();

    // Ciemna obwódka, potem jasne drewno — drabina nie zlewa się ze skałą.
    for (const side of [-1, 1]) {
      const bx = baseX + side * 3.2;
      const ex = bx + (topX - baseX) * t;
      const ey = baseY + (topY - baseY) * t;
      ctx.strokeStyle = woodDark;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(bx, baseY);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.strokeStyle = side < 0 ? wood : woodLight;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, baseY);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }

    // Szczeble.
    const rungCount = Math.max(1, Math.floor(Math.abs(baseY - topY) / 6.2));
    const visible = Math.min(rungCount, Math.floor(rungCount * t));
    for (let i = 1; i <= visible; i++) {
      const f = i / rungCount;
      const rx = baseX + (topX - baseX) * f;
      const ry = baseY + (topY - baseY) * f;
      ctx.strokeStyle = woodDark;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(rx - 3.4, ry);
      ctx.lineTo(rx + 3.4, ry);
      ctx.stroke();
      ctx.strokeStyle = woodLight;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(rx - 3.2, ry - 0.2);
      ctx.lineTo(rx + 3.2, ry - 0.2);
      ctx.stroke();
    }

    // Ogień na płonącej drabinie (jak płonące drzewo).
    if (ladder.burning) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const flicker = 0.72 + 0.28 * Math.sin(this.time * 13 + (ladder.firePhase || 0));
      const h = Math.max(1, Math.abs(baseY - topY));
      const steps = Math.max(2, Math.floor(h / 5.4));
      for (let i = 0; i < steps; i++) {
        const f = (i + 0.5) / steps;
        const rx = baseX + (topX - baseX) * f;
        const ry = baseY + (topY - baseY) * f;
        const ph = (4 + 7 * ((((i + 1) * 37) % 9) / 9)) * flicker;
        ctx.fillStyle = "rgba(255, 140, 35, 0.82)";
        ctx.beginPath();
        ctx.ellipse(rx, ry - ph * 0.45, 1.7, ph, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "rgba(255, 230, 130, 0.85)";
        ctx.beginPath();
        ctx.ellipse(rx, ry - ph * 0.3, 0.85, ph * 0.55, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  _drawLadderSite(ctx, site) {
    const x = site.x;
    const y = site.baseY;
    const dir = site.dir >= 0 ? 1 : -1;
    const logs = Math.max(1, Math.round(site.wood || 1));

    ctx.save();

    // Stos drewna przy podnóżu ściany.
    for (let i = 0; i < logs; i++) {
      const offset = (i - (logs - 1) / 2) * 2.6;
      const ly = y - 1.6 - (i % 2) * 2.4;
      ctx.fillStyle = i % 2 ? "#6f4d2d" : "#8a6238";
      ctx.beginPath();
      ctx.ellipse(x - dir * 9 + offset, ly, 4.2, 1.5, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#c39a63";
      ctx.beginPath();
      ctx.ellipse(x - dir * 9 + offset, ly - 0.5, 1.5, 0.6, 0, 0, TAU);
      ctx.fill();
    }

    // Drabina rośnie wraz z postępem budowy.
    this._drawLadder(ctx, site, 0.12 + clamp(site.progress, 0, 1) * 0.82);

    ctx.restore();
  }

  _drawTrees(ctx, view, game) {
    const stumps = game.vegetation.stumps || [];
    for (const stump of stumps) {
      if (stump.x < view.left - 30 || stump.x > view.right + 30) continue;
      if (stump.y < view.top - 30 || stump.y > view.bottom + 20) continue;
      this._drawStump(ctx, stump, game);
    }

    const trees = game.vegetation.trees;
    // Rysujemy od najwyżej położonych, by dolne przesłaniały górne.
    for (const tree of trees) {
      if (tree.x < view.left - 80 || tree.x > view.right + 80) continue;
      if (tree.y < view.top - 140 || tree.y > view.bottom + 40) continue;
      this._drawTree(ctx, tree, game, false);
    }
  }

  _drawTree(ctx, tree, game, foreground) {
    const growth = clamp(tree.growth ?? 1, 0.04, 1);
    const flourish = clamp(tree.flourish ?? 0, 0, 1);
    const burn = tree.burning
      ? clamp(tree.burnTimer / Math.max(0.001, tree.burnDuration), 0, 1)
      : 0;
    const scale = (0.18 + 0.82 * growth) * (1 + flourish * 0.16) * (1 - burn * 0.18);
    const h = tree.h * scale;
    const w = tree.w * scale;
    const gust = clamp(tree.gust ?? 0, 0, 1.3) * (tree.gustDir || 1);
    const sway =
      Math.sin(this.time * 0.55 + tree.phase) * 1.4 * (0.35 + growth * 0.65) +
      gust * (2.4 + h * 0.055) +
      Math.sin(this.time * 9 + tree.phase * 3) * gust * 1.6;
    const topX = tree.x + sway + h * tree.lean;
    const topY = tree.y - h;
    // Kolory drzewa zmieniają się tylko wraz z kwitnieniem/pożarem, więc
    // liczymy je raz i trzymamy na obiekcie (kwantyzacja chroni przed
    // przeliczaniem przy każdej klatce animacji).
    const burnQ = burn > 0 ? Math.round(burn * 24) / 24 : 0;
    const flourishQ = Math.round(flourish * 16) / 16;
    // Gatunki słowiańskiego lasu: dąb, brzoza i lipa wśród sosen i świerków.
    const variant = tree.id % 3;
    const birch = tree.type === "leaf" && variant === 1;
    const oak = tree.type === "leaf" && variant === 0;
    let colors = tree._colors;
    if (
      !colors ||
      colors.burnQ !== burnQ ||
      colors.flourishQ !== flourishQ ||
      colors.canopySrc !== tree.canopy ||
      colors.variant !== variant
    ) {
      const treeTheme = game.config.theme.tree;
      const canopy = mixColor(
        mixColor(tree.canopy, "#79b957", flourishQ * 0.22),
        "#2b1a10",
        burnQ * 0.86
      );
      const trunkSrc = birch
        ? treeTheme.birchTrunk ?? "#d9d5c5"
        : mixColor(treeTheme.trunk, birch ? "#7a5a3a" : "#241a12", oak ? 0.1 : 0);
      colors = {
        burnQ,
        flourishQ,
        canopySrc: tree.canopy,
        variant,
        trunk: mixColor(trunkSrc, "#17100c", burnQ * 0.8),
        trunkLight: mixColor(trunkSrc, "#fff0d2", birch ? 0.22 : 0.12),
        canopy: birch ? mixColor(canopy, "#b9cf82", 0.18) : canopy,
        pine: [0, 1, 2, 3, 4].map((i) =>
          mixColor(canopy, "#0d1f18", ((i / 5) * 0.34).toFixed(4))
        ),
        round: [0, 1, 2, 3].map((i) =>
          mixColor(canopy, "#173d20", (i % 4) * 0.12)
        ),
      };
      tree._colors = colors;
    }
    const trunkColor = colors.trunk;
    const canopy = colors.canopy;
    const alpha = foreground ? 0.92 : 1;
    // Daleki plan: mniejsza liczba warstw korony przy mocno oddalonej kamerze.
    const simple = h * (game.camera?.zoom ?? 1) < 34;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (tree.fallAngle) {
      ctx.translate(tree.x, tree.y);
      ctx.rotate(tree.fallAngle);
      ctx.translate(-tree.x, -tree.y);
    }

    // Cień.
    if (!tree.fallAngle) {
      ctx.fillStyle = "rgba(12, 18, 12, 0.16)";
      ctx.beginPath();
      ctx.ellipse(tree.x + 4, tree.y + 1, w * 0.55, 3.2, 0, 0, TAU);
      ctx.fill();
    }

    // Poświata ognia jest rysowana w _drawFlames; shadowBlur na całym
    // drzewie był kosztowny przy pożarze lasu, a dawał niemal ten sam efekt.

    // Pień — brzoza cieńsza i biała, dąb masywniejszy.
    ctx.strokeStyle = trunkColor;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2, w * (birch ? 0.075 : oak ? 0.14 : 0.11));
    ctx.beginPath();
    ctx.moveTo(tree.x, tree.y);
    ctx.quadraticCurveTo(tree.x + sway * 0.4, tree.y - h * 0.55, topX, topY + h * 0.3);
    ctx.stroke();

    // Podłużne rozjaśnienie kory.
    if (!simple) {
      ctx.strokeStyle = rgba(colors.trunkLight, 0.22);
      ctx.lineWidth = Math.max(0.6, w * 0.028);
      ctx.beginPath();
      ctx.moveTo(tree.x - w * 0.035, tree.y - h * 0.06);
      ctx.quadraticCurveTo(
        tree.x - w * 0.02 + sway * 0.4,
        tree.y - h * 0.55,
        topX - w * 0.03,
        topY + h * 0.31
      );
      ctx.stroke();
    }

    // Ciemne pasy na pniu brzozy.
    if (birch && !simple) {
      ctx.fillStyle = "rgba(42, 36, 28, 0.62)";
      for (let i = 0; i < 6; i++) {
        const bt = 0.12 + i * 0.13;
        const bx = tree.x + (topX - tree.x) * bt + (i % 2 ? 1 : -1) * w * 0.045;
        const by = tree.y - h * bt;
        ctx.beginPath();
        ctx.ellipse(bx, by, w * 0.055, Math.max(0.5, w * 0.014), 0.15, 0, TAU);
        ctx.fill();
      }
    }

    ctx.lineWidth = Math.max(1, w * (oak ? 0.065 : 0.05));
    if (!simple) {
      ctx.beginPath();
      ctx.moveTo(tree.x + sway * 0.3, tree.y - h * 0.55);
      ctx.lineTo(tree.x - w * 0.22 + sway * 0.5, tree.y - h * 0.72);
      ctx.moveTo(tree.x + sway * 0.4, tree.y - h * 0.42);
      ctx.lineTo(tree.x + w * 0.24 + sway * 0.5, tree.y - h * 0.62);
      ctx.stroke();
      // Brzoza: zwisające cienkie gałązki (tylko w dużym zbliżeniu).
      if (birch && h * (game.camera?.zoom ?? 1) > 48) {
        ctx.strokeStyle = rgba(trunkColor, 0.62);
        ctx.lineWidth = Math.max(0.45, w * 0.018);
        for (let i = 0; i < 4; i++) {
          const bx = tree.x + (i - 1.5) * w * 0.16 + sway * 0.5;
          const by = tree.y - h * (0.58 + (i % 2) * 0.1);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.quadraticCurveTo(bx + w * 0.16, by + h * 0.12, bx + w * 0.06, by + h * 0.26);
          ctx.stroke();
        }
      }
    }

    if (tree.type === "pine") {
      // Świerk pospolity: warstwowe, postrzępione okółki.
      const layers = simple ? 2 : 5;
      for (let i = 0; i < layers; i++) {
        const t = i / layers;
        const cy = tree.y - h * (0.24 + t * 0.68);
        const cw = w * (1 - t * 0.58);
        const chh = h * 0.27;
        ctx.fillStyle = colors.pine[Math.min(i, 4)];
        ctx.beginPath();
        ctx.moveTo(topX + (tree.x - topX) * t, cy - chh);
        ctx.lineTo(topX + cw, cy + chh * 0.16);
        const steps = simple ? 2 : 4;
        for (let j = 1; j <= steps; j++) {
          const f = j / steps;
          ctx.lineTo(
            topX + cw * (1 - 2 * f),
            cy + chh * (j % 2 ? 0.6 : 0.24)
          );
        }
        ctx.lineTo(topX - cw, cy + chh * 0.16);
        ctx.closePath();
        ctx.fill();
      }
      if (simple) {
        if (burn > 0) this._drawFlames(ctx, tree, h, w, burn);
        ctx.restore();
        return;
      }
      ctx.fillStyle = "rgba(200, 230, 190, 0.12)";
      ctx.beginPath();
      ctx.moveTo(topX, tree.y - h * 0.92);
      ctx.lineTo(topX + w * 0.2, tree.y - h * 0.58);
      ctx.lineTo(topX, tree.y - h * 0.52);
      ctx.closePath();
      ctx.fill();
      // Ciemniejsze igliwie pod okółkami.
      ctx.strokeStyle = "rgba(18, 42, 30, 0.28)";
      ctx.lineWidth = 0.6;
      for (let i = 1; i < layers; i++) {
        const t = i / layers;
        const cy = tree.y - h * (0.24 + t * 0.68);
        const cw = w * (1 - t * 0.58);
        ctx.beginPath();
        ctx.moveTo(topX - cw * 0.8, cy + h * 0.045);
        ctx.quadraticCurveTo(topX, cy + h * 0.075, topX + cw * 0.8, cy + h * 0.045);
        ctx.stroke();
      }
    } else {
      const cx = topX;
      let cy;
      let r;
      let blobs;
      if (oak) {
        // Dąb: szeroka, ciężka korona.
        cy = tree.y - h * 0.69;
        r = w * 0.98;
        blobs = simple
          ? [
              [0, 0, r],
              [r * 0.5, r * 0.1, r * 0.7],
            ]
          : [
              [0, 0, r],
              [-r * 0.62, r * 0.16, r * 0.7],
              [r * 0.64, r * 0.12, r * 0.72],
              [-r * 0.28, -r * 0.46, r * 0.62],
              [r * 0.32, -r * 0.4, r * 0.58],
              [r * 0.02, -r * 0.06, r * 0.7],
            ];
      } else if (birch) {
        // Brzoza: zwiewna, jaśniejsza korona.
        cy = tree.y - h * 0.76;
        r = w * 0.74;
        blobs = simple
          ? [
              [0, 0, r],
              [r * 0.4, r * 0.14, r * 0.66],
            ]
          : [
              [0, 0, r],
              [-r * 0.5, r * 0.14, r * 0.62],
              [r * 0.54, r * 0.1, r * 0.65],
              [-r * 0.22, -r * 0.46, r * 0.54],
              [r * 0.26, -r * 0.4, r * 0.5],
              [0, r * 0.36, r * 0.52],
            ];
      } else {
        // Lipa: gęsta, wysoka korona o sercowatym zarysie.
        cy = tree.y - h * 0.74;
        r = w * 0.82;
        blobs = simple
          ? [
              [0, 0, r],
              [r * 0.42, r * 0.12, r * 0.68],
            ]
          : [
              [0, -r * 0.08, r],
              [-r * 0.48, r * 0.18, r * 0.66],
              [r * 0.5, r * 0.16, r * 0.68],
              [-r * 0.2, -r * 0.42, r * 0.62],
              [r * 0.24, -r * 0.4, r * 0.58],
              [0, r * 0.34, r * 0.56],
            ];
      }
      for (let i = 0; i < blobs.length; i++) {
        const [ox, oy, br] = blobs[i];
        ctx.fillStyle = i === 0 ? canopy : colors.round[i % 4];
        ctx.beginPath();
        ctx.ellipse(cx + ox, cy + oy, br, br * (birch ? 0.78 : 0.86), 0, 0, TAU);
        ctx.fill();
      }
      if (simple) {
        if (burn > 0) this._drawFlames(ctx, tree, h, w, burn);
        ctx.restore();
        return;
      }
      // Pasmo światła na koronie.
      ctx.fillStyle = "rgba(230, 245, 200, 0.13)";
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.28, cy - r * 0.36, r * 0.46, r * 0.3, -0.4, 0, TAU);
      ctx.fill();
      // Brzoza: zwisające cienkie gałązki z listkami.
      if (birch && h * (game.camera?.zoom ?? 1) > 48) {
        ctx.strokeStyle = rgba(colors.trunkLight, 0.34);
        ctx.lineWidth = Math.max(0.4, w * 0.014);
        for (let i = 0; i < 5; i++) {
          const bx = cx + (i - 2) * r * 0.32;
          const by = cy + r * 0.2;
          const drop = h * (0.11 + (i % 3) * 0.045);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.quadraticCurveTo(bx + r * 0.12, by + drop * 0.6, bx + r * 0.04, by + drop);
          ctx.stroke();
          ctx.fillStyle = rgba(colors.round[i % 4], 0.5);
          for (let j = 1; j <= 3; j++) {
            ctx.beginPath();
            ctx.ellipse(
              bx + r * 0.08 * (j / 3),
              by + drop * (j / 3),
              Math.max(0.6, w * 0.035),
              Math.max(0.4, w * 0.022),
              0.4,
              0,
              TAU
            );
            ctx.fill();
          }
        }
      }
    }

    if (burn > 0) this._drawFlames(ctx, tree, h, w, burn);
    ctx.restore();
  }

  _drawFlames(ctx, tree, h, w, burn) {
    const flicker = 0.72 + 0.28 * Math.sin(this.time * 13 + tree.firePhase);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (let i = 0; i < 5; i++) {
      const seed = hash2(i, tree.id, 31);
      const x = tree.x + (seed * 2 - 1) * w * 0.5;
      const y = tree.y - h * (0.06 + seed * 0.86);
      const fh = (6 + 10 * seed) * flicker * (0.65 + burn * 0.35);
      const fw = 2.5 + 2.5 * seed;
      ctx.fillStyle = "rgba(255, 140, 35, 0.8)";
      ctx.beginPath();
      ctx.ellipse(x, y - fh * 0.45, fw, fh, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 230, 130, 0.85)";
      ctx.beginPath();
      ctx.ellipse(x, y - fh * 0.3, fw * 0.48, fh * 0.55, 0, 0, TAU);
      ctx.fill();
    }

    const glowR = Math.max(22, w * 2.2);
    const grad = ctx.createRadialGradient(
      tree.x,
      tree.y - h * 0.5,
      2,
      tree.x,
      tree.y - h * 0.5,
      glowR
    );
    grad.addColorStop(0, "rgba(255, 170, 70, 0.28)");
    grad.addColorStop(1, "rgba(255, 80, 20, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(tree.x, tree.y - h * 0.5, glowR, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _drawPeople(ctx, game, view) {
    // Sortowanie w miejscu na współdzielonej tablicy: bez kopii całej listy
    // i bez sortowania osób poza ekranem.
    const order = this._peopleOrder || (this._peopleOrder = []);
    order.length = 0;
    for (const p of game.population.people) {
      if (p.state === "sleep" && p.sleepIndoors) continue;
      if (p.x < view.left - 30 || p.x > view.right + 30) continue;
      if (p.y < view.top - 60 || p.y > view.bottom + 40) continue;
      order.push(p);
    }
    order.sort((a, b) => a.y - b.y || a.id - b.id);
    for (const p of order) {
      this._drawPerson(ctx, p, game);
      if (p.hunger >= 0.9) this._drawHungerMark(ctx, p);
    }
  }

  /** Drobny znak nad głową człowieka, który od dłuższego czasu głoduje. */
  _drawHungerMark(ctx, person) {
    const pulse = 0.65 + 0.35 * Math.sin(this.time * 4.2 + person.id);
    const s = Math.max(1.6, person.h * 0.07);
    const x = person.x;
    const y = person.y - person.h - 5;
    ctx.save();
    ctx.fillStyle = `rgba(240, 190, 90, ${0.45 + pulse * 0.4})`;
    ctx.fillRect(x - s * 0.5, y - s * 2.6, s, s * 1.7);
    ctx.beginPath();
    ctx.arc(x, y - s * 0.35, s * 0.62, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Złote iskry lush unoszące się z ludzi ogarniętych paniką. */
  _drawLushMotes(ctx, person) {
    const t = this.time;
    const h = person.h;
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const cycle = (t * 0.45 + i / 3 + (person.id % 9) * 0.08) % 1;
      const x =
        person.x +
        (i - 1) * 4.2 +
        Math.sin(t * 2.2 + i * 2.1 + person.id) * 3.4;
      const y = person.y - h * 0.2 - cycle * h * 1.05;
      const alpha = Math.sin(cycle * Math.PI) * 0.78;
      ctx.fillStyle = `rgba(255, 214, 122, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.8 + (1 - cycle) * 1.3, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Uproszczona sylwetka dla małych postaci (minimalne zoom / daleki plan). */
  _drawPersonLOD(ctx, person, palette, o) {
    const { cx, feetY, w, h, scale, facing, isFemale, isChild, swimming, dress } = o;
    const skin = palette.skin;
    const headR = Math.max(2.1, h * 0.145);
    const headY = feetY - h * 0.94;
    const shoulderY = feetY - h * 0.77;
    const hipY = feetY - h * 0.44;
    const shoulderW = w * (isFemale ? (isChild ? 0.7 : 0.68) : isChild ? 0.8 : 0.9);
    const hipW = w * (isFemale ? (isChild ? 0.68 : 0.86) : isChild ? 0.64 : 0.66);
    const swing = o.moving ? Math.sin(o.phase) * 3.2 * scale : 0;
    const legColor = swimming || dress ? skin : palette.pants;
    const clothColor = swimming ? skin : palette.clothes;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Nogi.
    ctx.strokeStyle = legColor;
    ctx.lineWidth = Math.max(1.4, (isFemale ? 2.1 : 2.5) * scale);
    ctx.beginPath();
    ctx.moveTo(cx - hipW * 0.26, hipY);
    ctx.lineTo(cx - hipW * 0.22 - swing, feetY);
    ctx.moveTo(cx + hipW * 0.26, hipY);
    ctx.lineTo(cx + hipW * 0.22 + swing, feetY);
    ctx.stroke();

    // Tors.
    ctx.fillStyle = clothColor;
    ctx.beginPath();
    ctx.moveTo(cx - shoulderW * 0.5, shoulderY);
    ctx.quadraticCurveTo(cx - w * 0.34, hipY, cx - hipW * 0.5, hipY);
    ctx.quadraticCurveTo(cx, hipY + h * 0.02, cx + hipW * 0.5, hipY);
    ctx.quadraticCurveTo(cx + w * 0.34, hipY, cx + shoulderW * 0.5, shoulderY);
    ctx.quadraticCurveTo(cx, shoulderY - h * 0.02, cx - shoulderW * 0.5, shoulderY);
    ctx.closePath();
    ctx.fill();

    // Ramiona (tylne ciemniejsze).
    const armSwing = o.moving ? Math.sin(o.phase + Math.PI) * 3.2 * scale : 0;
    ctx.strokeStyle = swimming ? skin : palette.armBackSleeve;
    ctx.lineWidth = Math.max(1.1, 2.1 * scale);
    ctx.beginPath();
    ctx.moveTo(cx - facing * shoulderW * 0.42, shoulderY + h * 0.02);
    ctx.quadraticCurveTo(
      cx - facing * shoulderW * 0.6,
      shoulderY + h * 0.12,
      cx - facing * shoulderW * 0.55 - armSwing,
      hipY + h * 0.01
    );
    ctx.stroke();
    ctx.strokeStyle = swimming ? skin : palette.clothes;
    ctx.beginPath();
    ctx.moveTo(cx + facing * shoulderW * 0.42, shoulderY + h * 0.02);
    ctx.quadraticCurveTo(
      cx + facing * shoulderW * 0.6,
      shoulderY + h * 0.12,
      cx + facing * shoulderW * 0.55 + armSwing,
      hipY + h * 0.01
    );
    ctx.stroke();

    // Włosy z tyłu, głowa i grzywka.
    const hair = palette.hair;
    if (isFemale && person.ageYears > 3) {
      ctx.fillStyle = palette.hairShade;
      ctx.beginPath();
      ctx.ellipse(
        cx - facing * headR * 0.16,
        headY + headR * 0.62,
        headR * 0.95,
        headR * (isChild ? 0.95 : 1.28),
        0,
        0,
        TAU
      );
      ctx.fill();
    }
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(cx + facing * headR * 0.02, headY, headR * 0.96, headR * 1.02, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.ellipse(
      cx + facing * headR * 0.02,
      headY - headR * 0.42,
      headR * 1.02,
      headR * 0.62,
      0,
      Math.PI,
      TAU
    );
    ctx.fill();

    if (o.swimming && o.swimColor) {
      ctx.fillStyle = o.swimColor;
      ctx.fillRect(
        cx - hipW * 0.42,
        hipY - h * 0.02,
        hipW * 0.84,
        Math.max(1.4, h * 0.055)
      );
    }

    ctx.restore();
  }

  /** Cache palety ubrań/skóry dla osoby (zmienia się rzadko). */
  _personPalette(person, swimming, bare, old) {
    const hair = old ? "#d6d1c7" : person.hairColor;
    let p = person._paletteCache;
    if (
      p &&
      p.srcSkin === person.skinTone &&
      p.srcClothes === person.clothesColor &&
      p.srcHair === hair &&
      p.swimming === swimming &&
      p.bare === bare
    ) {
      return p;
    }

    const skin = person.skinTone;
    const skinShade = mixColor(skin, "#5a3322", 0.22);
    const skinLight = mixColor(skin, "#ffe8cf", 0.24);
    const hairShade = mixColor(hair, "#17100d", 0.34);
    const hairLight = mixColor(hair, "#ffe9c8", 0.32);
    const clothes = bare ? skin : person.clothesColor;
    p = {
      srcSkin: skin,
      srcClothes: person.clothesColor,
      srcHair: hair,
      swimming,
      bare,
      skin,
      skinShade,
      skinLight,
      hair,
      hairShade,
      hairLight,
      clothes,
      clothesDark: bare ? skinShade : mixColor(clothes, "#17121a", 0.42),
      clothesLight: bare ? skinLight : mixColor(clothes, "#ffe0ae", 0.22),
      clothesTrim: bare ? skinLight : mixColor(clothes, "#f6e7cf", 0.32),
      pants: bare ? skin : mixColor(clothes, "#241b1c", 0.55),
      pantsShade: bare ? skinShade : mixColor(clothes, "#100d0d", 0.72),
      shoe: bare ? skinShade : mixColor(clothes, "#0c0909", 0.84),
      armBackSleeve: bare ? skinShade : mixColor(clothes, "#0b090c", 0.18),
      // Słowiański haft: czerwona nić na lnianym tle.
      folkThread: mixColor(clothes, "#a83a2c", 0.74),
      folkThreadDark: mixColor(clothes, "#5a1c14", 0.62),
      linen: mixColor(clothes, "#efe4cc", 0.58),
      sash: mixColor(clothes, "#7c2f26", 0.68),
    };
    person._paletteCache = p;
    return p;
  }

  _drawPerson(ctx, person, game) {
    if (person.state === "pray") {
      // Dopóki pielgrzym idzie do monolitu, rysujemy go jak normalnego
      // człowieka. Klęka dopiero na swoim miejscu w półkolu.
      const site =
        person.monolithSiteId != null
          ? game.monoliths?.byId?.get(person.monolithSiteId)
          : null;
      const slotX = site ? site.x + (person.prayOffsetX || 0) : null;
      const arrived =
        slotX != null &&
        Math.abs(person.x - slotX) < game.map.tileSize * 0.78;
      if (arrived) {
        this._drawPrayingPerson(ctx, person, game);
        return;
      }
    }
    if (person.state === "sleep") {
      if (person.sleepIndoors) return;
      this._drawSleeper(ctx, person, game);
      return;
    }
    if (person.panicTimer > 0) this._drawLushMotes(ctx, person);

    const h = person.h;
    const w = person.w;
    const scale = h / game.config.agents.height;
    const detail = h * (game.camera?.zoom ?? 1);
    const climbing = person.state === "climb";
    const moving = climbing || Math.abs(person.vx) > 2.5;
    const phase = climbing ? this.time * 14 + person.id : person.walkTime * 8.5;
    const isDrowning = person.state === "drown";
    const bob = isDrowning
      ? Math.sin(this.time * 11 + person.id) * 1.6
      : moving
        ? Math.abs(Math.sin(phase)) * -1.1 * scale
        : 0;
    const feetY = person.y + bob;
    const cx = person.x;
    const facing = person.facing;
    const swimming = person.inWater || isDrowning;
    const isFemale = person.sex === "f";
    const isChild = person.ageYears < person.config.childAge;
    const old = ageGroup(person.ageYears, game.config.agents) === "elder";
    const adultSwim = person.ageYears >= (person.config.swimwearAdultAge ?? 18);
    const swimPalette = game.config.theme.swimwear || [
      "#ff5d8f",
      "#ffd166",
      "#45c4d6",
      "#7ee081",
      "#ff8a5c",
      "#b28dff",
    ];
    const swimColor = swimPalette[person.id % swimPalette.length];
    const swimKind = isFemale
      ? adultSwim
        ? "bikini"
        : "onepiece"
      : adultSwim
        ? "briefs"
        : "trunks";

    // Wspólna paleta postaci: każdy kolor pochodzi z palety płci/ubrania,
    // a cienie i światła są z niego wyprowadzane, żeby ludzie grali ze sobą.
    // Paleta zmienia się tylko przy przebraniu/rozbraniu, więc trzymamy ją
    // w cache na obiekcie osoby zamiast liczyć kilkanaście mixColor na klatkę.
    const bare = !!person.stripped && !swimming;
    const palette = this._personPalette(person, swimming, bare, old);
    const skin = palette.skin;
    const skinShade = palette.skinShade;
    const skinLight = palette.skinLight;
    const hair = palette.hair;
    const hairShade = palette.hairShade;
    const hairLight = palette.hairLight;
    const clothes = palette.clothes;
    const clothesDark = palette.clothesDark;
    const clothesLight = palette.clothesLight;
    const clothesTrim = palette.clothesTrim;
    const folkThread = palette.folkThread;
    const folkThreadDark = palette.folkThreadDark;
    const linen = palette.linen;
    const sash = palette.sash;
    const pants = palette.pants;
    const pantsShade = palette.pantsShade;
    const shoe = palette.shoe;
    const dress = !swimming && !bare && isFemale && person.ageYears > 3;

    // Cień pod stopami: gotowy sprite zamiast gradientu tworzonego
    // co klatkę dla każdej osoby.
    if (!isDrowning) {
      if (!this.personShadow) this._buildPersonShadow();
      const shadowW = w * 1.9;
      const shadowH = 3.4 * scale;
      ctx.drawImage(
        this.personShadow,
        cx - shadowW,
        person.y + 0.5 - shadowH,
        shadowW * 2,
        shadowH * 2
      );
    }

    // Daleki plan: przy bardzo małej postaci pełny rysunek twarzy, ubrań
    // i cieni i tak jest nieczytelny, a generuje większość kosztu.
    if (detail < 18) {
      this._drawPersonLOD(ctx, person, palette, {
        cx,
        feetY,
        w,
        h,
        scale,
        facing,
        isFemale,
        isChild,
        swimming,
        dress,
        moving,
        phase,
        isDrowning,
        swimColor,
      });
      return;
    }

    const legSwing = moving ? Math.sin(phase) * 3.4 * scale : 0;
    const armSwing = moving ? Math.sin(phase + Math.PI) * 3.6 * scale : 0;
    const hipY = feetY - h * 0.44;
    const waistY = feetY - h * 0.585;
    const shoulderY = feetY - h * 0.77;
    const chestY = shoulderY + h * 0.075;
    const headR = Math.max(2.1, h * 0.145);
    const headY = feetY - h * 0.94;

    // Proporcje sylwetki: kobiety mają węższe ramiona, wciętą talię i
    // szersze biodra; mężczyźni — szerokie ramiona i prosty tors.
    const shoulderW =
      w * (isFemale ? (isChild ? 0.7 : 0.68) : isChild ? 0.8 : 0.9);
    const waistW =
      w * (isFemale ? (isChild ? 0.54 : 0.46) : isChild ? 0.6 : 0.58);
    const hipW =
      w * (isFemale ? (isChild ? 0.68 : 0.86) : isChild ? 0.64 : 0.66);
    const hemY = feetY - h * (dress ? 0.12 : 0.015);
    const skirtW = w * (isChild ? 0.94 : 1.08);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Nogi. Przy sukience odsłaniamy skórę, w spodniach zostaje materiał.
    const legColor = swimming || bare || dress ? skin : pants;
    const legWidth = Math.max(1.45, (isFemale ? 2.1 : 2.65) * scale);
    for (const side of [-1, 1]) {
      const swing = side === 1 ? legSwing : -legSwing;
      const hipX = cx + side * hipW * 0.27;
      const kneeX = cx + side * w * 0.31 + swing * 0.55;
      const ankleX = cx + side * (isFemale ? w * 0.24 : w * 0.27) + swing;
      const footLift =
        moving && !isDrowning
          ? Math.max(0, Math.cos(phase + (side > 0 ? 0 : Math.PI))) * 1.35
          : 0;
      const ankleY = feetY - footLift;

      ctx.strokeStyle = legColor;
      ctx.lineWidth = legWidth;
      ctx.beginPath();
      ctx.moveTo(hipX, hipY + h * 0.015);
      ctx.quadraticCurveTo(kneeX, feetY - h * 0.24, ankleX, ankleY - h * 0.012);
      ctx.stroke();

      // Cień z tyłu nogawki, tylko przy większym zbliżeniu.
      if (!swimming && !dress && detail > 22) {
        ctx.strokeStyle = rgba(pantsShade, 0.4);
        ctx.lineWidth = Math.max(0.45, 0.55 * scale);
        ctx.beginPath();
        ctx.moveTo(hipX - side * w * 0.05, hipY + h * 0.04);
        ctx.quadraticCurveTo(
          kneeX - side * w * 0.05,
          feetY - h * 0.3,
          ankleX - side * w * 0.04,
          ankleY - h * 0.05
        );
        ctx.stroke();
      }

      if (!swimming && !bare) {
        // But.
        ctx.fillStyle = shoe;
        ctx.beginPath();
        ctx.ellipse(
          ankleX + facing * w * 0.055,
          ankleY - 0.2,
          w * 0.135,
          Math.max(0.75, 1.05 * scale),
          0,
          0,
          TAU
        );
        ctx.fill();
      }
    }

    const armSleeve = swimming || bare ? skin : clothes;
    const armBackSleeve = swimming || bare ? skinShade : palette.armBackSleeve;

    const drawArm = (side, back) => {
      const swing = side === 1 ? armSwing : -armSwing;
      const shoulderX = cx + side * shoulderW * 0.47;
      let elbowX = cx + side * shoulderW * 0.64;
      let elbowY = shoulderY + h * 0.105 + swing * 0.35;
      let handX = cx + side * shoulderW * 0.66;
      let handY = shoulderY + h * 0.2 + swing * 0.72;

      if (isDrowning) {
        const wiggle = Math.sin(this.time * 8 + person.id + side) * 1.1;
        elbowX = cx + side * shoulderW * 0.67;
        elbowY = shoulderY - h * 0.035 + wiggle * 0.35;
        handX = cx + side * shoulderW * 0.79;
        handY = shoulderY - h * 0.145 + wiggle;
      }

      const sleeve = back ? armBackSleeve : armSleeve;
      const armSkin = back ? skinShade : skin;

      // Rękaw lub goła ręka.
      ctx.strokeStyle = sleeve;
      ctx.lineWidth = Math.max(1.3, (back ? 2.15 : 2.35) * scale);
      ctx.beginPath();
      ctx.moveTo(shoulderX, shoulderY + h * 0.012);
      ctx.quadraticCurveTo(
        elbowX,
        shoulderY + h * 0.05 + swing * 0.15,
        elbowX,
        elbowY
      );
      ctx.stroke();

      // Przedramię i dłoń.
      ctx.strokeStyle = armSkin;
      ctx.lineWidth = Math.max(1.05, 1.95 * scale);
      ctx.beginPath();
      ctx.moveTo(elbowX, elbowY);
      ctx.quadraticCurveTo(
        (elbowX + handX) / 2 + side * 0.4,
        (elbowY + handY) / 2,
        handX,
        handY
      );
      ctx.stroke();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(handX, handY, Math.max(0.85, 1.2 * scale), 0, TAU);
      ctx.fill();

      // Haftowany mankiet przy końcu rękawa.
      if (!swimming && !bare && detail > 18) {
        ctx.fillStyle = rgba(folkThread, 0.9);
        ctx.beginPath();
        ctx.ellipse(
          elbowX,
          elbowY - h * 0.004,
          Math.max(1.1, w * 0.075),
          Math.max(0.7, h * 0.014),
          back ? 0.1 : -0.1,
          0,
          TAU
        );
        ctx.fill();
        ctx.fillStyle = rgba(linen, 0.75);
        ctx.beginPath();
        ctx.ellipse(
          elbowX,
          elbowY - h * 0.004,
          Math.max(0.5, w * 0.032),
          Math.max(0.35, h * 0.006),
          0,
          0,
          TAU
        );
        ctx.fill();
      }

      // Zaokrąglony karczek rękawa maskuje łączenie z torsem.
      ctx.fillStyle = sleeve;
      ctx.beginPath();
      ctx.arc(
        shoulderX,
        shoulderY + h * 0.012,
        Math.max(1.05, (back ? 1.1 : 1.25) * scale),
        0,
        TAU
      );
      ctx.fill();
    };

    // Tylna ręka chowa się za torsem.
    drawArm(-facing, true);

    // Szyja jest rysowana przed torsem, żeby jego góra naturalnie ją zasłaniała.
    ctx.fillStyle = skinShade;
    ctx.fillRect(
      cx - w * 0.105,
      shoulderY - h * 0.02,
      w * 0.21,
      h * 0.105
    );

    // Długie włosy za głową, ramionami i torsem.
    if (isFemale && person.ageYears > 3) {
      ctx.fillStyle = hairShade;
      ctx.beginPath();
      ctx.ellipse(
        cx - facing * headR * 0.18,
        headY + headR * (isChild ? 0.55 : 0.65),
        headR * 0.98,
        headR * (isChild ? 0.95 : 1.32),
        0,
        0,
        TAU
      );
      ctx.fill();
      if (detail > 20) {
        ctx.strokeStyle = rgba(hairLight, 0.28);
        ctx.lineWidth = Math.max(0.35, 0.32 * scale);
        for (const off of [-0.55, 0.1]) {
          ctx.beginPath();
          ctx.moveTo(
            cx - facing * headR * 0.2 + off * headR,
            headY + headR * 0.1
          );
          ctx.quadraticCurveTo(
            cx - facing * headR * 0.5 + off * headR,
            headY + headR * 0.9,
            cx - facing * headR * 0.3 + off * headR,
            headY + headR * (isChild ? 1.0 : 1.45)
          );
          ctx.stroke();
        }
      }
    }

    // Tors, sukienka lub tunika.
    const torso = new Path2D();
    torso.moveTo(cx - shoulderW / 2, shoulderY);
    torso.quadraticCurveTo(
      cx - shoulderW * 0.55,
      chestY,
      cx - waistW / 2,
      waistY
    );
    torso.quadraticCurveTo(
      cx - waistW * 0.62,
      hipY - h * 0.018,
      cx - hipW / 2,
      hipY
    );
    if (dress) {
      torso.lineTo(cx - skirtW / 2, hemY);
      torso.quadraticCurveTo(cx, hemY + h * 0.045, cx + skirtW / 2, hemY);
      torso.lineTo(cx + hipW / 2, hipY);
    } else {
      torso.quadraticCurveTo(cx, hipY + h * 0.018, cx + hipW / 2, hipY);
    }
    torso.quadraticCurveTo(
      cx + waistW * 0.62,
      hipY - h * 0.018,
      cx + waistW / 2,
      waistY
    );
    torso.quadraticCurveTo(
      cx + shoulderW * 0.55,
      chestY,
      cx + shoulderW / 2,
      shoulderY
    );
    torso.quadraticCurveTo(
      cx,
      shoulderY - h * 0.018,
      cx - shoulderW / 2,
      shoulderY
    );
    torso.closePath();

    ctx.fillStyle = swimming ? skin : clothes;
    ctx.fill(torso);

    // Miękkie cieniowanie bryły wewnątrz sylwetki.
    ctx.save();
    ctx.clip(torso);
    ctx.fillStyle = swimming
      ? rgba(skinShade, 0.24)
      : rgba(clothesDark, 0.24);
    ctx.beginPath();
    ctx.ellipse(
      cx - facing * shoulderW * 0.28,
      chestY + h * 0.035,
      waistW * 0.78,
      h * 0.19,
      0,
      0,
      TAU
    );
    ctx.fill();
    ctx.fillStyle = swimming
      ? rgba(skinLight, 0.28)
      : rgba(clothesLight, 0.12);
    ctx.beginPath();
    ctx.ellipse(
      cx + facing * shoulderW * 0.22,
      shoulderY + h * 0.14,
      waistW * 0.48,
      h * 0.15,
      0,
      0,
      TAU
    );
    ctx.fill();
    if (dress) {
      ctx.fillStyle = rgba(clothesDark, 0.14);
      ctx.beginPath();
      ctx.ellipse(cx, hemY, skirtW * 0.48, h * 0.04, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Zapaska — lniany fartuch z czerwonym haftem na sukience.
    if (dress && !bare) {
      const apronTop = waistY + h * 0.008;
      const apronHem = hemY - h * 0.006;
      const apronTopW = waistW * 0.76;
      const apronHemW = skirtW * 0.68;
      const apronGrad = ctx.createLinearGradient(0, apronTop, 0, apronHem);
      apronGrad.addColorStop(0, mixColor(linen, clothes, 0.28));
      apronGrad.addColorStop(0.6, linen);
      apronGrad.addColorStop(1, mixColor(linen, clothesDark, 0.2));
      ctx.fillStyle = apronGrad;
      ctx.beginPath();
      ctx.moveTo(cx - apronTopW * 0.5, apronTop);
      ctx.quadraticCurveTo(
        cx - apronTopW * 0.56,
        (apronTop + apronHem) * 0.5,
        cx - apronHemW * 0.5,
        apronHem
      );
      ctx.quadraticCurveTo(
        cx,
        apronHem + h * 0.022,
        cx + apronHemW * 0.5,
        apronHem
      );
      ctx.quadraticCurveTo(
        cx + apronTopW * 0.56,
        (apronTop + apronHem) * 0.5,
        cx + apronTopW * 0.5,
        apronTop
      );
      ctx.quadraticCurveTo(cx, apronTop + h * 0.012, cx - apronTopW * 0.5, apronTop);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba(folkThread, 0.62);
      ctx.lineWidth = Math.max(0.45, 0.5 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - apronHemW * 0.44, apronHem - h * 0.018);
      ctx.quadraticCurveTo(
        cx,
        apronHem + h * 0.004,
        cx + apronHemW * 0.44,
        apronHem - h * 0.018
      );
      ctx.stroke();
      if (detail > 18) {
        // Geometryczny haft: romby i krzyżyki.
        ctx.strokeStyle = rgba(folkThread, 0.7);
        ctx.lineWidth = Math.max(0.35, 0.4 * scale);
        const rowY = apronTop + (apronHem - apronTop) * 0.34;
        for (let i = -1; i <= 1; i++) {
          const gx = cx + i * apronTopW * 0.24;
          const gr = Math.max(0.7, w * 0.045);
          ctx.beginPath();
          ctx.moveTo(gx, rowY - gr);
          ctx.lineTo(gx + gr, rowY);
          ctx.lineTo(gx, rowY + gr);
          ctx.lineTo(gx - gr, rowY);
          ctx.closePath();
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(cx - apronTopW * 0.3, rowY + h * 0.035);
        ctx.lineTo(cx + apronTopW * 0.3, rowY + h * 0.035);
        ctx.stroke();
      }
    }

    // Odsłonięta szyja i dekolt.
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(
      cx,
      shoulderY + h * 0.012,
      w * (isFemale ? 0.135 : 0.105),
      h * (isFemale ? 0.033 : 0.027),
      0,
      0,
      TAU
    );
    ctx.fill();
    if (!swimming && !bare) {
      const collarY = shoulderY + h * (isFemale ? 0.012 : 0.02);
      const collarW = w * (isFemale ? 0.14 : 0.11);
      ctx.strokeStyle = clothesTrim;
      ctx.lineWidth = Math.max(0.45, 0.55 * scale);
      ctx.beginPath();
      ctx.arc(cx, collarY, collarW, 0.12 * Math.PI, 0.88 * Math.PI);
      ctx.stroke();
      // Czerwona nić haftu przy kołnierzu.
      ctx.strokeStyle = rgba(folkThread, 0.78);
      ctx.lineWidth = Math.max(0.35, 0.4 * scale);
      ctx.beginPath();
      ctx.arc(cx, collarY + 0.5, collarW * 1.08, 0.22 * Math.PI, 0.78 * Math.PI);
      ctx.stroke();
      if (detail > 20) {
        for (const side of [-1, 1]) {
          const ex = cx + side * collarW * 0.78;
          const ey = collarY + h * 0.035;
          ctx.beginPath();
          ctx.moveTo(ex - w * 0.025, ey - h * 0.008);
          ctx.lineTo(ex + w * 0.025, ey + h * 0.008);
          ctx.moveTo(ex + w * 0.025, ey - h * 0.008);
          ctx.lineTo(ex - w * 0.025, ey + h * 0.008);
          ctx.stroke();
        }
      }
    }

    // Delikatny szew pod biustem — czytelny kobiecy akcent także w ubraniu.
    if (isFemale && !isChild) {
      ctx.strokeStyle = rgba(swimming ? skinShade : clothesDark, swimming ? 0.3 : 0.45);
      ctx.lineWidth = Math.max(0.45, 0.5 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.21, chestY + h * 0.02);
      ctx.quadraticCurveTo(
        cx - w * 0.11,
        chestY + h * 0.065,
        cx,
        chestY + h * 0.035
      );
      ctx.quadraticCurveTo(
        cx + w * 0.11,
        chestY + h * 0.065,
        cx + w * 0.21,
        chestY + h * 0.02
      );
      ctx.stroke();
    }

    // Pasek, szarfy i guziki.
    if (isFemale && !swimming && !bare) {
      // Tkana szarfa z czerwonymi pasami.
      const sashY = waistY - h * 0.014;
      ctx.fillStyle = sash;
      ctx.fillRect(cx - waistW * 0.56, sashY, waistW * 1.12, h * 0.032);
      ctx.fillStyle = rgba(folkThread, 0.85);
      ctx.fillRect(cx - waistW * 0.56, sashY + h * 0.007, waistW * 1.12, h * 0.005);
      ctx.fillStyle = rgba(linen, 0.55);
      ctx.fillRect(cx - waistW * 0.56, sashY + h * 0.018, waistW * 1.12, h * 0.0035);
      if (detail > 18) {
        // Węzeł szarfy i dwa zwisające końce.
        const knotX = cx + facing * waistW * 0.1;
        const knotY = waistY;
        ctx.fillStyle = folkThreadDark;
        ctx.beginPath();
        ctx.arc(knotX, knotY, Math.max(0.6, w * 0.028), 0, TAU);
        ctx.fill();
        ctx.strokeStyle = sash;
        ctx.lineWidth = Math.max(0.55, w * 0.03);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(knotX, knotY);
        ctx.quadraticCurveTo(
          knotX - facing * w * 0.06,
          knotY + h * 0.05,
          knotX - facing * w * 0.03,
          knotY + h * 0.09
        );
        ctx.moveTo(knotX, knotY);
        ctx.quadraticCurveTo(
          knotX + facing * w * 0.04,
          knotY + h * 0.045,
          knotX + facing * w * 0.07,
          knotY + h * 0.075
        );
        ctx.stroke();
      }
    } else if (!swimming && !bare) {
      // Męski tkany pas z mosiężną klamrą.
      const beltY = waistY - h * 0.013;
      ctx.fillStyle = sash;
      ctx.fillRect(cx - waistW * 0.55, beltY, waistW * 1.1, h * 0.032);
      ctx.fillStyle = rgba(folkThread, 0.82);
      ctx.fillRect(cx - waistW * 0.55, beltY + h * 0.008, waistW * 1.1, h * 0.0045);
      ctx.fillStyle = rgba(linen, 0.45);
      ctx.fillRect(cx - waistW * 0.55, beltY + h * 0.021, waistW * 1.1, h * 0.003);
      ctx.fillStyle = mixColor(linen, "#b08a3e", 0.4);
      ctx.fillRect(
        cx - w * 0.045,
        waistY - h * 0.011,
        w * 0.09,
        h * 0.028
      );
      if (detail > 17) {
        ctx.fillStyle = folkThreadDark;
        ctx.fillRect(
          cx - w * 0.018,
          waistY - h * 0.004,
          w * 0.036,
          h * 0.014
        );
      }
    }

    // Zapięcie tuniki i guziki.
    if (!isFemale && !swimming && !bare) {
      ctx.strokeStyle = rgba(clothesDark, 0.35);
      ctx.lineWidth = Math.max(0.4, 0.45 * scale);
      ctx.beginPath();
      ctx.moveTo(cx + facing * w * 0.02, shoulderY + h * 0.07);
      ctx.quadraticCurveTo(cx, chestY + h * 0.05, cx, waistY - h * 0.03);
      ctx.stroke();
      if (detail > 20) {
        ctx.fillStyle = clothesTrim;
        for (const t of [0.28, 0.46]) {
          ctx.beginPath();
          ctx.arc(
            cx + facing * w * 0.015,
            shoulderY + h * (0.07 + t * 0.18),
            Math.max(0.35, 0.35 * scale),
            0,
            TAU
          );
          ctx.fill();
        }
      }
    }

    // Fałdy spódnicy.
    if (dress) {
      ctx.strokeStyle = rgba(clothesDark, 0.26);
      ctx.lineWidth = Math.max(0.4, 0.5 * scale);
      for (const off of [-0.42, 0.02, 0.44]) {
        ctx.beginPath();
        ctx.moveTo(cx + off * waistW * 0.8, waistY + h * 0.035);
        ctx.quadraticCurveTo(
          cx + off * skirtW * 0.62,
          hemY - h * 0.09,
          cx + off * skirtW * 0.66,
          hemY - h * 0.012
        );
        ctx.stroke();
      }
      // Haftowana krajka u dołu spódnicy.
      ctx.strokeStyle = rgba(folkThread, 0.85);
      ctx.lineWidth = Math.max(0.5, 0.6 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - skirtW * 0.5, hemY - h * 0.012);
      ctx.quadraticCurveTo(
        cx,
        hemY + h * 0.046,
        cx + skirtW * 0.5,
        hemY - h * 0.012
      );
      ctx.stroke();
      ctx.strokeStyle = rgba(clothesTrim, 0.85);
      ctx.lineWidth = Math.max(0.35, 0.4 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - skirtW * 0.5, hemY - h * 0.004);
      ctx.quadraticCurveTo(
        cx,
        hemY + h * 0.052,
        cx + skirtW * 0.5,
        hemY - h * 0.004
      );
      ctx.stroke();
      if (detail > 20) {
        ctx.strokeStyle = rgba(folkThreadDark, 0.7);
        ctx.lineWidth = Math.max(0.35, 0.4 * scale);
        for (let i = -2; i <= 2; i++) {
          const ex = cx + i * skirtW * 0.16;
          const ey = hemY - h * 0.03;
          ctx.beginPath();
          ctx.moveTo(ex - w * 0.025, ey - h * 0.008);
          ctx.lineTo(ex + w * 0.025, ey + h * 0.008);
          ctx.moveTo(ex + w * 0.025, ey - h * 0.008);
          ctx.lineTo(ex - w * 0.025, ey + h * 0.008);
          ctx.stroke();
        }
      }
    }

    // Brzuch w ciąży rysowany przed strojem: bikini układa się na
    // wypukłości, dzięki czemu pozostaje widoczne.
    if (person.isPregnant) {
      ctx.fillStyle = swimming
        ? mixColor(skin, "#d98c7a", 0.1)
        : dress
          ? mixColor(linen, clothes, 0.28)
          : clothes;
      const bellyX = cx + facing * w * 0.24;
      const bellyY = hipY - h * 0.015;
      const bellyRX = w * 0.42;
      const bellyRY = h * 0.155;
      const bellyTilt = -facing * 0.08;
      ctx.beginPath();
      ctx.ellipse(bellyX, bellyY, bellyRX, bellyRY, bellyTilt, 0, TAU);
      ctx.fill();
      if (swimming) {
        ctx.strokeStyle = rgba(skinShade, 0.34);
        ctx.lineWidth = Math.max(0.35, 0.35 * scale);
        ctx.beginPath();
        ctx.ellipse(bellyX, bellyY, bellyRX, bellyRY, bellyTilt, 0, TAU);
        ctx.stroke();
      } else {
        // W ubraniu wystarczy cień pod brzuchem — pełna obwódka
        // wyglądałaby jak naszyta łatka.
        ctx.strokeStyle = rgba(clothesDark, 0.24);
        ctx.lineWidth = Math.max(0.45, 0.55 * scale);
        ctx.beginPath();
        ctx.ellipse(
          bellyX,
          bellyY,
          bellyRX,
          bellyRY,
          bellyTilt,
          0.12 * Math.PI,
          0.88 * Math.PI
        );
        ctx.stroke();
      }
      ctx.fillStyle = swimming
        ? rgba(skinLight, 0.36)
        : rgba(clothesLight, 0.28);
      ctx.beginPath();
      ctx.ellipse(
        cx + facing * w * 0.3,
        hipY - h * 0.06,
        w * 0.17,
        h * 0.065,
        -facing * 0.08,
        0,
        TAU
      );
      ctx.fill();
    }

    // Strój kąpielowy zakładany po wejściu do wody.
    if (swimming) {
      this._drawSwimwear(
        ctx,
        cx,
        shoulderY,
        hipY,
        w,
        h,
        scale,
        swimColor,
        swimKind
      );
    }

    // Delikatna muskulatura i pępek na odkrytym ciele.
    if (swimming) {
      if (!isFemale && !isChild) {
        ctx.strokeStyle = rgba(skinShade, 0.55);
        ctx.lineWidth = Math.max(0.45, 0.45 * scale);
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(cx + side * w * 0.04, chestY - h * 0.005);
          ctx.quadraticCurveTo(
            cx + side * w * 0.17,
            chestY + h * 0.038,
            cx + side * w * 0.27,
            chestY - h * 0.004
          );
          ctx.stroke();
        }
      }
      ctx.fillStyle = rgba(skinShade, 0.75);
      ctx.beginPath();
      ctx.ellipse(
        cx + facing * w * 0.02,
        hipY - h * (person.isPregnant ? 0.105 : 0.085),
        Math.max(0.32, 0.36 * scale),
        Math.max(0.42, 0.48 * scale),
        0,
        0,
        TAU
      );
      ctx.fill();
    }

    // Ucho z tyłu głowy (przed twarzą, żeby tylko jego brzeg wystawał).
    ctx.fillStyle = skinShade;
    ctx.beginPath();
    ctx.arc(
      cx - facing * headR * 0.96,
      headY + headR * 0.08,
      headR * 0.24,
      0,
      TAU
    );
    ctx.fill();

    // Twarz.
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(
      cx + facing * headR * 0.02,
      headY,
      headR * 0.96,
      headR * 1.02,
      0,
      0,
      TAU
    );
    ctx.fill();

    if (detail > 20) {
      ctx.fillStyle = rgba(skinShade, 0.35);
      ctx.beginPath();
      ctx.ellipse(
        cx + facing * headR * 0.25,
        headY + headR * 0.63,
        headR * 0.4,
        headR * 0.16,
        0,
        0,
        TAU
      );
      ctx.fill();
    }

    // Rumieniec wstydu po zerwaniu ubrania.
    if (bare || person.state === "shame") {
      ctx.fillStyle = "rgba(224, 92, 96, 0.5)";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(
          cx + side * headR * 0.42,
          headY + headR * 0.36,
          headR * 0.24,
          headR * 0.12,
          0,
          0,
          TAU
        );
        ctx.fill();
      }
    }

    // Włosy: kobiety mają dłuższą, miękką oprawę, mężczyźni krótki zarost.
    if (isFemale) {
      ctx.fillStyle = hair;
      ctx.beginPath();
      ctx.ellipse(
        cx + facing * headR * 0.02,
        headY - headR * 0.5,
        headR * 1.02,
        headR * 0.64,
        0,
        Math.PI,
        TAU
      );
      ctx.fill();
      // Grzywka zamiatająca się na bok.
      ctx.beginPath();
      ctx.moveTo(cx - facing * headR * 0.95, headY - headR * 0.32);
      ctx.quadraticCurveTo(
        cx - facing * headR * 0.62,
        headY - headR * 0.98,
        cx + facing * headR * 0.16,
        headY - headR * 0.9
      );
      ctx.quadraticCurveTo(
        cx + facing * headR * 0.86,
        headY - headR * 0.76,
        cx + facing * headR * 0.97,
        headY - headR * 0.24
      );
      ctx.quadraticCurveTo(
        cx + facing * headR * 0.16,
        headY - headR * 0.56,
        cx - facing * headR * 0.95,
        headY - headR * 0.32
      );
      ctx.fill();
      // Kosmyk przy uchu.
      ctx.beginPath();
      ctx.ellipse(
        cx - facing * headR * 0.87,
        headY + headR * 0.15,
        headR * 0.23,
        headR * 0.64,
        facing * 0.12,
        0,
        TAU
      );
      ctx.fill();

      // Długi kosmyk opadający na ramię — czytelny sygnał długich włosów
      // nawet wtedy, gdy tors zasłania masę włosów z tyłu.
      const lockX = cx - facing * headR * 1.02;
      ctx.beginPath();
      ctx.moveTo(lockX - headR * 0.18, headY - headR * 0.12);
      ctx.quadraticCurveTo(
        lockX - headR * 0.42,
        headY + headR * 0.85,
        lockX - headR * 0.14,
        headY + headR * (isChild ? 1.05 : 1.55)
      );
      ctx.quadraticCurveTo(
        lockX + headR * 0.12,
        headY + headR * 0.85,
        lockX + headR * 0.08,
        headY - headR * 0.1
      );
      ctx.closePath();
      ctx.fill();

      // Czerwona wstążka we włosach.
      if (detail > 18 && !swimming && !bare) {
        ctx.strokeStyle = rgba(folkThread, 0.9);
        ctx.lineWidth = Math.max(0.5, 0.62 * scale);
        ctx.beginPath();
        ctx.arc(
          cx,
          headY - headR * 0.24,
          headR * 0.92,
          Math.PI * 1.12,
          Math.PI * 1.88
        );
        ctx.stroke();
        const bx = cx - facing * headR * 0.96;
        const by = headY - headR * 0.16;
        ctx.fillStyle = folkThread;
        ctx.beginPath();
        ctx.arc(bx, by, Math.max(0.55, headR * 0.13), 0, TAU);
        ctx.fill();
        ctx.strokeStyle = rgba(folkThread, 0.8);
        ctx.lineWidth = Math.max(0.45, 0.42 * scale);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(
          bx - facing * headR * 0.28,
          by + headR * 0.42,
          bx - facing * headR * 0.18,
          by + headR * 0.72
        );
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(
          bx - facing * headR * 0.5,
          by + headR * 0.32,
          bx - facing * headR * 0.44,
          by + headR * 0.62
        );
        ctx.stroke();
      }
    } else if (old && person.id % 4 === 0) {
      // Starszy mężczyzna z łysiną i pasmami po bokach.
      ctx.fillStyle = hair;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(
          cx + side * headR * 0.78,
          headY - headR * 0.08,
          headR * 0.27,
          headR * 0.46,
          0,
          0,
          TAU
        );
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(
        cx - facing * headR * 0.58,
        headY - headR * 0.12,
        headR * 0.5,
        headR * 0.42,
        0,
        0,
        TAU
      );
      ctx.fill();
    } else {
      ctx.fillStyle = hair;
      ctx.beginPath();
      ctx.ellipse(
        cx,
        headY - headR * 0.42,
        headR * 0.99,
        headR * 0.61,
        0,
        Math.PI * 0.96,
        Math.PI * 2.04
      );
      ctx.fill();
      // Krótki kosmyk nad czołem.
      ctx.beginPath();
      ctx.ellipse(
        cx + facing * headR * 0.62,
        headY - headR * 0.77,
        headR * 0.29,
        headR * 0.21,
        facing * 0.5,
        0,
        TAU
      );
      ctx.fill();
    }

    if (detail > 20) {
      ctx.strokeStyle = rgba(hairLight, 0.55);
      ctx.lineWidth = Math.max(0.35, 0.35 * scale);
      ctx.beginPath();
      ctx.arc(
        cx + facing * headR * 0.04,
        headY - headR * 0.2,
        headR * 0.76,
        Math.PI * 1.1,
        Math.PI * 1.56
      );
      ctx.stroke();
    }

    // Twarz: oczy, brwi, nos i usta.
    if (detail > 15) {
      const eyeY = headY - headR * 0.04;
      const eyeR = Math.max(0.42, headR * 0.085);
      ctx.fillStyle = "#2b211a";
      ctx.beginPath();
      ctx.arc(cx + facing * headR * 0.16, eyeY, eyeR, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + facing * headR * 0.58, eyeY, eyeR * 0.92, 0, TAU);
      ctx.fill();

      if (detail > 24) {
        ctx.strokeStyle = rgba(hairShade, 0.78);
        ctx.lineWidth = Math.max(0.3, 0.3 * scale);
        for (const off of [0.16, 0.58]) {
          const ex = cx + facing * headR * off;
          ctx.beginPath();
          ctx.moveTo(ex - headR * 0.09, eyeY - headR * 0.21);
          ctx.lineTo(ex + headR * 0.09, eyeY - headR * 0.19);
          ctx.stroke();
        }
      }

      if (detail > 20) {
        ctx.fillStyle = rgba(skinShade, 0.8);
        ctx.beginPath();
        ctx.arc(
          cx + facing * headR * 0.88,
          headY + headR * 0.16,
          Math.max(0.28, headR * 0.06),
          0,
          TAU
        );
        ctx.fill();
      }

      if (isFemale && detail > 20) {
        ctx.fillStyle = rgba(mixColor(skin, "#e0736f", 0.35), 0.38);
        ctx.beginPath();
        ctx.ellipse(
          cx + facing * headR * 0.48,
          headY + headR * 0.3,
          headR * 0.2,
          headR * 0.11,
          0,
          0,
          TAU
        );
        ctx.fill();
      }

      const mouthColor = isFemale
        ? mixColor(skin, "#a94442", 0.55)
        : mixColor(skin, "#7a3b32", 0.42);
      ctx.strokeStyle = mouthColor;
      ctx.lineWidth = Math.max(0.4, 0.45 * scale);
      ctx.beginPath();
      ctx.moveTo(cx + facing * headR * 0.28, headY + headR * 0.43);
      ctx.quadraticCurveTo(
        cx + facing * headR * 0.4,
        headY + headR * 0.52,
        cx + facing * headR * 0.54,
        headY + headR * 0.41
      );
      ctx.stroke();

      if (isFemale && !isChild && detail > 22) {
        ctx.fillStyle = "#ffd166";
        ctx.beginPath();
        ctx.arc(
          cx - facing * headR * 0.98,
          headY + headR * 0.3,
          Math.max(0.3, 0.32 * scale),
          0,
          TAU
        );
        ctx.fill();
      }
    }

    // Przednia ręka.
    drawArm(facing, false);

    // Kostur starca.
    if (old && !moving && !isDrowning && !swimming) {
      const staffX = cx + facing * (w * 0.95 + 1.5);
      ctx.strokeStyle = "#6b4a2f";
      ctx.lineWidth = Math.max(0.75, 0.85 * scale);
      ctx.beginPath();
      ctx.moveTo(staffX, feetY - 0.5);
      ctx.quadraticCurveTo(
        staffX + facing * 0.35,
        shoulderY + h * 0.1,
        staffX + facing * 0.8,
        shoulderY + h * 0.035
      );
      ctx.stroke();
      ctx.fillStyle = "#8d6a44";
      ctx.beginPath();
      ctx.arc(
        staffX + facing * 0.88,
        shoulderY + h * 0.028,
        Math.max(0.75, 1.05 * scale),
        0,
        TAU
      );
      ctx.fill();
    }

    // Podświetlenie osoby pod kursorem.
    if (game.hoveredPerson === person) {
      ctx.strokeStyle = "rgba(255, 220, 160, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(cx, feetY + 1.5, w * 1.7, 4.2 * scale, 0, 0, TAU);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawSleeper(ctx, person, game) {
    const h = person.h;
    const w = person.w;
    const scale = h / game.config.agents.height;
    const detail = h * (game.camera?.zoom ?? 1);
    const dir = person.facing || 1;
    const breathe =
      Math.sin(this.time * 1.5 + (person.sleepPhase ?? 0) + person.id) * 0.4;
    const baseY = person.y;
    const isFemale = person.sex === "f";
    const isChild = person.ageYears < person.config.childAge;
    const old = ageGroup(person.ageYears, game.config.agents) === "elder";

    const palette = this._personPalette(person, false, false, old);
    const skin = palette.skin;
    const skinShade = palette.skinShade;
    const hair = palette.hair;
    const hairShade = palette.hairShade;
    const clothes = palette.clothes;
    const clothesDark = palette.clothesDark;
    const clothesTrim = palette.clothesTrim;
    const pants = palette.pants;
    const shoe = palette.shoe;

    const headR = Math.max(2.1, h * 0.145);
    const headX = person.x + dir * h * 0.37;
    const headY = baseY - headR * 0.92 + breathe * 0.2;
    const hipX = person.x - dir * h * 0.08;
    const footX = person.x - dir * h * 0.45;
    const bodyY = baseY - h * 0.12;
    const shoulderX = person.x + dir * h * 0.2;
    const waistX = person.x + dir * h * 0.045;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Cień wydłużony wzdłuż leżącego ciała.
    ctx.fillStyle = "rgba(12, 16, 12, 0.26)";
    ctx.beginPath();
    ctx.ellipse(person.x, baseY + 0.8, h * 0.5, 2.6 * scale, 0, 0, TAU);
    ctx.fill();

    // Daleki plan: wystarczy zarys leżącej sylwetki.
    if (detail < 18) {
      ctx.strokeStyle = clothes;
      ctx.lineWidth = w * (isFemale ? 0.78 : 0.87);
      ctx.beginPath();
      ctx.moveTo(hipX, bodyY + 0.5);
      ctx.quadraticCurveTo(
        (hipX + shoulderX) / 2,
        bodyY - 1.2 - breathe,
        shoulderX,
        bodyY - 0.2
      );
      ctx.stroke();
      ctx.strokeStyle = pants;
      ctx.lineWidth = Math.max(1.3, (isFemale ? 1.95 : 2.3) * scale);
      ctx.beginPath();
      ctx.moveTo(hipX, bodyY);
      ctx.lineTo(footX, baseY - 1.6);
      ctx.stroke();
      if (isFemale && person.ageYears > 3) {
        ctx.fillStyle = hairShade;
        ctx.beginPath();
        ctx.ellipse(headX - dir * headR * 0.5, headY + headR * 0.25, headR * 0.8, headR, 0, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(headX, headY, headR, 0, TAU);
      ctx.fill();
      ctx.fillStyle = hair;
      ctx.beginPath();
      ctx.arc(headX - dir * headR * 0.25, headY - headR * 0.18, headR * 0.8, 0, TAU);
      ctx.fill();
      ctx.restore();
      return;
    }

    // Nogi.
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const offset = side * w * 0.19;
      ctx.strokeStyle = pants;
      ctx.lineWidth = Math.max(1.3, (isFemale ? 1.95 : 2.3) * scale);
      ctx.beginPath();
      ctx.moveTo(hipX, bodyY + offset * 0.36);
      ctx.quadraticCurveTo(
        (hipX + footX) / 2,
        bodyY + offset + 0.9,
        footX,
        baseY - 1.6 + offset * 0.48
      );
      ctx.stroke();

      // But skierowany w stronę przeciwną do głowy.
      ctx.fillStyle = shoe;
      ctx.beginPath();
      ctx.ellipse(
        footX - dir * w * 0.1,
        baseY - 1.4 + offset * 0.48,
        w * 0.14,
        Math.max(0.7, 0.95 * scale),
        0,
        0,
        TAU
      );
      ctx.fill();
    }

    // Tułów ułożony poziomo; materiał delikatnie unosi się przy oddechu.
    ctx.strokeStyle = clothes;
    ctx.lineWidth = w * (isFemale ? 0.78 : 0.87) + breathe * 0.25;
    ctx.beginPath();
    ctx.moveTo(hipX, bodyY + 0.5);
    ctx.quadraticCurveTo(
      (hipX + shoulderX) / 2,
      bodyY - 1.2 - breathe,
      shoulderX,
      bodyY - 0.2
    );
    ctx.stroke();

    // Cień w talii i pasek.
    ctx.strokeStyle = rgba(clothesDark, 0.4);
    ctx.lineWidth = Math.max(0.7, 0.75 * scale);
    ctx.beginPath();
    ctx.moveTo(waistX, bodyY - w * 0.38);
    ctx.lineTo(waistX, bodyY + w * 0.38);
    ctx.stroke();
    ctx.fillStyle = clothesTrim;
    ctx.fillRect(
      waistX - w * 0.04,
      bodyY + w * 0.22,
      w * 0.08,
      w * 0.14
    );

    // Ramię złożone wzdłuż ciała: rękaw, przedramię i dłoń.
    ctx.strokeStyle = clothes;
    ctx.lineWidth = Math.max(1.15, 2.15 * scale);
    ctx.beginPath();
    ctx.moveTo(shoulderX - dir * w * 0.16, bodyY + w * 0.12);
    ctx.quadraticCurveTo(
      person.x + dir * h * 0.03,
      bodyY + w * 0.26,
      hipX + dir * w * 0.08,
      bodyY + w * 0.2
    );
    ctx.stroke();
    ctx.strokeStyle = skin;
    ctx.lineWidth = Math.max(1, 1.8 * scale);
    ctx.beginPath();
    ctx.moveTo(hipX + dir * w * 0.08, bodyY + w * 0.2);
    ctx.lineTo(hipX - dir * w * 0.12, bodyY + w * 0.24);
    ctx.stroke();
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(
      hipX - dir * w * 0.12,
      bodyY + w * 0.24,
      Math.max(0.85, 1.1 * scale),
      0,
      TAU
    );
    ctx.fill();

    // Długie włosy rozłożone za głową.
    if (isFemale && person.ageYears > 3) {
      ctx.fillStyle = hairShade;
      ctx.beginPath();
      ctx.ellipse(
        headX - dir * headR * 0.55,
        headY + headR * 0.35,
        headR * (isChild ? 0.95 : 1.25),
        headR * 0.78,
        dir * 0.16,
        0,
        TAU
      );
      ctx.fill();
    }

    // Szyja łącząca głowę z tułowiem.
    ctx.strokeStyle = skinShade;
    ctx.lineWidth = Math.max(1.2, w * 0.22);
    ctx.beginPath();
    ctx.moveTo(headX - dir * headR * 0.72, headY + headR * 0.16);
    ctx.lineTo(shoulderX, bodyY);
    ctx.stroke();

    // Głowa.
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(headX, headY, headR * 0.98, headR * 1.02, 0, 0, TAU);
    ctx.fill();

    // Ucho.
    ctx.fillStyle = skinShade;
    ctx.beginPath();
    ctx.arc(
      headX - dir * headR * 0.92,
      headY + headR * 0.06,
      headR * 0.22,
      0,
      TAU
    );
    ctx.fill();

    // Włosy na głowie.
    ctx.fillStyle = hair;
    if (isFemale) {
      ctx.beginPath();
      ctx.ellipse(
        headX - dir * headR * 0.22,
        headY - headR * 0.16,
        headR * 1.0,
        headR * 0.88,
        0,
        Math.PI * 0.92,
        Math.PI * 2.08
      );
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(
        headX - dir * headR * 0.84,
        headY + headR * 0.14,
        headR * 0.24,
        headR * 0.62,
        0,
        0,
        TAU
      );
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.ellipse(
        headX - dir * headR * 0.48,
        headY - headR * 0.12,
        headR * 0.9,
        headR * 0.82,
        0,
        0,
        TAU
      );
      ctx.fill();
    }

    // Zamknięte oko i spokojne usta.
    if (detail > 14) {
      const eyeX = headX + dir * headR * 0.42;
      ctx.strokeStyle = "#2b211a";
      ctx.lineWidth = Math.max(0.45, 0.48 * scale);
      ctx.beginPath();
      ctx.moveTo(eyeX - headR * 0.18, headY - headR * 0.04);
      ctx.quadraticCurveTo(
        eyeX,
        headY + headR * 0.06,
        eyeX + headR * 0.18,
        headY - headR * 0.04
      );
      ctx.stroke();
      ctx.strokeStyle = mixColor(skin, "#8a4a40", 0.45);
      ctx.beginPath();
      ctx.moveTo(eyeX - headR * 0.02, headY + headR * 0.4);
      ctx.quadraticCurveTo(
        eyeX + headR * 0.12,
        headY + headR * 0.46,
        eyeX + headR * 0.24,
        headY + headR * 0.38
      );
      ctx.stroke();
    }

    // Delikatne „z” unoszące się nad śpiącym. Rysowane jako trzy linie
    // zamiast fillText — font shaping przy kilkudziesięciu śpiących był
    // jednym z droższych elementów klatki.
    const zAlpha =
      0.16 + 0.16 * (0.5 + 0.5 * Math.sin(this.time * 1.2 + person.id));
    const drift = (this.time * 1.4 + person.id) % 7;
    const zx = headX + dir * headR * 1.5;
    const zy = headY - headR * 2.2 - drift;
    const drawZ = (x, y, size) => {
      const half = size * 0.5;
      ctx.beginPath();
      ctx.moveTo(x - half, y - half);
      ctx.lineTo(x + half, y - half);
      ctx.lineTo(x - half, y + half);
      ctx.lineTo(x + half, y + half);
      ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = "#e6eefa";
    ctx.globalAlpha = zAlpha;
    const zBig = Math.max(5, h * 0.2);
    ctx.lineWidth = Math.max(0.6, zBig * 0.17);
    drawZ(zx, zy, zBig);
    const zSmall = Math.max(4, h * 0.14);
    ctx.lineWidth = Math.max(0.5, zSmall * 0.17);
    drawZ(zx + dir * (2 + drift * 0.35), zy - h * 0.12, zSmall);
    ctx.restore();

    // Podświetlenie osoby pod kursorem.
    if (game.hoveredPerson === person) {
      ctx.strokeStyle = "rgba(255, 220, 160, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(person.x, baseY + 1.5, h * 0.58, 3.2 * scale, 0, 0, TAU);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawPrayingPerson(ctx, person, game) {
    const h = person.h;
    const w = person.w;
    const scale = h / game.config.agents.height;
    const dir = person.facing || 1;
    const palette = this._personPalette(person, false, false, false);
    const { skin, skinShade, skinLight, clothes, clothesDark, clothesLight, pants, hair } =
      palette;

    const cx = person.x;
    const baseY = person.y;
    const seed = person.id * 1.37;
    const t = this.time;
    const breath = 0.5 + 0.5 * Math.sin(t * 2.05 + seed);
    const sway = Math.sin(t * 0.85 + seed * 0.7) * 0.45 * scale;

    // Co kilka sekund głęboki pokłon, z chwilą ciszy przed i po.
    const cycle = (t * 0.125 + hash2(person.id, 3, 11)) % 1;
    const deep =
      smoothstep(0.58, 0.72, cycle) * (1 - smoothstep(0.86, 0.98, cycle));
    const bow = 0.12 + 0.09 * Math.sin(t * 1.3 + seed) + deep * 0.42;

    const hipX = cx - dir * w * 0.05 + sway;
    const hipY = baseY - h * 0.23;
    const kneeX = cx + dir * w * 0.3;
    const kneeY = baseY - h * 0.045;
    const footX = cx - dir * w * 0.5;
    const footY = baseY - 0.4;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Cień klęczącej postaci.
    ctx.fillStyle = "rgba(12, 16, 12, 0.28)";
    ctx.beginPath();
    ctx.ellipse(cx, baseY + 0.8, h * 0.44, 2.9 * scale, 0, 0, TAU);
    ctx.fill();

    // Nogi podkulone pod siebie: udo w stronę kolana, stopa z tyłu.
    ctx.strokeStyle = pants;
    ctx.lineWidth = Math.max(1.6, 2.8 * scale);
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.quadraticCurveTo(cx + dir * w * 0.13, hipY - h * 0.018, kneeX, kneeY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(kneeX, kneeY);
    ctx.quadraticCurveTo(cx - dir * w * 0.16, baseY - h * 0.012, footX, footY);
    ctx.stroke();

    // Kolano i bosa stopa.
    ctx.fillStyle = pants;
    ctx.beginPath();
    ctx.ellipse(kneeX, kneeY, w * 0.23, w * 0.17, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(
      footX,
      footY - 0.2 * scale,
      Math.max(1, w * 0.24),
      Math.max(0.7, 1.15 * scale),
      0,
      0,
      TAU
    );
    ctx.fill();

    // Skrawek tuniki opadający na zgięte nogi.
    const hemY = baseY - h * 0.085;
    ctx.fillStyle = clothes;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.34, hipY - h * 0.035);
    ctx.quadraticCurveTo(
      cx - w * 0.41,
      hemY - h * 0.045,
      cx - w * 0.27 + dir * w * 0.08,
      hemY
    );
    ctx.lineTo(cx + w * 0.3 + dir * w * 0.08, hemY - h * 0.012);
    ctx.quadraticCurveTo(
      cx + w * 0.44,
      hemY - h * 0.07,
      cx + w * 0.32,
      hipY - h * 0.045
    );
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(18, 14, 16, 0.16)";
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.34, hipY - h * 0.035);
    ctx.quadraticCurveTo(
      cx - w * 0.41,
      hemY - h * 0.045,
      cx - w * 0.27 + dir * w * 0.08,
      hemY
    );
    ctx.lineTo(cx - w * 0.06, hemY - h * 0.006);
    ctx.lineTo(cx - w * 0.08, hipY - h * 0.035);
    ctx.closePath();
    ctx.fill();

    // Tors pochylony w stronę monolitu.
    ctx.save();
    ctx.translate(hipX, hipY);
    ctx.rotate(dir * bow);
    ctx.translate(0, -breath * 0.32 * scale);

    const torsoH = h * 0.46;
    const shoulderW = w * 0.38;

    // Tunika z lekkim wybrzuszeniem na plecach.
    ctx.fillStyle = clothes;
    ctx.beginPath();
    ctx.moveTo(-w * 0.3, 0);
    ctx.quadraticCurveTo(-w * 0.36, -torsoH * 0.48, -shoulderW, -torsoH * 0.82);
    ctx.quadraticCurveTo(-w * 0.2, -torsoH * 0.99, 0, -torsoH);
    ctx.quadraticCurveTo(w * 0.3, -torsoH * 0.97, shoulderW, -torsoH * 0.8);
    ctx.quadraticCurveTo(w * 0.38, -torsoH * 0.46, w * 0.3, 0);
    ctx.closePath();
    ctx.fill();

    // Cień pleców i światło na piersi.
    ctx.fillStyle = "rgba(16, 13, 16, 0.18)";
    ctx.beginPath();
    ctx.moveTo(-w * 0.3, 0);
    ctx.quadraticCurveTo(-w * 0.36, -torsoH * 0.48, -shoulderW, -torsoH * 0.82);
    ctx.quadraticCurveTo(-w * 0.2, -torsoH * 0.99, 0, -torsoH);
    ctx.lineTo(0, -torsoH * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255, 239, 205, 0.1)";
    ctx.beginPath();
    ctx.moveTo(0, -torsoH * 0.96);
    ctx.quadraticCurveTo(w * 0.3, -torsoH * 0.93, shoulderW, -torsoH * 0.78);
    ctx.quadraticCurveTo(w * 0.38, -torsoH * 0.44, w * 0.3, 0);
    ctx.lineTo(w * 0.08, -torsoH * 0.05);
    ctx.closePath();
    ctx.fill();

    // Pas i fałdy materiału.
    ctx.strokeStyle = clothesDark;
    ctx.lineWidth = Math.max(0.8, 1.1 * scale);
    ctx.beginPath();
    ctx.moveTo(-w * 0.26, -torsoH * 0.12);
    ctx.quadraticCurveTo(0, -torsoH * 0.06, w * 0.27, -torsoH * 0.13);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 240, 210, 0.08)";
    ctx.lineWidth = Math.max(0.5, 0.65 * scale);
    ctx.beginPath();
    ctx.moveTo(-w * 0.16, -torsoH * 0.3);
    ctx.quadraticCurveTo(-w * 0.05, -torsoH * 0.22, w * 0.08, -torsoH * 0.3);
    ctx.stroke();

    // Dłonie złożone do modlitwy.
    const handX = dir * w * 0.44;
    const handY = -torsoH * 0.5 + deep * torsoH * 0.24;
    const handR = Math.max(1.1, h * 0.052);

    // Tylna ręka (w cieniu).
    ctx.strokeStyle = clothesDark;
    ctx.lineWidth = Math.max(1.1, 1.7 * scale);
    ctx.beginPath();
    ctx.moveTo(-dir * w * 0.13, -torsoH * 0.8);
    ctx.quadraticCurveTo(
      -dir * w * 0.02,
      -torsoH * 0.46,
      handX - dir * handR * 0.45,
      handY + handR * 0.3
    );
    ctx.stroke();

    // Przednia ręka.
    ctx.strokeStyle = clothes;
    ctx.lineWidth = Math.max(1.2, 2 * scale);
    ctx.beginPath();
    ctx.moveTo(dir * w * 0.18, -torsoH * 0.8);
    ctx.quadraticCurveTo(
      dir * w * 0.42,
      -torsoH * 0.6,
      handX,
      handY
    );
    ctx.stroke();
    // Mankiet.
    ctx.strokeStyle = clothesLight;
    ctx.lineWidth = Math.max(0.6, 0.75 * scale);
    ctx.beginPath();
    ctx.moveTo(handX - dir * handR * 0.1, handY - handR * 0.9);
    ctx.lineTo(handX + dir * handR * 0.9, handY - handR * 0.3);
    ctx.stroke();

    // Złożone dłonie.
    ctx.fillStyle = skinShade;
    ctx.beginPath();
    ctx.arc(handX - dir * handR * 0.28, handY + handR * 0.22, handR * 0.8, 0, TAU);
    ctx.fill();
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(handX, handY, handR, 0, TAU);
    ctx.fill();
    ctx.fillStyle = skinLight;
    ctx.beginPath();
    ctx.arc(handX + dir * handR * 0.18, handY - handR * 0.22, handR * 0.52, 0, TAU);
    ctx.fill();

    // Ciepły błysk między dłońmi.
    const handGlow = ctx.createRadialGradient(
      handX,
      handY,
      0.4,
      handX,
      handY,
      Math.max(4, h * 0.22)
    );
    handGlow.addColorStop(0, `rgba(255, 214, 138, ${0.07 + deep * 0.07})`);
    handGlow.addColorStop(1, "rgba(255, 180, 80, 0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = handGlow;
    ctx.beginPath();
    ctx.arc(handX, handY, Math.max(4, h * 0.22), 0, TAU);
    ctx.fill();
    ctx.restore();

    // Głowa opuszczona w skupieniu.
    const headR = Math.max(2.1, h * 0.14);
    const headX = dir * w * 0.14;
    const headY = -torsoH - headR * 0.72 + deep * headR * 0.45;
    ctx.save();
    ctx.translate(headX, headY);
    ctx.rotate(dir * (0.08 + bow * 0.34));

    // Włosy, twarz i grzywka.
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.arc(0, 0, headR, 0, TAU);
    ctx.fill();
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(dir * headR * 0.2, headR * 0.06, headR * 0.84, 0, TAU);
    ctx.fill();
    ctx.fillStyle = skinLight;
    ctx.beginPath();
    ctx.ellipse(
      dir * headR * 0.34,
      -headR * 0.02,
      headR * 0.38,
      headR * 0.5,
      0,
      0,
      TAU
    );
    ctx.fill();
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.ellipse(
      -dir * headR * 0.12,
      -headR * 0.46,
      headR * 0.84,
      headR * 0.5,
      0,
      0,
      TAU
    );
    ctx.fill();

    // Przymknięte oko i nos.
    ctx.strokeStyle = "rgba(52, 36, 28, 0.58)";
    ctx.lineWidth = Math.max(0.45, 0.5 * scale);
    ctx.beginPath();
    ctx.moveTo(dir * headR * 0.36, -headR * 0.06);
    ctx.lineTo(dir * headR * 0.62, -headR * 0.09);
    ctx.stroke();
    ctx.fillStyle = skinShade;
    ctx.beginPath();
    ctx.arc(dir * headR * 0.72, headR * 0.16, headR * 0.15, 0, TAU);
    ctx.fill();

    ctx.restore();
    ctx.restore(); // koniec torsu

    // Delikatne iskry modlitwy unoszące się nad klęczącym.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 2; i++) {
      const cyc = (t * 0.28 + hash2(person.id, i, 7)) % 1;
      const px =
        cx +
        (hash2(person.id, i, 13) * 2 - 1) * w * 0.6 +
        Math.sin(t * 1.1 + i * 2.1) * 1.6;
      const py = baseY - h * 0.45 - cyc * h * 0.55;
      const alpha = Math.sin(Math.PI * cyc) * 0.28;
      ctx.fillStyle = `rgba(255, 218, 148, ${alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, 0.45 + hash2(person.id, i, 17) * 0.55, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Podświetlenie osoby pod kursorem.
    if (game.hoveredPerson === person) {
      ctx.strokeStyle = "rgba(255, 220, 160, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(cx, baseY + 1.5, h * 0.58, 3.2 * scale, 0, 0, TAU);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawSwimwear(ctx, cx, shoulderY, hipY, w, h, scale, color, kind) {
    // Słowiańska bielizna kąpielowa: surowe płótno lniane, czerwona nić
    // i proste kroje — bez połysku współczesnych kostiumów.
    const line = Math.max(0.55, 0.6 * scale);
    const linen = mixColor(color, "#f1e7d2", 0.32);
    const linenShade = mixColor(linen, "#7a6549", 0.28);
    const linenDark = mixColor(linen, "#4c3d2c", 0.42);
    const thread = mixColor(linen, "#a83a2c", 0.82);
    const threadDark = mixColor(linen, "#611f17", 0.7);
    const waistY = shoulderY + (hipY - shoulderY) * 0.56;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = line;

    // Drobny haft krzyżykowy wzdłuż krawędzi płótna.
    const stitchRow = (x0, x1, y, count) => {
      if (scale < 0.55) return;
      ctx.strokeStyle = rgba(thread, 0.9);
      ctx.lineWidth = Math.max(0.3, 0.34 * scale);
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        const sx = x0 + (x1 - x0) * t;
        const s = Math.max(0.45, w * 0.016);
        ctx.beginPath();
        ctx.moveTo(sx - s, y - s);
        ctx.lineTo(sx + s, y + s);
        ctx.moveTo(sx + s, y - s);
        ctx.lineTo(sx - s, y + s);
        ctx.stroke();
      }
    };

    const cloth = (x0, x1) => {
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, linenShade);
      g.addColorStop(0.3, linen);
      g.addColorStop(0.72, mixColor(linen, "#fffaf0", 0.18));
      g.addColorStop(1, linenShade);
      return g;
    };

    if (kind === "bikini") {
      // Góra: lniany bandaż z prostymi ramiączkami.
      const bustY = shoulderY + h * 0.062;
      const bandH = h * 0.09;
      const bandW = w * 0.6;
      ctx.strokeStyle = linenDark;
      ctx.lineWidth = Math.max(0.45, 0.45 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - bandW * 0.4, bustY + h * 0.005);
      ctx.quadraticCurveTo(
        cx - bandW * 0.22,
        shoulderY + h * 0.025,
        cx - bandW * 0.1,
        shoulderY + h * 0.004
      );
      ctx.moveTo(cx + bandW * 0.4, bustY + h * 0.005);
      ctx.quadraticCurveTo(
        cx + bandW * 0.22,
        shoulderY + h * 0.025,
        cx + bandW * 0.1,
        shoulderY + h * 0.004
      );
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - bandW * 0.5, bustY + bandH * 0.08);
      ctx.quadraticCurveTo(
        cx - bandW * 0.52,
        bustY + bandH * 0.72,
        cx - bandW * 0.34,
        bustY + bandH
      );
      ctx.quadraticCurveTo(cx, bustY + bandH * 1.16, cx + bandW * 0.34, bustY + bandH);
      ctx.quadraticCurveTo(
        cx + bandW * 0.52,
        bustY + bandH * 0.72,
        cx + bandW * 0.5,
        bustY + bandH * 0.08
      );
      ctx.quadraticCurveTo(cx, bustY + bandH * 0.16, cx - bandW * 0.5, bustY + bandH * 0.08);
      ctx.closePath();
      ctx.fillStyle = cloth(cx - bandW * 0.5, cx + bandW * 0.5);
      ctx.fill();
      ctx.strokeStyle = linenDark;
      ctx.lineWidth = line;
      ctx.stroke();

      // Zaszewki i fałdy płótna.
      ctx.strokeStyle = rgba(linenShade, 0.55);
      ctx.lineWidth = Math.max(0.35, 0.36 * scale);
      for (const off of [-0.2, 0, 0.2]) {
        ctx.beginPath();
        ctx.moveTo(cx + off * bandW, bustY + bandH * 0.24);
        ctx.lineTo(cx + off * bandW * 0.86, bustY + bandH * 0.88);
        ctx.stroke();
      }
      // Czerwona krajka pod biustem.
      ctx.strokeStyle = thread;
      ctx.lineWidth = Math.max(0.5, 0.52 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - bandW * 0.46, bustY + bandH * 1.02);
      ctx.quadraticCurveTo(cx, bustY + bandH * 1.18, cx + bandW * 0.46, bustY + bandH * 1.02);
      ctx.stroke();
      ctx.strokeStyle = threadDark;
      ctx.lineWidth = Math.max(0.3, 0.32 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - bandW * 0.46, bustY + bandH * 1.06);
      ctx.quadraticCurveTo(cx, bustY + bandH * 1.21, cx + bandW * 0.46, bustY + bandH * 1.06);
      ctx.stroke();
      stitchRow(cx - bandW * 0.32, cx + bandW * 0.32, bustY + bandH * 0.9, 4);

      // Dół: wysokie lniane majtki z troczkiem.
      const topY = hipY - h * 0.04;
      const hemY = hipY + h * 0.085;
      const topHalf = w * 0.41;
      const hipHalf = w * 0.45;
      const hemHalf = w * 0.29;
      ctx.beginPath();
      ctx.moveTo(cx - topHalf, topY);
      ctx.quadraticCurveTo(cx - hipHalf, hipY + h * 0.005, cx - hemHalf, hemY);
      ctx.quadraticCurveTo(cx, hemY + h * 0.04, cx + hemHalf, hemY);
      ctx.quadraticCurveTo(cx + hipHalf, hipY + h * 0.005, cx + topHalf, topY);
      ctx.quadraticCurveTo(cx, topY + h * 0.015, cx - topHalf, topY);
      ctx.closePath();
      ctx.fillStyle = cloth(cx - topHalf, cx + topHalf);
      ctx.fill();
      ctx.strokeStyle = linenDark;
      ctx.lineWidth = line;
      ctx.stroke();
      // Cień w kroku.
      ctx.strokeStyle = rgba(linenShade, 0.5);
      ctx.lineWidth = Math.max(0.35, 0.36 * scale);
      ctx.beginPath();
      ctx.moveTo(cx, topY + h * 0.02);
      ctx.quadraticCurveTo(cx + w * 0.03, hipY + h * 0.01, cx, hemY - h * 0.006);
      ctx.stroke();
      // Sznurek w pasie z węzełkiem.
      ctx.strokeStyle = threadDark;
      ctx.lineWidth = Math.max(0.45, 0.45 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - topHalf * 0.92, topY + h * 0.012);
      ctx.quadraticCurveTo(cx, topY + h * 0.026, cx + topHalf * 0.92, topY + h * 0.012);
      ctx.stroke();
      ctx.strokeStyle = thread;
      ctx.lineWidth = Math.max(0.35, 0.36 * scale);
      ctx.beginPath();
      ctx.moveTo(cx + topHalf * 0.06, topY + h * 0.02);
      ctx.quadraticCurveTo(
        cx + topHalf * 0.2,
        topY + h * 0.055,
        cx + topHalf * 0.12,
        topY + h * 0.085
      );
      ctx.moveTo(cx + topHalf * 0.06, topY + h * 0.02);
      ctx.quadraticCurveTo(
        cx + topHalf * 0.24,
        topY + h * 0.04,
        cx + topHalf * 0.26,
        topY + h * 0.07
      );
      ctx.stroke();
      // Haftowana krajka u dołu.
      ctx.strokeStyle = thread;
      ctx.lineWidth = Math.max(0.45, 0.48 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - hemHalf * 0.92, hemY - h * 0.014);
      ctx.quadraticCurveTo(cx, hemY + h * 0.02, cx + hemHalf * 0.92, hemY - h * 0.014);
      ctx.stroke();
      stitchRow(cx - hemHalf * 0.66, cx + hemHalf * 0.66, hemY - h * 0.03, 4);
    } else if (kind === "onepiece") {
      // Dziewczęca lniana koszulka kąpielowa.
      const topY = shoulderY + h * 0.012;
      const hemY = hipY + h * 0.08;
      ctx.strokeStyle = linenDark;
      ctx.lineWidth = Math.max(0.45, 0.45 * scale);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * w * 0.26, topY + h * 0.04);
        ctx.quadraticCurveTo(
          cx + side * w * 0.16,
          shoulderY + h * 0.008,
          cx + side * w * 0.08,
          shoulderY + h * 0.004
        );
        ctx.stroke();
      }
      const suit = new Path2D();
      suit.moveTo(cx - w * 0.09, topY);
      suit.quadraticCurveTo(cx - w * 0.24, topY + h * 0.03, cx - w * 0.3, shoulderY + h * 0.1);
      suit.quadraticCurveTo(cx - w * 0.26, waistY, cx - w * 0.33, hemY - h * 0.03);
      suit.quadraticCurveTo(cx, hemY + h * 0.03, cx + w * 0.33, hemY - h * 0.03);
      suit.quadraticCurveTo(cx + w * 0.26, waistY, cx + w * 0.3, shoulderY + h * 0.1);
      suit.quadraticCurveTo(cx + w * 0.24, topY + h * 0.03, cx + w * 0.09, topY);
      suit.quadraticCurveTo(cx, topY + h * 0.05, cx - w * 0.09, topY);
      suit.closePath();
      ctx.fillStyle = cloth(cx - w * 0.33, cx + w * 0.33);
      ctx.fill(suit);
      ctx.strokeStyle = linenDark;
      ctx.lineWidth = line;
      ctx.stroke(suit);

      ctx.save();
      ctx.clip(suit);
      ctx.fillStyle = rgba(linenShade, 0.32);
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.2, shoulderY + h * 0.15, w * 0.13, h * 0.1, 0, 0, TAU);
      ctx.fill();
      ctx.restore();

      // Czerwone obszycie dekoltu i nogawek.
      ctx.strokeStyle = thread;
      ctx.lineWidth = Math.max(0.45, 0.48 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.09, topY);
      ctx.quadraticCurveTo(cx, topY + h * 0.05, cx + w * 0.09, topY);
      ctx.stroke();
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * w * 0.3, hipY - h * 0.01);
        ctx.quadraticCurveTo(
          cx + side * w * 0.25,
          hipY + h * 0.05,
          cx + side * w * 0.07,
          hipY + h * 0.078
        );
        ctx.stroke();
      }
      stitchRow(cx - w * 0.16, cx + w * 0.16, shoulderY + h * 0.19, 3);
      // Haftowany pas w talii.
      ctx.strokeStyle = rgba(thread, 0.8);
      ctx.lineWidth = Math.max(0.4, 0.42 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.24, waistY);
      ctx.quadraticCurveTo(cx, waistY + h * 0.016, cx + w * 0.24, waistY);
      ctx.stroke();
    } else {
      // Chłopięce i męskie lniane kąpielówki.
      const long = kind === "trunks";
      const topY = hipY - h * 0.028;
      const hem = hipY + h * (long ? 0.155 : 0.075);
      const topHalf = w * 0.4;
      const hipHalf = w * 0.45;
      const hemHalf = w * (long ? 0.39 : 0.3);
      ctx.beginPath();
      ctx.moveTo(cx - topHalf, topY);
      ctx.lineTo(cx + topHalf, topY);
      ctx.quadraticCurveTo(cx + hipHalf, hipY + h * 0.012, cx + hemHalf, hem);
      if (long) {
        ctx.quadraticCurveTo(cx + w * 0.2, hem + h * 0.016, cx + w * 0.03, hem - h * 0.004);
        ctx.quadraticCurveTo(cx, hem - h * 0.014, cx - w * 0.03, hem - h * 0.004);
        ctx.quadraticCurveTo(cx - w * 0.2, hem + h * 0.016, cx - hemHalf, hem);
      } else {
        ctx.quadraticCurveTo(cx + w * 0.1, hem + h * 0.024, cx, hem + h * 0.03);
        ctx.quadraticCurveTo(cx - w * 0.1, hem + h * 0.024, cx - hemHalf, hem);
      }
      ctx.quadraticCurveTo(cx - hipHalf, hipY + h * 0.012, cx - topHalf, topY);
      ctx.closePath();
      ctx.fillStyle = cloth(cx - topHalf, cx + topHalf);
      ctx.fill();
      ctx.strokeStyle = linenDark;
      ctx.lineWidth = line;
      ctx.stroke();

      // Miękki cień z przodu.
      ctx.strokeStyle = rgba(linenShade, 0.45);
      ctx.lineWidth = Math.max(0.35, 0.36 * scale);
      ctx.beginPath();
      ctx.moveTo(cx, topY + h * 0.03);
      ctx.quadraticCurveTo(cx + w * 0.04, hipY + h * 0.02, cx, hem - h * 0.006);
      ctx.stroke();

      // Sznurek w pasie.
      ctx.strokeStyle = threadDark;
      ctx.lineWidth = Math.max(0.45, 0.45 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - topHalf * 0.92, topY + h * 0.012);
      ctx.quadraticCurveTo(cx, topY + h * 0.026, cx + topHalf * 0.92, topY + h * 0.012);
      ctx.stroke();
      ctx.strokeStyle = thread;
      ctx.lineWidth = Math.max(0.3, 0.34 * scale);
      ctx.beginPath();
      ctx.moveTo(cx + topHalf * 0.08, topY + h * 0.018);
      ctx.quadraticCurveTo(
        cx + topHalf * 0.2,
        topY + h * 0.045,
        cx + topHalf * 0.12,
        topY + h * 0.072
      );
      ctx.moveTo(cx + topHalf * 0.08, topY + h * 0.018);
      ctx.quadraticCurveTo(
        cx + topHalf * 0.24,
        topY + h * 0.034,
        cx + topHalf * 0.26,
        topY + h * 0.062
      );
      ctx.stroke();

      // Czerwone obszycie nogawek.
      ctx.strokeStyle = rgba(thread, 0.8);
      ctx.lineWidth = Math.max(0.4, 0.42 * scale);
      if (long) {
        ctx.beginPath();
        ctx.moveTo(cx - hemHalf * 0.94, hem - h * 0.008);
        ctx.quadraticCurveTo(cx, hem + h * 0.006, cx + hemHalf * 0.94, hem - h * 0.008);
        ctx.stroke();
        stitchRow(cx - hemHalf * 0.7, cx + hemHalf * 0.7, hem - h * 0.026, 5);
      } else {
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(cx + side * hemHalf * 0.95, hem - h * 0.004);
          ctx.quadraticCurveTo(
            cx + side * w * 0.12,
            hem + h * 0.024,
            cx + side * w * 0.02,
            hem + h * 0.028
          );
          ctx.stroke();
        }
      }
      // Haft przy boku.
      ctx.strokeStyle = rgba(thread, 0.75);
      ctx.lineWidth = Math.max(0.35, 0.38 * scale);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * hipHalf * 0.94, topY + h * 0.03);
        ctx.lineTo(cx + side * hemHalf * 0.93, hem - h * 0.018);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawWater(ctx, view, game, daylight) {
    const map = game.map;
    const water = game.water;
    const ts = map.tileSize;
    const x0 = Math.max(0, Math.floor(view.left / ts));
    const x1 = Math.min(map.width - 1, Math.ceil(view.right / ts));
    const theme = game.config.theme.water;
    const styles =
      this._waterStyles ||
      (this._waterStyles = {
        deepAlpha: rgba(theme.deep, 0.25),
        surfaceFill: rgba(theme.surface, 0.22),
        sparkle: rgba(theme.surface, 0.55),
      });
    const info = this._waterInfo || (this._waterInfo = {});

    ctx.save();
    for (let tx = x0; tx <= x1; tx++) {
      water.columnInfo(tx, info);
      if (info.top == null) continue;
      const top = info.top;
      const x = tx * ts;
      const depth = info.depth;
      if (depth < 1) continue;

      const deep = depth > ts * 1.6;
      ctx.fillStyle = deep ? theme.deep : theme.shallow;
      ctx.fillRect(x, top, ts + 0.6, depth);

      // Głębsze dno.
      if (depth > ts * 2.5) {
        ctx.fillStyle = styles.deepAlpha;
        ctx.fillRect(x, top + depth * 0.55, ts + 0.6, depth * 0.45);
      }

      // Fala na powierzchni.
      const wave = Math.sin(this.time * 1.7 + tx * 0.63) * 1.1;
      ctx.fillStyle = styles.surfaceFill;
      ctx.fillRect(x, top + wave, ts + 0.6, 2.5);
      ctx.strokeStyle = rgba(
        theme.surface,
        0.58 + 0.22 * Math.sin(this.time * 2.3 + tx)
      );
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, top + wave);
      ctx.lineTo(x + ts, top + wave);
      ctx.stroke();

      if (hash2(tx, 4, 12) > 0.72) {
        ctx.fillStyle = styles.sparkle;
        const hx = x + ((tx * 7 + Math.floor(this.time * 6)) % ts);
        ctx.fillRect(hx, top + 4 + Math.sin(this.time * 3 + tx) * 1.2, 4, 1);
      }
    }
    ctx.restore();
  }

  /** Smugi i pył niesione przez podmuch wiatru. */
  _drawWind(ctx, game, view) {
    const wind = game.wind;
    if (!wind || !wind.gusts.length) return;
    const t = this.time;
    for (const gust of wind.gusts) {
      const intensity = gust.intensity;
      if (intensity <= 0.02) continue;
      if (
        gust.x + gust.radius < view.left ||
        gust.x - gust.radius > view.right
      ) {
        continue;
      }
      const r = gust.radius;
      const dir = gust.dir;
      const strength = gust.strength;
      const lines = 5 + strength * 4;
      ctx.save();
      ctx.lineCap = "round";
      for (let i = 0; i < lines; i++) {
        const seed = hash2(i, Math.round(gust.seed), 11);
        const y =
          gust.y -
          6 -
          seed * (24 + strength * 26) -
          Math.sin(t * 2.2 + i * 1.7 + gust.seed) * 6;
        const span = r * (0.4 + seed * 0.55);
        const drift =
          ((t * (58 + strength * 34) * dir + seed * 400) % (r * 1.6)) - r * 0.8;
        const x = gust.x + drift;
        const wobble = Math.sin(t * 5 + i * 2.3 + seed * 9) * 2.4;
        const alpha = intensity * (0.1 + seed * 0.12);
        ctx.strokeStyle = `rgba(232, 240, 232, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 0.7 + seed * 0.9;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(
          x + dir * span * 0.45,
          y + wobble,
          x + dir * span,
          y - 1.5 + wobble
        );
        ctx.stroke();
      }

      // Przy huraganie nad ziemią wisi kurz.
      if (strength >= 3) {
        const dustAlpha = intensity * 0.05;
        const g = ctx.createLinearGradient(
          0,
          gust.y - 42,
          0,
          gust.y + 6
        );
        g.addColorStop(0, "rgba(196, 180, 148, 0)");
        g.addColorStop(1, `rgba(196, 180, 148, ${dustAlpha})`);
        ctx.fillStyle = g;
        ctx.fillRect(gust.x - r, gust.y - 42, r * 2, 48);
      }
      ctx.restore();
    }
  }

  _drawRain(ctx, game, view, daylight) {
    const weather = game.weather;
    if (!weather.clouds.length) return;
    const map = game.map;
    // Deszcz jest wodą: krople i rozbryzgi korzystają z tej samej palety
    // co kałuże i jeziora.
    const waterTheme = game.config.theme.water;

    for (const cloud of weather.clouds) {
      const intensity = cloud.intensity;
      if (intensity <= 0.01) continue;
      if (cloud.x + cloud.radius < view.left || cloud.x - cloud.radius > view.right) continue;

      const strength = cloud.strength ?? 2;
      const cx = cloud.x;
      const cy = cloud.y;
      const r = cloud.radius;

      // Ciemna chmura; lekki kapuśniak jest jaśniejszy niż oberwanie.
      const cloudColor = mixColor(
        "#4a5568",
        "#20242e",
        0.22 + intensity * (0.22 + strength * 0.09)
      );
      ctx.fillStyle = rgba(cloudColor, 0.88);
      for (let i = 0; i < 6; i++) {
        const ox = (i - 2.5) * r * 0.32;
        const oy = Math.sin(i * 2.1 + cloud.seed) * 7;
        ctx.beginPath();
        ctx.ellipse(cx + ox, cy + oy, r * (0.3 + (i % 3) * 0.06), 20 + (i % 2) * 12, 0, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(150, 170, 190, ${0.1 + intensity * 0.08})`;
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.25, cy - 10, r * 0.45, 12, 0, 0, TAU);
      ctx.fill();

      // Krople.
      const count = Math.floor(
        120 * intensity * (0.45 + strength * 0.22)
      );
      ctx.lineWidth = 1;
      for (let i = 0; i < count; i++) {
        const hx = hash2(i, cloud.seed, 21);
        const hz = hash2(i, cloud.seed, 33);
        const x = cx + (hx * 2 - 1) * r;
        const ground = map.groundYAtWorldX(x);
        const start = cy + 12;
        const travel = 460;
        const fall = (this.time * (380 + hz * 190) + hx * travel) % travel;
        const y = start + fall;
        if (y > ground - 2) continue;
        ctx.strokeStyle = rgba(waterTheme.shallow, 0.4 + hz * 0.42);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 1.1, y + 6 + hz * 5);
        ctx.stroke();
      }

      // Rozbryzgi.
      const splashes = 7 + strength * 3;
      for (let i = 0; i < splashes; i++) {
        const hx = hash2(i, cloud.seed, 55);
        const x = cx + (hx * 2 - 1) * r;
        const ground = map.groundYAtWorldX(x);
        const phase = (this.time * 2.2 + hx * 6) % 1;
        const a = (1 - phase) * intensity * 0.5;
        ctx.strokeStyle = rgba(waterTheme.surface, a);
        ctx.beginPath();
        ctx.ellipse(x, ground - 1, 2 + phase * 5, 1 + phase * 1.5, 0, Math.PI, TAU);
        ctx.stroke();
      }
    }
  }

  _drawEffects(ctx, game, view) {
    const effects = game.effects;

    // Iskry i cząstki.
    for (const p of effects.particles) {
      if (p.x < view.left || p.x > view.right || p.y < view.top || p.y > view.bottom) continue;
      const alpha = clamp(p.life / p.maxLife, 0, 1);
      if (p.type === "bubble") {
        ctx.strokeStyle = rgba(p.color, alpha * 0.8);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.stroke();
      } else if (p.type === "flame") {
        ctx.fillStyle = rgba(p.color, alpha * 0.9);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size * 0.55, p.size * 1.25, 0, 0, TAU);
        ctx.fill();
      } else if (p.type === "smoke") {
        ctx.fillStyle = rgba(p.color, alpha * 0.34);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1.4 - alpha * 0.4), 0, TAU);
        ctx.fill();
      } else if (p.type === "leaf") {
        const flutter = Math.sin(this.time * 12 + p.x * 0.3 + p.y * 0.2);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(flutter * 0.9 + p.vx * 0.02);
        ctx.fillStyle = rgba(p.color, alpha);
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size * 1.35, p.size * 0.6, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = rgba(p.color, alpha);
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }

    // Fale uderzeniowe.
    for (const r of effects.ripples) {
      const alpha = clamp(r.life / r.maxLife, 0, 1);
      ctx.strokeStyle = `rgba(${r.color || "255, 225, 150"}, ${alpha * 0.5})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y - 2, Math.max(1, r.r), Math.max(1, r.r * 0.22), 0, 0, TAU);
      ctx.stroke();
    }

    // Pioruny.
    for (const bolt of effects.bolts) {
      const alpha = clamp(bolt.life / bolt.maxLife, 0, 1);
      const flicker = 0.7 + 0.3 * Math.sin(this.time * 70 + bolt.seed * 10);
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = "rgba(255, 225, 140, 0.95)";
      ctx.shadowBlur = 30;
      ctx.strokeStyle = `rgba(255, 226, 150, ${alpha * 0.28 * flicker})`;
      ctx.lineWidth = 17;
      this._strokeBolt(ctx, bolt);
      ctx.strokeStyle = `rgba(255, 240, 185, ${alpha * 0.5 * flicker})`;
      ctx.lineWidth = 7;
      this._strokeBolt(ctx, bolt);
      ctx.strokeStyle = `rgba(255, 250, 220, ${alpha * 0.92 * flicker})`;
      ctx.lineWidth = 2.6;
      this._strokeBolt(ctx, bolt);
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * flicker})`;
      ctx.lineWidth = 1.1;
      this._strokeBolt(ctx, bolt);
      ctx.restore();

      // Poświata u podstawy.
      const g = ctx.createRadialGradient(bolt.x, bolt.y, 2, bolt.x, bolt.y, bolt.radius * 1.4);
      g.addColorStop(0, `rgba(255, 240, 180, ${alpha * 0.5})`);
      g.addColorStop(1, "rgba(255, 230, 160, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bolt.x, bolt.y, bolt.radius * 1.4, 0, TAU);
      ctx.fill();
    }
  }

  _strokeBolt(ctx, bolt) {
    ctx.beginPath();
    const pts = bolt.points;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    for (const branch of bolt.branches) {
      ctx.moveTo(branch[0].x, branch[0].y);
      for (let i = 1; i < branch.length; i++) ctx.lineTo(branch[i].x, branch[i].y);
    }
    ctx.stroke();
  }

  _drawCursorWorld(ctx, game) {
    const input = game.input;
    if (!input.mouse.inside || !game.canCastNow()) return;
    const power = game.powers.armed;
    if (!power) return;
    const ts = game.map.tileSize;
    const mx = input.mouse.worldX;
    const groundY = game.map.groundYAtWorldX(mx);
    const level = game.powers.getStrength(power);
    const radiusScale =
      1 +
      (level - 1) *
        (power.id === "rain"
          ? power.radiusPerStrength ?? 0.25
          : power.id === "wind"
            ? power.radiusPerStrength ?? 0.34
            : power.id === "earthquake"
              ? power.radiusPerStrength ?? 0.3
              : power.radiusPerStrength ?? 0.35);
    const radius = power.radius * ts * radiusScale;
    const color =
      power.id === "rain"
        ? game.config.theme.water.accent
        : power.color || "#ffe08a";
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);

    ctx.save();
    if (power.id === "rain") {
      ctx.strokeStyle = rgba(color, 0.7);
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(mx, groundY - 240);
      ctx.lineTo(mx, groundY - 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.ellipse(mx, groundY - 1, radius, radius * 0.18, 0, 0, TAU);
      ctx.strokeStyle = rgba(color, 0.5 + pulse * 0.25);
      ctx.stroke();
      ctx.fillStyle = rgba(color, 0.05 + pulse * 0.04);
      ctx.fill();
    } else if (power.id === "lightning") {
      ctx.strokeStyle = rgba(color, 0.75);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(mx, groundY - 1, radius * (0.8 + pulse * 0.15), radius * 0.2, 0, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx, groundY - 32);
      ctx.lineTo(mx, groundY - 10);
      ctx.stroke();
      ctx.fillStyle = rgba(color, 0.9);
      ctx.beginPath();
      ctx.arc(mx, groundY - radius * 0.22, 2.2, 0, TAU);
      ctx.fill();
    } else if (power.id === "earthquake") {
      const wy = input.mouse.worldY;
      ctx.strokeStyle = rgba(color, 0.7);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(mx, wy, radius, radius * 0.35, 0, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx - radius * 0.75, wy);
      ctx.lineTo(mx + radius * 0.75, wy);
      ctx.moveTo(mx, wy - radius * 0.35 * 0.6);
      ctx.lineTo(mx, wy + radius * 0.35 * 0.6);
      ctx.stroke();
      ctx.fillStyle = rgba(color, 0.08 + pulse * 0.05);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawCursorUI(ctx, game) {
    const input = game.input;
    if (!input.mouse.inside || !game.canCastNow()) return;
    const power = game.powers.armed;
    if (!power) return;
    const { x, y } = input.mouse;
    const can = game.powers.canCast(power).ok;
    ctx.save();
    ctx.font = "600 10px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = can ? "rgba(255, 238, 208, 0.8)" : "rgba(255, 130, 110, 0.85)";
    ctx.fillText(
      `${power.name} · ${game.powers.castCost(power)}`,
      x,
      y - 22
    );
    ctx.restore();
  }

  _drawWeatherTint(ctx, game) {
    const cover = game.weather.cover;
    if (cover > 0.01) {
      ctx.fillStyle = `rgba(22, 32, 48, ${cover * 0.22})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  _drawNightTint(ctx, daylight) {
    const dark = 1 - daylight;
    if (dark > 0.02) {
      ctx.fillStyle = `rgba(9, 14, 38, ${dark * 0.42})`;
      ctx.fillRect(0, 0, this.width, this.height);
      const g = ctx.createRadialGradient(
        this.width * 0.5,
        this.height * 0.44,
        20,
        this.width * 0.5,
        this.height * 0.5,
        this.width * 0.7
      );
      g.addColorStop(0, `rgba(255, 190, 120, ${dark * 0.035})`);
      g.addColorStop(1, "rgba(255, 190, 120, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  _drawScreenFlash(ctx, game) {
    if (game.screenFlash > 0.01) {
      const f = game.screenFlash;
      ctx.fillStyle = `rgba(255, 245, 212, ${f * 0.42})`;
      ctx.fillRect(0, 0, this.width, this.height);
      const g = ctx.createRadialGradient(
        this.width * 0.5,
        this.height * 0.4,
        20,
        this.width * 0.5,
        this.height * 0.5,
        this.width * 0.75
      );
      g.addColorStop(0, `rgba(255, 235, 180, ${f * 0.2})`);
      g.addColorStop(1, "rgba(255, 235, 180, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }
}
