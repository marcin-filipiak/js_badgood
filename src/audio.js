/**
 * Minimalny syntezator dźwięku (bez plików). Grzmot, deszcz, plusk i dzwonek
 * narodzin powstają proceduralnie przez WebAudio.
 */
export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.rainGain = null;
    this.rainFilter = null;
    this.noiseBuffer = null;
    this.started = false;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.32;
    this.master.connect(this.ctx.destination);
    this.noiseBuffer = this._makeNoise(2.5);
    this._setupRain();
    this.started = true;
  }

  _makeNoise(seconds) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    return buffer;
  }

  _setupRain() {
    if (!this.ctx || this.rainGain) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1400;
    filter.Q.value = 0.4;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0001;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start();
    this.rainGain = gain;
    this.rainFilter = filter;
  }

  _noise(duration = 1, volume = 0.5, filterType = "lowpass", freq = 300) {
    if (!this.ctx) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(now);
    source.stop(now + duration + 0.05);
  }

  thunder() {
    if (!this.ctx || this.muted) return;
    this._noise(2.4, 0.9, "lowpass", 170);
    this._noise(0.35, 0.5, "highpass", 900);
    setTimeout(() => this._noise(1.2, 0.35, "lowpass", 120), 220);
  }

  quake(level = 1) {
    if (!this.ctx || this.muted) return;
    const strength = (Math.min(3, Math.max(1, level | 0)) / 3);
    this._noise(1.5, 0.28 + strength * 0.12, "lowpass", 60);
    setTimeout(() => this._noise(1.1, 0.2 + strength * 0.1, "lowpass", 90), 100);
    setTimeout(() => this._noise(0.8, 0.16 + strength * 0.06, "lowpass", 45), 260);
  }

  rainBurst() {
    if (!this.ctx || this.muted) return;
    this._noise(1.4, 0.25, "bandpass", 1200);
  }

  windBurst(level = 1) {
    if (!this.ctx || this.muted) return;
    const strength = Math.max(1, Math.min(3, level));
    this._noise(1.1 + strength * 0.5, 0.16 + strength * 0.07, "bandpass", 520);
    setTimeout(
      () => this._noise(0.9 + strength * 0.4, 0.1 + strength * 0.05, "lowpass", 260),
      140
    );
  }

  splash() {
    if (!this.ctx || this.muted) return;
    this._noise(0.5, 0.22, "bandpass", 700);
  }

  fire() {
    if (!this.ctx || this.muted) return;
    this._noise(1.3, 0.3, "bandpass", 480);
    this._noise(0.5, 0.18, "highpass", 1500);
  }

  birth() {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const freqs = [523.25, 659.25, 783.99];
    freqs.forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, now + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.06, now + i * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.7);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.75);
    });
  }

  update(dt, cover) {
    if (!this.ctx || !this.rainGain) return;
    // Automatyzacja Web Audio nie musi być aktualizowana w każdym kroku
    // symulacji (przy 4× to nawet 720 razy na sekundę). Wystarczy kilka Hz.
    this._envTimer = (this._envTimer || 0) - dt;
    if (this._envTimer > 0) return;
    this._envTimer = 0.15;
    const target = this.muted ? 0.0001 : 0.0001 + cover * 0.16;
    const now = this.ctx.currentTime;
    this.rainGain.gain.setTargetAtTime(target, now, 0.4);
    if (this.rainFilter) {
      this.rainFilter.frequency.setTargetAtTime(900 + cover * 900, now, 0.5);
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.32, this.ctx.currentTime, 0.1);
    }
    return this.muted;
  }
}
