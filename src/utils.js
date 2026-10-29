export const TAU = Math.PI * 2;

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const inverseLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (a, b, v) => {
  const t = clamp(inverseLerp(a, b, v), 0, 1);
  return t * t * (3 - 2 * t);
};

export const rand = (min = 0, max = 1) => min + Math.random() * (max - min);
export const randInt = (min, max) => Math.floor(rand(min, max + 1));
export const chance = (p) => Math.random() < p;
export const choice = (list) => list[Math.floor(Math.random() * list.length)];

/** Deterministyczny pseudolosowy hash -> [0, 1). */
export function hash2(x, y, seed = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Kolory są parsowane i składane bardzo często (każda osoba, drzewo i
   warstwa nieba w każdej klatce). Cache i szybkie ścieżki bez RegExp
   zdejmują z tego większość pracy i alokacji. */
const COLOR_CACHE_LIMIT = 2048;
const MIX_CACHE_LIMIT = 4096;
const RGBA_CACHE_LIMIT = 4096;

const colorCache = new Map();
const mixCache = new Map();
const rgbaCache = new Map();
let rgbaCacheCount = 0;

function trimCache(cache, limit, drop) {
  if (cache.size <= limit) return;
  let removed = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    if (++removed >= drop) break;
  }
}

/** Kolor spakowany jako 0xRRGGBB (bez alokacji obiektu). */
function packColor(color) {
  if (typeof color !== "string") return 0;
  const cached = colorCache.get(color);
  if (cached !== undefined) return cached;

  let packed = 0;
  const len = color.length;
  if (len > 0 && color.charCodeAt(0) === 35) {
    // #rgb lub #rrggbb
    if (len === 4) {
      const r = parseInt(color[1], 16);
      const g = parseInt(color[2], 16);
      const b = parseInt(color[3], 16);
      if (r === r && g === g && b === b) {
        packed = ((r * 17) << 16) | ((g * 17) << 8) | (b * 17);
      }
    } else if (len >= 7) {
      const n = parseInt(color.slice(1, 7), 16);
      if (!Number.isNaN(n)) packed = n & 0xffffff;
    }
  } else if (len > 3 && color.charCodeAt(0) === 114 /* r */) {
    // rgb(...) / rgba(...)
    const nums = color.match(/[\d.]+/g);
    if (nums && nums.length >= 3) {
      packed =
        (Math.min(255, Number(nums[0])) << 16) |
        (Math.min(255, Number(nums[1])) << 8) |
        Math.min(255, Number(nums[2]));
    }
  }

  if (colorCache.size >= COLOR_CACHE_LIMIT) {
    trimCache(colorCache, COLOR_CACHE_LIMIT, COLOR_CACHE_LIMIT / 4);
  }
  colorCache.set(color, packed);
  return packed;
}

export function hexToRgb(hex) {
  const packed = packColor(hex);
  return {
    r: (packed >> 16) & 255,
    g: (packed >> 8) & 255,
    b: packed & 255,
  };
}

export function rgba(color, alpha) {
  // Trzy miejsca po przecinku w zupełności wystarczą wizualnie, a pozwalają
  // trafiać w cache przy animowanych wartościach alfa.
  const a = Math.round(alpha * 1000) / 1000;
  let byAlpha = rgbaCache.get(color);
  if (byAlpha === undefined) {
    byAlpha = new Map();
    rgbaCache.set(color, byAlpha);
  } else {
    const hit = byAlpha.get(a);
    if (hit !== undefined) return hit;
  }

  const packed = packColor(color);
  const out = `rgba(${(packed >> 16) & 255}, ${(packed >> 8) & 255}, ${packed & 255}, ${a})`;
  byAlpha.set(a, out);
  if (++rgbaCacheCount >= RGBA_CACHE_LIMIT) {
    rgbaCache.clear();
    rgbaCacheCount = 0;
  }
  return out;
}

export function mixColor(hexA, hexB, t) {
  const a = packColor(hexA);
  const b = packColor(hexB);
  const tq = Math.round(t * 1000) / 1000;
  const key = `${a}|${b}|${tq}`;
  const cached = mixCache.get(key);
  if (cached !== undefined) return cached;

  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const out = `rgb(${Math.round(lerp(ar, (b >> 16) & 255, tq))}, ${Math.round(
    lerp(ag, (b >> 8) & 255, tq)
  )}, ${Math.round(lerp(ab, b & 255, tq))})`;
  if (mixCache.size >= MIX_CACHE_LIMIT) {
    trimCache(mixCache, MIX_CACHE_LIMIT, MIX_CACHE_LIMIT / 4);
  }
  mixCache.set(key, out);
  return out;
}

export function formatHour(hour) {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function pickBy(list, rng = Math.random) {
  return list[Math.floor(rng() * list.length)];
}

export function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function ageGroup(age, agentConfig) {
  if (age < agentConfig.childAge) return "child";
  if (age >= agentConfig.elderAge) return "elder";
  return "adult";
}
