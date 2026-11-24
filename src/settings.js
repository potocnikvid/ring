import { DEFAULT_MILK_PRESET, MILK_PRESETS } from './milkdrop-presets.js';

// Every visual parameter, grouped the way the Tune panel shows them.
// Defaults for the original controls match ring v1.
export const GROUPS = [
  {
    name: 'Shape',
    params: [
      {
        key: 'mode', label: 'Reacts to', type: 'choice', value: 'wave',
        options: [['wave', 'Waveform'], ['spectrum', 'Spectrum']],
      },
      { key: 'ringSize', label: 'Ring size', min: 0.5, max: 2, step: 0.05, value: 1 },
      { key: 'dispersal', label: 'Dispersal', min: 1, max: 3, step: 0.05, value: 1.5 },
      { key: 'pulse', label: 'Bass pulse', min: 0, max: 2, step: 0.05, value: 0.4 },
      { key: 'symmetry', label: 'Symmetry', min: 0, max: 12, step: 1, value: 0 },
      { key: 'twist', label: 'Twist', min: -0.3, max: 0.3, step: 0.01, value: 0 },
    ],
  },
  {
    name: 'Particles',
    params: [
      {
        key: 'shape', label: 'Shape', type: 'choice', value: 'cube',
        options: [['cube', 'Cubes'], ['sphere', 'Spheres'], ['dot', 'Dots']],
      },
      { key: 'particleSize', label: 'Size', min: 1, max: 15, step: 0.5, value: 5 },
      { key: 'sizeVar', label: 'Size variation', min: -1, max: 1, step: 0.05, value: 0 },
      { key: 'detail', label: 'Detail', min: 1, max: 20, step: 1, value: 18 },
      { key: 'outline', label: 'Outline', type: 'toggle', value: true },
    ],
  },
  {
    name: 'Tunnel',
    params: [
      { key: 'length', label: 'Length', min: 1, max: 100, step: 1, value: 10 },
      { key: 'spacing', label: 'Spacing', min: 0, max: 100, step: 1, value: 20 },
      { key: 'fade', label: 'Depth fade', min: 0, max: 1, step: 0.05, value: 0.35 },
      { key: 'trails', label: 'Trails', min: 0, max: 0.95, step: 0.05, value: 0 },
    ],
  },
  {
    name: 'Color',
    params: [
      {
        key: 'colorMode', label: 'Colors', type: 'choice', value: 'hue',
        options: [['hue', 'Rainbow'], ['palette', 'Palette']],
      },
      { key: 'hueRange', label: 'Hue range', min: 0, max: 360, step: 1, value: 90 },
      { key: 'hueSpeed', label: 'Color speed', min: 0, max: 5, step: 0.1, value: 1 },
      { key: 'glow', label: 'Glow', min: 0, max: 2, step: 0.05, value: 0.6 },
    ],
  },
  {
    name: 'MilkDrop',
    params: [
      {
        key: 'milkLayer', label: 'Layer', type: 'choice', value: 'off',
        options: [['off', 'Off'], ['walls', 'Tunnel walls'], ['backdrop', 'Backdrop']],
      },
      { key: 'milkPreset', label: 'Preset', type: 'preset', value: DEFAULT_MILK_PRESET, options: MILK_PRESETS },
      { key: 'milkAmount', label: 'Layer strength', min: 0, max: 1, step: 0.05, value: 0.6 },
      { key: 'milkColors', label: 'Particles take its colours', min: 0, max: 1, step: 0.05, value: 0 },
    ],
  },
  {
    name: 'Camera',
    params: [
      { key: 'beatMotion', label: 'Beat motion', min: 0, max: 1, step: 0.05, value: 0.3 },
      { key: 'autoRotate', label: 'Auto-rotate', min: 0, max: 5, step: 0.1, value: 0 },
    ],
  },
];

// Set by styles rather than sliders: the palette the ring is coloured from
// (in Palette mode) and the background colour.
export const DEFAULT_PALETTE = ['#1b0f3b', '#5b2a86', '#c8457a', '#ff8a4c', '#ffd36e'];
const HIDDEN = [
  { key: 'palette', type: 'palette', value: DEFAULT_PALETTE },
  { key: 'background', type: 'color', value: '#000000' },
];

