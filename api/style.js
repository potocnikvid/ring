// Vercel Function: turns a reference (prompt, images or video frames, or a website)
// into a ring style with Claude. Needs ANTHROPIC_API_KEY in the project's env.
import Anthropic from '@anthropic-ai/sdk';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { GROUPS, PARAMS } from '../src/settings.js';

const MODEL = 'claude-opus-5-5';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3.5e6;
const MAX_PROMPT = 2000;

/* ---------- Schema and prompt, generated from the app's own settings ---------- */

function paramSchema(p) {
  if (p.type === 'toggle') return { type: 'boolean' };
  if (p.type === 'choice') return { type: 'string', enum: p.options.map(([v]) => v) };
  if (p.type === 'preset') return { type: 'string', enum: p.options };
  const integer = Number.isInteger(p.step) && Number.isInteger(p.min);
  return { type: integer ? 'integer' : 'number' };
}

// Every Tune setting except colorMode: a style always uses its own palette.
const settingKeys = GROUPS.flatMap((g) => g.params).map((p) => p.key).filter((k) => k !== 'colorMode');
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'why', 'palette', 'background', 'settings'],
  properties: {
    name: { type: 'string', description: 'A two or three word name for the style.' },
    why: { type: 'string', description: 'One short sentence on how the reference shaped the look.' },
    palette: {
      type: 'array',
      items: { type: 'string', description: 'A colour as #rrggbb.' },
      description: '3 to 6 colours, ordered as a gradient.',
    },
    background: { type: 'string', description: 'Background colour as #rrggbb.' },
    settings: {
      type: 'object',
      additionalProperties: false,
      required: settingKeys,
      properties: Object.fromEntries(settingKeys.map((k) => [k, paramSchema(PARAMS[k])])),
    },
  },
};

function describeParams() {
  const notes = {
    mode: 'wave reacts to the waveform (organic, wobbly); spectrum maps frequencies around the ring (spiky, bass at the bottom).',
    ringSize: 'Overall radius.',
    dispersal: 'How far the waveform pushes particles in and out. High = explosive.',
    pulse: 'How much the whole ring swells on bass hits.',
    symmetry: '0 = off; N folds the shape into N mirrored petals (kaleidoscope).',
    twist: 'Radians each older ring rotates: spirals the tunnel. Negative twists the other way.',
    shape: 'cube = crisp, graphic; sphere = faceted gems; dot = soft round glowing points.',
    particleSize: 'Particle size.',
    sizeVar: 'How much particle size follows loudness. Negative inverts it.',
    detail: 'Particles per ring: 20 = densest line, low = sparse.',
    outline: 'Dark edges on cubes (graphic, retro). Only matters for cubes.',
    length: 'How many past rings form the tunnel.',
    spacing: 'Depth between rings: 0 stacks them into one thick ring, high = long tunnel.',
    fade: 'How much older rings darken.',
    trails: 'Motion blur / afterimage. 0 = crisp, 0.9 = long smeared light trails.',
    hueRange: 'How much of the palette is spread along the tunnel depth (180 = the whole palette).',
    hueSpeed: 'How fast the colours drift over time.',
    glow: 'Bloom strength. 0 = flat, 1.5 = neon.',
    beatMotion: 'Spin and zoom kicks on each beat.',
    autoRotate: 'Constant slow camera orbit speed.',
    milkLayer: 'Adds a classic MilkDrop psychedelic feedback visual inside the 3D scene: walls = flying through a MilkDrop tunnel around the ring; backdrop = a MilkDrop sky behind it; off = clean.',
    milkPreset: 'Which MilkDrop preset (names listed below hint at the look).',
    milkAmount: 'Strength of the MilkDrop layer.',
    milkColors: 'How much the ring particles take their colours from MilkDrop instead of the palette.',
  };
  return settingKeys.map((k) => {
    const p = PARAMS[k];
    const range = p.type === 'choice' ? p.options.map(([v]) => v).join(' | ')
      : p.type === 'preset' ? 'a preset name from the list below'
        : p.type === 'toggle' ? 'true | false' : `${p.min} to ${p.max}`;
    return `- ${k} (${range}, default ${p.value}): ${notes[k] || p.label}`;
  }).join('\n');
}

export const SYSTEM = `You are the art director of "ring", a real-time 3D music visualiser. Thousands of particles form a ring that ripples with the music; past frames recede into a tunnel the viewer can orbit, with optional bloom glow.

Your job: translate a reference (an image, video frames, a website's visual identity, or a written mood) into a ring style that feels unmistakably like that reference.

How to work:
- Read the reference for its palette, contrast, texture, density, rhythm and mood, then make deliberate, bold choices. Avoid defaults unless they truly fit.
- Palette: 3 to 6 colours ordered as a smooth gradient. When the reference has real colours (an image, a brand), use them, adjusted so they read as glowing particles: mid to high lightness, no near-black colours in the palette.
- Background: usually very dark, tinted toward the reference. Keep it dark enough that particles stand out.
- Texture maps to shape and density: crisp, geometric or typographic references suit cubes with outlines and high detail; soft, natural, misty or dreamy references suit dots with trails and glow; ornate or gem-like references suit spheres.
- Energy maps to motion: calm references want low dispersal, slow colour drift, gentle trails; aggressive ones want high dispersal, pulse and beat motion.
- Symmetry and twist are strong signatures: use symmetry for mandala, floral, ornamental or logo-like references, twist for swirling or spiralling ones. Leave them at 0 otherwise.
- Measurements may be included (0-100). Treat them as hints, not rules.

- MilkDrop suits psychedelic, liquid, cosmic, kaleidoscopic, rave or retro-computer references. For clean, minimal, corporate or calm references keep milkLayer off and milkColors 0. When you use it, pick the preset whose name best matches the reference.

Parameters (stay inside each range):
${describeParams()}

MilkDrop presets:
${PARAMS.milkPreset.options.join('\n')}`;

