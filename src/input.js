export class Input {
  constructor(game) {
    this.game = game;
    this.canvas = game.canvas;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, worldX: 0, worldY: 0, inside: false };

    // Każdy aktywny wskaźnik (palec lub przycisk myszy) trzymamy osobno.
    // Dzięki temu gest dwupalcowy nie myli się z kliknięciem w planszę.
    this.pointers = new Map();
    this.gesture = null;
    this.dragging = false;
    this.dragButton = -1;
    this._nextPointerOrder = 1;
    this._bind();
  }

  _bind() {
    const canvas = this.canvas;

    this._onPointerDown = (e) => {
      // Prawy i środkowy przycisk myszy zawsze służą do przesuwania mapy.
      const mousePan = e.pointerType === "mouse" && (e.button === 1 || e.button === 2);
      if (e.pointerType === "mouse" && e.button !== 0 && !mousePan) return;

      canvas.setPointerCapture?.(e.pointerId);
      e.preventDefault();

      const pointer = {
        id: e.pointerId,
        order: this._nextPointerOrder++,
        type: e.pointerType || "mouse",
        button: e.button,
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        dragging: mousePan,
        suppressTap: false,
      };
      this.pointers.set(e.pointerId, pointer);

      if (mousePan) {
        this.dragging = true;
        this.dragButton = e.button;
      }

      if (e.pointerType !== "mouse") {
        this.mouse.inside = false;
        this.game.ui.hideTooltip();
      } else {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.mouse.inside = true;
        this.updateWorldMouse();
      }

      // Druga osoba/palec na planszy rozpoczyna szczypanie.
      if (this.pointers.size >= 2) {
        for (const p of this.pointers.values()) {
          p.dragging = false;
          p.suppressTap = true;
        }
        this.dragging = false;
        this._beginPinch();
      }
    };

    this._onPointerMove = (e) => {
      const pointer = this.pointers.get(e.pointerId);
      if (!pointer) {
        // Sam ruch myszy bez wciśniętego przycisku nie jest śledzony
        // jako gest, ale nadal powinien podświetlać ludzi pod kursorem.
        if (e.pointerType === "mouse" || e.pointerType === "pen") {
          this.mouse.x = e.clientX;
          this.mouse.y = e.clientY;
          this.mouse.inside = true;
          this.updateWorldMouse();
          if (!this.dragging) this.game.handleHover(e.clientX, e.clientY);
        }
        return;
      }

      const prevX = pointer.x;
      const prevY = pointer.y;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (e.pointerType === "mouse") {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.mouse.inside = true;
        this.updateWorldMouse();
      }

      if (this.pointers.size >= 2) {
        this._updatePinch();
        return;
      }

      const distFromStart = Math.hypot(
        pointer.x - pointer.startX,
        pointer.y - pointer.startY
      );
      const slop = pointer.type === "mouse" ? 4 : 11;

      if (!pointer.dragging && distFromStart > slop) {
        pointer.dragging = true;
        pointer.suppressTap = true;
        this.dragging = true;
        this.dragButton = pointer.button;
      }

      if (pointer.dragging) {
        const dx = pointer.x - prevX;
        const dy = pointer.y - prevY;
        // Pierwszy ruch po przekroczeniu progu przesuwamy od punktu startu,
        // żeby mapa nie "uciekała" przy zbyt czułym dotyku.
        if (!pointer._panned) {
          pointer._panned = true;
          this.game.camera.panPixels(
            pointer.x - pointer.startX,
            pointer.y - pointer.startY
          );
        } else {
          this.game.camera.panPixels(dx, dy);
        }
      }

      if (e.pointerType === "mouse" && !this.dragging) {
        this.game.handleHover(e.clientX, e.clientY);
      }
    };

    this._onPointerUp = (e) => {
      const pointer = this.pointers.get(e.pointerId);
      if (!pointer) return;

      const wasPinching = !!this.gesture;
      const isTap =
        !pointer.dragging &&
        !pointer.suppressTap &&
        !wasPinching &&
        this.pointers.size === 1;

      this.pointers.delete(e.pointerId);
      canvas.releasePointerCapture?.(e.pointerId);
      this._syncDragState();

      if (this.pointers.size < 2) {
        this.gesture = null;
        // Po zakończeniu szczypania pozostały palec kontynuuje przesuwanie,
        // ale nigdy nie kończy się niechcianym rzuceniem mocy.
        if (this.pointers.size === 1) {
          const rest = this.pointers.values().next().value;
          rest.dragging = true;
          rest.suppressTap = true;
          rest._panned = true;
        }
      }

      if (isTap && (pointer.button === 0 || pointer.type !== "mouse")) {
        // Bez uzbrojonej mocy kliknięcie w planszę nic nie rzuca —
        // domyślnie plansza służy do przesuwania mapy.
        if (this.game.powers.armed) {
          this.game.handleCast(pointer.x, pointer.y);
        }
      }

      if (pointer.type !== "mouse") {
        this.mouse.inside = false;
        this.game.ui.hideTooltip();
      }
    };

    this._onPointerCancel = (e) => {
      this.pointers.delete(e.pointerId);
      canvas.releasePointerCapture?.(e.pointerId);
      if (this.pointers.size < 2) {
        this.gesture = null;
        if (this.pointers.size === 1) {
          const rest = this.pointers.values().next().value;
          rest.dragging = true;
          rest.suppressTap = true;
        }
      }
      this._syncDragState();
    };

    this._onPointerLeave = (e) => {
      if (e.pointerType === "mouse" && this.pointers.size === 0) {
        this.mouse.inside = false;
        this.game.hideTooltip();
      }
    };

    this._onWheel = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.game.camera.zoomAt(e.clientX, e.clientY, factor);
      this.updateWorldMouse();
    };

    this._onContextMenu = (e) => e.preventDefault();

    this._onKeyDown = (e) => {
      const key = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) {
        e.preventDefault();
      }
      if (e.repeat) {
        this.keys.add(key);
        return;
      }
      this.keys.add(key);

      const powers = this.game.powers;
      if (key === "1" || key === "2" || key === "3" || key === "4") {
        const power = powers.list.find((p) => p.key === key);
        if (power) {
          powers.toggleArm(power.id);
          this.game.ui.refreshPowerCards();
        }
      } else if (key === "[" || key === "]") {
        const target = powers.armed || powers.getPower(powers.selectedId);
        if (target) {
          powers.cycleStrength(target.id, key === "]" ? 1 : -1);
          this.game.ui.refreshPowerCards();
          this.game.ui._updatePowerCards?.();
        }
      } else if (key === " ") {
        if (this.game.started) this.game.togglePause();
      } else if (key === "escape") {
        // Esc najpierw rozbraja moc, dopiero potem wstrzymuje grę.
        if (powers.armed) {
          powers.disarm();
          this.game.ui.refreshPowerCards();
        } else if (this.game.started) {
          this.game.togglePause();
        }
      } else if (key === "m") {
        this.game.audio.toggleMute();
        this.game.ui.setMuted(this.game.audio.muted);
      } else if (key === "=" || key === "+") {
        this.game.cycleSpeed(1);
      } else if (key === "-" || key === "_") {
        this.game.cycleSpeed(-1);
      }
    };

    this._onKeyUp = (e) => {
      this.keys.delete(e.key.toLowerCase());
    };

    this._onBlur = () => {
      this.keys.clear();
      this._resetPointers();
    };

    canvas.addEventListener("pointerdown", this._onPointerDown);
    canvas.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
    window.addEventListener("pointercancel", this._onPointerCancel);
    canvas.addEventListener("pointerleave", this._onPointerLeave);
    canvas.addEventListener("wheel", this._onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this._onContextMenu);
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._onBlur);
  }

  _beginPinch() {
    const [a, b] = this._twoPointers();
    if (!a || !b) return;
    this.gesture = {
      dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
    this.dragging = false;
    this.dragButton = -1;
    this.mouse.inside = false;
    this.game.ui.hideTooltip();
  }

  _updatePinch() {
    if (!this.gesture) this._beginPinch();
    const [a, b] = this._twoPointers();
    if (!a || !b || !this.gesture) return;

    const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    // Najpierw przesuwamy mapę o ruch środka gestu, potem zoomujemy wokół
    // nowego środka — dzięki temu szczypanie nie "ciągnie" świata w bok.
    this.game.camera.panPixels(
      midX - this.gesture.midX,
      midY - this.gesture.midY
    );
    const factor = Math.min(2, Math.max(0.5, dist / this.gesture.dist));
    if (Math.abs(factor - 1) > 0.001) {
      this.game.camera.zoomAt(midX, midY, factor);
    }

    this.gesture.dist = dist;
    this.gesture.midX = midX;
    this.gesture.midY = midY;
  }

  _twoPointers() {
    const list = [...this.pointers.values()].sort((a, b) => a.order - b.order);
    return [list[0], list[1]];
  }

  _syncDragState() {
    let anyDragging = false;
    for (const pointer of this.pointers.values()) {
      if (pointer.dragging) anyDragging = true;
    }
    this.dragging = anyDragging || this.pointers.size >= 2;
    if (!this.dragging) this.dragButton = -1;
  }

  _resetPointers() {
    this.pointers.clear();
    this.gesture = null;
    this.dragging = false;
    this.dragButton = -1;
  }

  updateWorldMouse() {
    const p = this.game.camera.screenToWorld(this.mouse.x, this.mouse.y);
    this.mouse.worldX = p.x;
    this.mouse.worldY = p.y;
  }

  update(dt) {
    this.updateWorldMouse();
    const armed = !!this.game.powers.armed;
    const panning = this.pointers.size > 0 && this.dragging;
    this.canvas.classList.toggle("is-armed", armed);
    this.canvas.classList.toggle("is-panning", panning);
  }
}