export const PARAMS = Object.fromEntries([...GROUPS.flatMap((g) => g.params), ...HIDDEN].map((p) => [p.key, p]));
export const DEFAULTS = Object.fromEntries(Object.values(PARAMS).map((p) => [p.key, p.value]));

export const PRESETS = {
  Ring: { ...DEFAULTS },
  Classic: { ...DEFAULTS, pulse: 0, fade: 0, glow: 0, beatMotion: 0 },
  Nebula: {
    ...DEFAULTS, length: 80, spacing: 6, detail: 20, particleSize: 2, sizeVar: 0.6,
    hueRange: 240, glow: 1.3, fade: 0.75, outline: false, dispersal: 1.8, autoRotate: 0.4,
  },
  Halo: {
    ...DEFAULTS, length: 40, spacing: 0, detail: 16, particleSize: 3, dispersal: 2.2,
    hueRange: 50, glow: 1.6, fade: 0.5, pulse: 0.8, outline: false,
  },
  Tunnel: {
    ...DEFAULTS, length: 100, spacing: 40, detail: 12, particleSize: 4, hueRange: 360,
    hueSpeed: 2, fade: 0.6, glow: 0.9, pulse: 0.3,
  },
  Spectrum: {
    ...DEFAULTS, mode: 'spectrum', length: 60, spacing: 8, detail: 19, particleSize: 3, sizeVar: 0.4,
    dispersal: 1.4, hueRange: 200, glow: 1, fade: 0.65, pulse: 0.2, beatMotion: 0.5, outline: false,
  },
  Bloom: {
    ...DEFAULTS, length: 24, spacing: 12, detail: 14, particleSize: 8, sizeVar: 0.8,
    ringSize: 0.8, dispersal: 2.6, hueRange: 140, glow: 1.1, pulse: 1.2,
  },
};

const clamp = (v, p) => Math.min(p.max, Math.max(p.min, v));
const HEX = /^#?([0-9a-f]{6})$/i;
const toHex = (v) => {
  const m = HEX.exec(String(v).trim());
  return m ? `#${m[1].toLowerCase()}` : null;
};
export function samePalette(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((c, i) => c === b[i]);
}
export const sameValue = (k, a, b) => (PARAMS[k]?.type === 'palette' ? samePalette(a, b) : a === b);

export function sanitize(input) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(input || {})) {
    const p = PARAMS[k];
    if (!p) continue;
    if (p.type === 'toggle') out[k] = v === true || v === '1' || v === 'true';
    else if (p.type === 'choice') out[k] = p.options.some(([o]) => o === v) ? v : p.value;
    else if (p.type === 'preset') out[k] = p.options.includes(v) ? v : p.value;
    else if (p.type === 'palette') {
      const list = (Array.isArray(v) ? v : String(v).split(/[-,\s]+/)).map(toHex).filter(Boolean).slice(0, 8);
      out[k] = list.length >= 2 ? list : p.value;
    } else if (p.type === 'color') out[k] = toHex(v) || p.value;
    else if (Number.isFinite(Number(v))) out[k] = clamp(Number(v), p);
  }
  return out;
}

// Only parameters that differ from the defaults go in the URL, so links stay short.
export function toHash(settings, track) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(settings)) {
    if (sameValue(k, v, DEFAULTS[k])) continue;
    if (Array.isArray(v)) q.set(k, v.map((c) => c.slice(1)).join('-'));
    else if (PARAMS[k]?.type === 'color') q.set(k, v.slice(1));
    else if (typeof v === 'boolean') q.set(k, v ? '1' : '0');
    else if (typeof v === 'string') q.set(k, v);
    else q.set(k, String(+v.toFixed(3)));
  }
  if (track?.shareId) q.set('t', track.shareId);
  const s = q.toString();
  return s ? `#${s}` : '';
}

export function fromHash(hash) {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = Object.fromEntries(q.entries());
  const track = raw.t;
  delete raw.t;
  return { settings: Object.keys(raw).length ? sanitize(raw) : null, track };
}

const STORE_KEY = 'ring:settings';
export function loadStored() {
  try {
    const s = localStorage.getItem(STORE_KEY);
    return s ? sanitize(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}
export function store(settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode or blocked storage: settings just won't persist */
  }
}