/* ---------- Website reading (with SSRF guards) ---------- */
function privateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && privateAddress(v.slice(7));
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function assertPublic(url) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https links work.');
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('That link isn’t public.');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error('That link isn’t public.');
}

async function guardedFetch(href, maxBytes, accept) {
  let url = new URL(href);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'ring-style/1.0 (+https://ring-umber.vercel.app)', accept },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    if (!res.ok) throw new Error(`The site answered ${res.status}.`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error('That page is too large to read.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('That page is too large to read.');
    return { url, type: (res.headers.get('content-type') || '').split(';')[0].trim(), buf };
  }
  throw new Error('Too many redirects.');
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function topColors(css) {
  const counts = new Map();
  const add = (hex) => counts.set(hex, (counts.get(hex) || 0) + 1);
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    add(`#${h.toLowerCase()}`);
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})[ ,]+(\d{1,3})[ ,]+(\d{1,3})/gi)) {
    add(`#${[m[1], m[2], m[3]].map((v) => Math.min(255, +v).toString(16).padStart(2, '0')).join('')}`);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([hex, n]) => `${hex} ×${n}`);
}

export async function readSite(href) {
  const page = await guardedFetch(href, 2e6, 'text/html,image/*;q=0.9,*/*;q=0.5');
  if (IMAGE_TYPES.includes(page.type)) {
    if (page.buf.length > MAX_IMAGE_BYTES) throw new Error('That image is too large.');
    return { text: `An image linked from ${page.url.hostname}.`, images: [{ media_type: page.type, data: page.buf.toString('base64') }] };
  }
  if (!page.type.includes('html')) throw new Error('That link isn’t a web page or an image.');
  const html = page.buf.toString('utf8');
  const meta = (name) => html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)`, 'i'))?.[1]
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`, 'i'))?.[1];
  const title = html.match(/<title[^>]*>([^<]{0,200})/i)?.[1]?.trim();
  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  css += [...html.matchAll(/style=["']([^"']+)["']/gi)].map((m) => m[1]).join(';');
  const sheets = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)]
    .map((m) => m[0].match(/href=["']([^"']+)/i)?.[1]).filter(Boolean).slice(0, 3);
  for (const s of sheets) {
    try {
      const r = await guardedFetch(new URL(s, page.url).href, 6e5, 'text/css');
      css += `\n${r.buf.toString('utf8')}`;
    } catch { /* skip unreadable stylesheets */ }
  }
  const images = [];
  const og = meta('og:image') || meta('twitter:image');
  if (og) {
    try {
      const r = await guardedFetch(new URL(og, page.url).href, MAX_IMAGE_BYTES, 'image/*');
      if (IMAGE_TYPES.includes(r.type)) images.push({ media_type: r.type, data: r.buf.toString('base64') });
    } catch { /* no preview image */ }
  }
  const lines = [
    `Website: ${page.url.hostname}`,
    title && `Title: ${title}`,
    meta('description') && `Description: ${meta('description').slice(0, 300)}`,
    meta('theme-color') && `Theme colour: ${meta('theme-color')}`,
    `Most used colours in its CSS: ${topColors(css).join(', ') || 'none found'}`,
    images.length ? 'Its social preview image is attached.' : null,
  ].filter(Boolean);
  return { text: lines.join('\n'), images };
}

/* ---------- Rate limiting (best effort, per instance) ---------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  list.push(now);
  hits.set(ip, list);
  return list.length > 30;
}

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export function GET() {
  return json({ enabled: !!process.env.ANTHROPIC_API_KEY });
}

export async function POST(request) {
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'AI styles aren’t set up on this site yet.' }, 501);
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  if (rateLimited(ip)) return json({ error: 'Too many styles in the last hour. Try again later.' }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request.' }, 400);
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, MAX_PROMPT).trim() : '';
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((i) => IMAGE_TYPES.includes(i?.media_type) && typeof i.data === 'string' && i.data.length * 0.75 < MAX_IMAGE_BYTES)
    .slice(0, MAX_IMAGES);
  const parts = [];
  if (body.kind) parts.push(`Reference type: ${String(body.kind).slice(0, 20)}.`);

  if (typeof body.url === 'string' && body.url) {
    try {
      const site = await readSite(body.url.trim());
      parts.push(site.text);
      images.push(...site.images.slice(0, MAX_IMAGES - images.length));
    } catch (err) {
      return json({ error: `Couldn’t read that link: ${err.message}` }, 422);
    }
  }
  if (body.measurements && typeof body.measurements === 'object') {
    parts.push(`Measurements from the browser (0-100): ${JSON.stringify(body.measurements).slice(0, 500)}`);
  }
  if (prompt) parts.push(`The person describes the style they want: "${prompt}"`);
  if (!parts.length && !images.length) return json({ error: 'Add an image, a link or a description first.' }, 400);
  parts.push('Create the ring style.');

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
          { type: 'text', text: parts.join('\n\n') },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') return json({ error: 'Claude declined to style that reference. Try another one.' }, 422);
    if (response.stop_reason === 'max_tokens') return json({ error: 'The style came back incomplete. Try again.' }, 502);
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return json({ error: 'No style came back. Try again.' }, 502);
    return json({ style: JSON.parse(text), model: response.model });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'The AI is busy right now. Try again in a minute.' }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'The site’s AI key isn’t valid.' }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: `The AI request failed (${err.status}).` }, 502);
    if (err instanceof SyntaxError) return json({ error: 'The style came back malformed. Try again.' }, 502);
    throw err;
  }
}
