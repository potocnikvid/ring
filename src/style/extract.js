// Turns an image or a video into a ring style, entirely in the browser:
// a palette (k-means), a few measurements, and a mapping from those to settings.
import { DEFAULTS } from '../settings.js';

const SIZE = 96; // colour analysis resolution
const DETAIL_SIZE = 256; // edges and symmetry need finer detail
const H_VARIATION_MIN = 0.001;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawScaled(source, w, h, max) {
  const scale = Math.min(1, max / Math.max(w, h));
  const c = canvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c;
}

// A JPEG copy small enough to send to the AI endpoint.
function toJpeg(source, w, h) {
  const c = drawScaled(source, w, h, 768);
  return { media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.82).split(',')[1] };
}

function pixels(source, w, h, max = SIZE) {
  const c = drawScaled(source, w, h, max);
  const { data } = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  return { data, w: c.width, h: c.height };
}

const lumOf = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// k-means++ with a fixed seed, so the same image gives the same palette.
function kmeans(samples, k = 6, iterations = 10) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = samples.length / 3;
  const centers = [];
  const pick = Math.floor(rand() * n) * 3;
  centers.push([samples[pick], samples[pick + 1], samples[pick + 2]]);
  const dist = new Float32Array(n);
  while (centers.length < k) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (const c of centers) {
        const d = (samples[i * 3] - c[0]) ** 2 + (samples[i * 3 + 1] - c[1]) ** 2 + (samples[i * 3 + 2] - c[2]) ** 2;
        if (d < best) best = d;
      }
      dist[i] = best;
      sum += best;
    }
    let target = rand() * sum;
    let idx = 0;
    while (idx < n - 1 && (target -= dist[idx]) > 0) idx++;
    centers.push([samples[idx * 3], samples[idx * 3 + 1], samples[idx * 3 + 2]]);
  }
  const assign = new Uint8Array(n);
  for (let it = 0; it < iterations; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      let bi = 0;
      for (let c = 0; c < k; c++) {
        const ce = centers[c];
        const d = (samples[i * 3] - ce[0]) ** 2 + (samples[i * 3 + 1] - ce[1]) ** 2 + (samples[i * 3 + 2] - ce[2]) ** 2;
        if (d < best) { best = d; bi = c; }
      }
      assign[i] = bi;
      const a = acc[bi];
      a[0] += samples[i * 3]; a[1] += samples[i * 3 + 1]; a[2] += samples[i * 3 + 2]; a[3]++;
    }
    acc.forEach((a, c) => { if (a[3]) centers[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  const counts = new Array(k).fill(0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;
  return centers.map((c, i) => ({ rgb: c, weight: counts[i] / n })).filter((c) => c.weight > 0);
}

// Measurements over one or more frames: colour from the small copies, edges and
// symmetry from the detailed ones.
function measure(frames, detailFrames = frames) {
  let n = 0, lumSum = 0, lumSq = 0, satSum = 0, rgSum = 0, rgSq = 0, ybSum = 0, ybSq = 0;
  let edgeSum = 0, edgeN = 0, symSum = 0, symN = 0, hueX = 0, hueY = 0, hSum = 0, hN = 0;
  const stride = Math.max(1, Math.floor((frames.length * SIZE * SIZE) / 12000));
  const samples = [];
  let idx = 0;
  for (const { data, w, h } of frames) {
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const L = lumOf(r, g, b);
      lum[i] = L;
      const [hue, s, l] = rgbToHsl(r, g, b);
      lumSum += L; lumSq += L * L; satSum += s; n++;
      const rg = r - g, yb = 0.5 * (r + g) - b;
      rgSum += rg; rgSq += rg * rg; ybSum += yb; ybSq += yb * yb;
      // Weighted by chroma, so dark or pale areas don't decide the colour name.
      const chroma = s * (1 - Math.abs(2 * l - 1));
      hueX += Math.cos(hue * 2 * Math.PI) * chroma;
      hueY += Math.sin(hue * 2 * Math.PI) * chroma;
      if (idx++ % stride === 0) samples.push(r, g, b);
    }
  }
  for (const { data, w, h } of detailFrames) {
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = lumOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1];
        const gy = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1];
        edgeSum += Math.hypot(gx, gy);
        edgeN++;
      }
      for (let x = 0; x < w / 2; x++) {
        symSum += Math.abs(lum[y * w + x] - lum[y * w + (w - 1 - x)]);
        symN++;
      }
      for (let x = 0; x < w - 1; x++) {
        hSum += Math.abs(lum[y * w + x + 1] - lum[y * w + x]);
        hN++;
      }
    }
  }
  const lumMean = lumSum / n;
  const stdRg = Math.sqrt(Math.max(0, rgSq / n - (rgSum / n) ** 2));
  const stdYb = Math.sqrt(Math.max(0, ybSq / n - (ybSum / n) ** 2));
  const colorfulness = Math.hypot(stdRg, stdYb) + 0.3 * Math.hypot(rgSum / n, ybSum / n);

  let motion = 0;
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1].data, b = frames[f].data;
    let d = 0;
    for (let i = 0; i < a.length; i += 4) d += Math.abs(lumOf(a[i], a[i + 1], a[i + 2]) - lumOf(b[i], b[i + 1], b[i + 2]));
    motion += d / (a.length / 4);
  }
  if (frames.length > 1) motion /= frames.length - 1;

  return {
    brightness: lumMean,
    contrast: clamp01(Math.sqrt(Math.max(0, lumSq / n - lumMean ** 2)) / 0.3),
    saturation: satSum / n,
    colorfulness: clamp01(colorfulness / 110),
    edges: clamp01(edgeSum / edgeN / 0.9),
    // Mirror-symmetric only counts when something actually varies left to right
    // (a plain vertical gradient is trivially symmetric).
    symmetry: (hSum / hN) > H_VARIATION_MIN ? 1 - clamp01((symSum / symN) / 0.25) : 0,
    hVariation: hSum / hN,
    motion: clamp01(motion / 0.15),
    hueCenter: ((Math.atan2(hueY, hueX) / (2 * Math.PI)) + 1) % 1,
    samples: new Float32Array(samples),
  };
}

