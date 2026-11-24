// Every visual parameter, grouped the way the Tune panel shows them.
// Defaults for the original controls match ring v1.
export const GROUPS = [
  {
    name: 'Shape',
    params: [
      { key: 'ringSize', label: 'Ring size', min: 0.5, max: 2, step: 0.05, value: 1 },
      { key: 'dispersal', label: 'Dispersal', min: 1, max: 3, step: 0.05, value: 1.5 },
      { key: 'pulse', label: 'Bass pulse', min: 0, max: 2, step: 0.05, value: 0.4 },
    ],
  },
  {
    name: 'Particles',
    params: [
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
    ],
  },
  {
    name: 'Color',
    params: [
      { key: 'hueRange', label: 'Hue range', min: 0, max: 360, step: 1, value: 90 },
      { key: 'hueSpeed', label: 'Color speed', min: 0, max: 5, step: 0.1, value: 1 },
      { key: 'glow', label: 'Glow', min: 0, max: 2, step: 0.05, value: 0.6 },
    ],
  },
  {
    name: 'Camera',
    params: [{ key: 'autoRotate', label: 'Auto-rotate', min: 0, max: 5, step: 0.1, value: 0 }],
  },
];

export const PARAMS = Object.fromEntries(GROUPS.flatMap((g) => g.params).map((p) => [p.key, p]));
export const DEFAULTS = Object.fromEntries(Object.values(PARAMS).map((p) => [p.key, p.value]));

export const PRESETS = {
  Ring: { ...DEFAULTS },
  Classic: { ...DEFAULTS, pulse: 0, fade: 0, glow: 0 },
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
  Bloom: {
    ...DEFAULTS, length: 24, spacing: 12, detail: 14, particleSize: 8, sizeVar: 0.8,
    ringSize: 0.8, dispersal: 2.6, hueRange: 140, glow: 1.1, pulse: 1.2,
  },
};

const clamp = (v, p) => Math.min(p.max, Math.max(p.min, v));

export function sanitize(input) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(input || {})) {
    const p = PARAMS[k];
    if (!p) continue;
    if (p.type === 'toggle') out[k] = v === true || v === '1' || v === 'true';
    else if (Number.isFinite(Number(v))) out[k] = clamp(Number(v), p);
  }
  return out;
}

// Only parameters that differ from the defaults go in the URL, so links stay short.
export function toHash(settings, track) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(settings)) {
    if (v === DEFAULTS[k]) continue;
    q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(+v.toFixed(3)));
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
