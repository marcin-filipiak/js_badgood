import { clamp } from "./utils.js?v=20261046-1";

export class Camera {
  constructor(game) {
    this.game = game;
    this.config = game.config.world.camera;
    this.cx = 0;
    this.cy = 0;
    this.zoom = this.config.zoom;
    this.viewW = 1280;
    this.viewH = 720;
    this.shakeTime = 0;
    this.shakePower = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }

  init(worldX, worldY) {
    this.cx = worldX;
    this.cy = worldY;
    this.clampToWorld();
  }

  resize(w, h) {
    this.viewW = w;
    this.viewH = h;
    this.clampToWorld();
  }

  shake(power, time) {
    this.shakePower = Math.max(this.shakePower, power);
    this.shakeTime = Math.max(this.shakeTime, time);
  }

  update(dt, keys) {
    let dx = 0;
    let dy = 0;
    if (keys.has("w") || keys.has("arrowup")) dy -= 1;
    if (keys.has("s") || keys.has("arrowdown")) dy += 1;
    if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
    if (keys.has("d") || keys.has("arrowright")) dx += 1;
    if (dx && dy) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    if (dx || dy) {
      const speed = this.config.panSpeed / Math.max(0.6, this.zoom);
      this.cx += dx * speed * dt;
      this.cy += dy * speed * dt;
      this.clampToWorld();
    }

    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      const power = this.shakePower * Math.max(0, this.shakeTime);
      this.shakeX = (Math.random() * 2 - 1) * power * 4;
      this.shakeY = (Math.random() * 2 - 1) * power * 4;
      if (this.shakeTime <= 0) {
        this.shakeX = 0;
        this.shakeY = 0;
        this.shakePower = 0;
      }
    }
  }

  zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY);
    this.zoom = clamp(this.zoom * factor, this.config.minZoom, this.config.maxZoom);
    this.cx = before.x - (screenX - this.viewW / 2) / this.zoom;
    this.cy = before.y - (screenY - this.viewH / 2) / this.zoom;
    this.clampToWorld();
  }

  panPixels(dxScreen, dyScreen) {
    this.cx -= dxScreen / this.zoom;
    this.cy -= dyScreen / this.zoom;
    this.clampToWorld();
  }

  clampToWorld() {
    const map = this.game.map;
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    const minX = Math.min(halfW, map.pixelWidth / 2);
    const maxX = Math.max(map.pixelWidth - halfW, map.pixelWidth / 2);
    const minY = Math.min(halfH, map.pixelHeight / 2);
    const maxY = Math.max(map.pixelHeight - halfH, map.pixelHeight / 2);
    this.cx = clamp(this.cx, minX, maxX);
    this.cy = clamp(this.cy, minY, maxY);
  }

  screenToWorld(sx, sy) {
    return {
      x: this.cx + (sx - this.viewW / 2) / this.zoom,
      y: this.cy + (sy - this.viewH / 2) / this.zoom,
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.cx) * this.zoom + this.viewW / 2,
      y: (wy - this.cy) * this.zoom + this.viewH / 2,
    };
  }

  get offsetX() {
    return this.cx + this.shakeX;
  }

  get offsetY() {
    return this.cy + this.shakeY;
  }
}