// Picks up to five palette colours that will read as glowing particles on a dark
// background, ordered dark to light so the depth gradient is smooth.
function buildPalette(clusters) {
  const byWeight = [...clusters].sort((a, b) => b.weight - a.weight);
  const hsl = byWeight.map((c) => ({ ...c, hsl: rgbToHsl(...c.rgb) }));
  const darkest = [...hsl].sort((a, b) => a.hsl[2] - b.hsl[2])[0];
  // Near-black areas become the background, not particle colours.
  const lit = hsl.filter((c) => c.hsl[2] > 0.14 && c.weight > 0.02);
  const vivid = (lit.length >= 2 ? lit : hsl).map((c) => {
    const [h, s, l] = c.hsl;
    return { h, s: Math.min(1, s * 1.15 + 0.05), l: lerp(0.42, 0.8, clamp01((l - 0.1) / 0.8)), weight: c.weight };
  });
  // Drop near-duplicates.
  const picked = [];
  for (const c of vivid) {
    const dup = picked.some((p) => Math.abs(p.l - c.l) < 0.06 && (Math.abs(p.h - c.h) < 0.04 || (p.s < 0.15 && c.s < 0.15)));
    if (!dup) picked.push(c);
    if (picked.length === 5) break;
  }
  while (picked.length < 3) {
    const base = picked[0] || { h: 0.6, s: 0.6, l: 0.6 };
    picked.push({ ...base, h: (base.h + 0.08 * picked.length) % 1, l: Math.min(0.85, base.l + 0.12) });
  }
  picked.sort((a, b) => a.l - b.l);
  const [bh, bs] = darkest.hsl;
  return {
    palette: picked.map((c) => hslToHex(c.h, c.s, c.l)),
    background: hslToHex(bh, Math.min(0.6, bs), 0.045),
  };
}

