/**
 * Siatka terenu. Mapa jest tablicą znaków wczytywaną z maps/world.json.
 * Znaczenie znaków (solidność, wygląd) opisuje config/game.json -> terrain.legend.
 */
export class WorldMap {
  constructor(mapData, config) {
    this.data = mapData;
    this.name = mapData.name || "Bezimienna dolina";
    this.tileSize = mapData.tileSize || config.world.tileSize || 18;
    this.config = config;
    this.legend = config.terrain.legend;

    const rawRows = mapData.rows || [];
    this.width = Math.max(0, ...rawRows.map((r) => r.length));
    const rows = rawRows.map((r) =>
      r.length < this.width ? r.padEnd(this.width, " ") : r
    );

    // Domyślne, głębokie podłoże pod autorską mapą. Nie trzeba go rysować
    // w maps/world.json, a dzięki niemu kamerę można przesunąć w dół —
    // szczególnie na wąskich ekranach telefonów, gdzie mapa jest krótsza
    // niż widok. Górne warstwy to ziemia, głębsze przechodzą w skałę.
    const extraRows = Math.max(
      0,
      Math.floor(config.world.extraGroundRows ?? 40)
    );
    for (let i = 0; i < extraRows; i++) {
      const ch = i < 4 ? "#" : "m";
      rows.push(ch.repeat(this.width));
    }
    this.rows = rows;
    this.height = rows.length;

    this.length = this.width * this.height;
    this.tiles = new Array(this.length);
    this.solid = new Uint8Array(this.length);
    this.waterKind = new Uint8Array(this.length);
    this.surface = new Int16Array(this.width);
    this.waterCellCount = 0;

    for (let y = 0; y < this.height; y++) {
      const row = this.rows[y];
      for (let x = 0; x < this.width; x++) {
        const ch = row[x] || " ";
        const i = y * this.width + x;
        this.tiles[i] = ch;
        const def = this.legend[ch] || this.legend[" "];
        this.solid[i] = def && def.solid ? 1 : 0;
        if (def && def.water) {
          this.waterKind[i] = 1;
          this.waterCellCount++;
        }
      }
    }

    for (let x = 0; x < this.width; x++) {
      let s = this.height - 1;
      for (let y = 0; y < this.height; y++) {
        if (this.solid[y * this.width + x]) {
          s = y;
          break;
        }
      }
      this.surface[x] = s;
    }

    this.pixelWidth = this.width * this.tileSize;
    this.pixelHeight = this.height * this.tileSize;
    this.spawn = mapData.spawn || { x: Math.floor(this.width / 2), radius: 10 };
  }

  inBounds(tx, ty) {
    return tx >= 0 && tx < this.width && ty >= 0 && ty < this.height;
  }

  tileAt(tx, ty) {
    if (!this.inBounds(tx, ty)) return " ";
    return this.tiles[ty * this.width + tx];
  }

  tileDefAt(tx, ty) {
    return this.legend[this.tileAt(tx, ty)] || this.legend[" "];
  }

  isSolidTile(tx, ty) {
    if (tx < 0 || tx >= this.width) return true;
    if (ty < 0) return false;
    if (ty >= this.height) return true;
    return this.solid[ty * this.width + tx] === 1;
  }

  isSolidWorld(px, py) {
    return this.isSolidTile(Math.floor(px / this.tileSize), Math.floor(py / this.tileSize));
  }

  /** Górna krawędź gruntu w danej kolumnie, w pikselach. */
  groundYAtWorldX(px) {
    const tx = Math.floor(px / this.tileSize);
    if (tx < 0 || tx >= this.width) return this.pixelHeight;
    return this.surface[tx] * this.tileSize;
  }

  surfaceRow(tx) {
    if (tx < 0 || tx >= this.width) return this.height - 1;
    return this.surface[tx];
  }

  /** Czy w danej kolumnie nad gruntem stoi woda z mapy? */
  hasAuthoredWater(tx) {
    const s = this.surfaceRow(tx);
    if (s - 1 < 0) return false;
    const i = (s - 1) * this.width + tx;
    return this.waterKind[i] === 1;
  }

  /** Sprawdza, czy prostokąt (AABB) koliduje z terenem. */
  rectCollides(cx, feetY, w, h) {
    const ts = this.tileSize;
    const left = cx - w / 2 + 0.5;
    const right = cx + w / 2 - 0.5;
    const top = feetY - h + 0.5;
    const bottom = feetY - 0.5;
    const x0 = Math.floor(left / ts);
    const x1 = Math.floor(right / ts);
    const y0 = Math.floor(top / ts);
    const y1 = Math.floor(bottom / ts);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (this.isSolidTile(tx, ty)) return true;
      }
    }
    return false;
  }

  /** Ustawia kafelek i aktualizuje solid/woda. Zwraca true, jeśli zmieniono. */
  setTile(tx, ty, ch = " ") {
    if (!this.inBounds(tx, ty)) return false;
    const i = ty * this.width + tx;
    const next = ch || " ";
    if (this.tiles[i] === next) return false;
    this.tiles[i] = next;
    const def = this.legend[next] || this.legend[" "];
    this.solid[i] = def && def.solid ? 1 : 0;
    this.waterKind[i] = 0;
    return true;
  }

  /** Pierwszy (najwyższy) solidny kafelek w kolumnie. */
  firstSolidRow(tx) {
    if (tx < 0 || tx >= this.width) return this.height - 1;
    for (let ty = 0; ty < this.height; ty++) {
      if (this.solid[ty * this.width + tx]) return ty;
    }
    return this.height - 1;
  }

  /** Przelicza surface dla zakresu kolumn po zmianie terenu. */
  recomputeSurface(tx0 = 0, tx1 = this.width - 1) {
    for (let tx = Math.max(0, tx0); tx <= Math.min(this.width - 1, tx1); tx++) {
      this.surface[tx] = this.firstSolidRow(tx);
    }
  }

  /** Zwraca kolumnę kafelków, na której stoi dana pozycja (lub null). */
  findGroundBelow(cx, feetY, maxTiles = 3) {
    const ts = this.tileSize;
    const tx = Math.floor(cx / ts);
    const start = Math.floor(feetY / ts);
    for (let ty = start; ty < Math.min(this.height, start + maxTiles); ty++) {
      if (this.isSolidTile(tx, ty)) return ty;
    }
    return null;
  }

  randomSpawnPoints(x, radius, count, rng = Math.random) {
    const points = [];
    for (let i = 0; i < count * 4 && points.length < count; i++) {
      const tx = Math.round(x + (rng() * 2 - 1) * radius);
      if (tx < 2 || tx >= this.width - 2) continue;
      const ty = this.surfaceRow(tx);
      if (ty <= 0 || ty >= this.height) continue;
      points.push({ x: (tx + 0.5) * this.tileSize, y: ty * this.tileSize, tx, ty });
    }
    return points;
  }
}