function nameFor(stats) {
  const h = stats.hueCenter;
  const warm = stats.saturation > 0.15 && (h < 0.12 || h > 0.9);
  const cool = stats.saturation > 0.15 && h > 0.45 && h < 0.75;
  const tone = stats.saturation < 0.15 ? 'Silver' : warm ? 'Ember' : cool ? 'Tide' : h < 0.45 ? 'Moss' : 'Orchid';
  const texture = stats.edges > 0.45 ? 'lattice' : stats.edges < 0.2 ? 'haze' : 'grain';
  return `${tone} ${texture}`;
}

// Measurements → settings. Each line is a deliberate, readable rule.
export function mapStats(stats, clusters) {
  const { palette, background } = buildPalette(clusters);
  const { edges, contrast, colorfulness, brightness, saturation, motion, symmetry } = stats;
  const shape = edges > 0.45 ? 'cube' : edges < 0.22 || saturation < 0.15 ? 'dot' : 'sphere';
  const settings = {
    ...DEFAULTS,
    colorMode: 'palette',
    palette,
    background,
    shape,
    outline: shape === 'cube' && edges > 0.35,
    detail: Math.round(lerp(12, 20, edges)),
    particleSize: +lerp(shape === 'dot' ? 7 : 6, 2, edges).toFixed(1),
    sizeVar: +lerp(0.15, 0.7, edges).toFixed(2),
    length: Math.round(lerp(70, 18, edges)),
    spacing: Math.round(lerp(6, 26, edges)),
    dispersal: +lerp(1.2, 2.6, contrast).toFixed(2),
    pulse: +lerp(0.2, 1.0, contrast).toFixed(2),
    fade: +lerp(0.7, 0.3, contrast).toFixed(2),
    hueRange: Math.round(lerp(90, 270, colorfulness)),
    hueSpeed: +(stats.isVideo ? lerp(0.2, 3, motion) : lerp(0.3, 1.2, colorfulness)).toFixed(1),
    glow: +Math.min(1.6, 0.35 + (1 - brightness) * 0.6 + saturation * 0.5).toFixed(2),
    trails: +(stats.isVideo ? lerp(0, 0.7, motion) : edges < 0.22 ? 0.45 : 0).toFixed(2),
    twist: +(stats.isVideo ? lerp(0, 0.12, motion) : 0).toFixed(2),
    symmetry: symmetry > 0.82 ? 6 : 0,
    beatMotion: +(stats.isVideo ? lerp(0.2, 0.9, motion) : 0.3).toFixed(2),
    mode: edges > 0.6 ? 'spectrum' : 'wave',
  };
  return { name: nameFor(stats), palette, background, settings };
}

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('That image couldn’t be read.'));
  img.src = url;
});

export async function styleFromImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    const stats = measure([pixels(img, w, h)], [pixels(img, w, h, DETAIL_SIZE)]);
    const style = mapStats(stats, kmeans(stats.samples));
    return { style, stats, images: [toJpeg(img, w, h)], preview: url };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

export async function styleFromVideo(file, frameCount = 8) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('That video couldn’t be read. Try an MP4 or WebM.'));
    });
    const d = Number.isFinite(video.duration) ? video.duration : 0;
    const w = video.videoWidth, h = video.videoHeight;
    const frames = [];
    const detail = [];
    const images = [];
    for (let i = 0; i < frameCount; i++) {
      video.currentTime = d ? (d * (i + 0.5)) / frameCount : 0;
      await new Promise((resolve) => { video.onseeked = resolve; setTimeout(resolve, 1500); });
      frames.push(pixels(video, w, h));
      detail.push(pixels(video, w, h, DETAIL_SIZE));
      if (i % 3 === 1 && images.length < 3) images.push(toJpeg(video, w, h));
    }
    const stats = { ...measure(frames, detail), isVideo: true };
    const style = mapStats(stats, kmeans(stats.samples));
    return { style, stats, images, preview: null };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A summary of the measurements for the AI, so it can build on them.
export function describeStats(stats) {
  const pct = (v) => Math.round(v * 100);
  return {
    brightness: pct(stats.brightness),
    contrast: pct(stats.contrast),
    saturation: pct(stats.saturation),
    colorfulness: pct(stats.colorfulness),
    detail: pct(stats.edges),
    leftRightSymmetry: pct(stats.symmetry),
    ...(stats.isVideo ? { motion: pct(stats.motion) } : {}),
  };
}
