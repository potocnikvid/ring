import '@fontsource-variable/inconsolata/wdth.css';
import './style.css';
import { AudioEngine, SAMPLES } from './audio.js';
import { Visualizer } from './visualizer.js';
import { DEFAULTS, GROUPS, PARAMS, PRESETS, fromHash, loadStored, sanitize, store, toHash } from './settings.js';
import { LIBRARY } from './library.js';
import { lookupSong, searchSongs } from './catalog.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const narrow = window.matchMedia('(max-width: 760px)');

const audio = new AudioEngine();
const vis = new Visualizer($('stage'));

const shared = fromHash(location.hash);
let settings = shared.settings || loadStored() || { ...DEFAULTS };
let queue = LIBRARY;
let queueIndex = 0;
let pendingTrack = LIBRARY[0];
let started = false;

/* ---------- Toast ---------- */
let toastTimer;
function toast(message, ms = 3600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------- Tune panel ---------- */
const controls = {};
const decimals = (step) => (String(step).split('.')[1] || '').length;
function format(p, v) {
  if (p.key === 'hueRange') return `${v}°`;
  if (p.key === 'detail') return `${v}`;
  return Number(v).toFixed(Math.min(2, decimals(p.step)));
}
function setFill(el) {
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--fill', `${pct}%`);
}

function buildParams() {
  const root = $('params');
  for (const group of GROUPS) {
    const fs = document.createElement('fieldset');
    fs.className = 'group';
    const legend = document.createElement('legend');
    legend.textContent = group.name;
    fs.append(legend);
    for (const p of group.params) {
      const row = document.createElement('div');
      const id = `p-${p.key}`;
      const label = Object.assign(document.createElement('label'), { htmlFor: id, textContent: p.label });
      let input;
      let output = null;
      if (p.type === 'toggle') {
        row.className = 'param toggle';
        input = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'switch', id });
        input.addEventListener('change', () => setParam(p.key, input.checked));
        row.append(label, input);
      } else {
        row.className = 'param';
        output = document.createElement('output');
        output.htmlFor = id;
        input = Object.assign(document.createElement('input'), {
          type: 'range', className: 'range', id, min: p.min, max: p.max, step: p.step,
        });
        input.addEventListener('input', () => setParam(p.key, Number(input.value)));
        row.append(label, output, input);
      }
      controls[p.key] = { input, output, p };
      fs.append(row);
    }
    root.append(fs);
  }

  const presets = $('presets');
  for (const name of Object.keys(PRESETS)) {
    const b = Object.assign(document.createElement('button'), { textContent: name });
    b.dataset.preset = name;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => applySettings(PRESETS[name]));
    presets.append(b);
  }
}

function syncControls() {
  for (const { input, output, p } of Object.values(controls)) {
    const v = settings[p.key];
    if (p.type === 'toggle') input.checked = v;
    else {
      input.value = v;
      output.textContent = format(p, v);
      setFill(input);
    }
  }
  const same = (a, b) => Object.keys(DEFAULTS).every((k) => a[k] === b[k]);
  for (const b of $('presets').children) {
    b.setAttribute('aria-pressed', String(same(settings, PRESETS[b.dataset.preset])));
  }
}

let saveTimer;
function applySettings(next) {
  settings = sanitize(next);
  vis.apply(settings);
  syncControls();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store(settings), 300);
}
function setParam(key, value) {
  applySettings({ ...settings, [key]: value });
}

function randomize() {
  const pick = (key, lo, hi) => {
    const p = PARAMS[key];
    const v = lo + Math.random() * (hi - lo);
    return Math.round(v / p.step) * p.step;
  };
  applySettings({
    ...settings,
    ringSize: pick('ringSize', 0.7, 1.4),
    dispersal: pick('dispersal', 1, 2.8),
    pulse: pick('pulse', 0, 1.4),
    particleSize: pick('particleSize', 1.5, 9),
    sizeVar: pick('sizeVar', -0.8, 0.9),
    detail: pick('detail', 10, 20),
    outline: Math.random() > 0.4,
    length: pick('length', 4, 80),
    spacing: pick('spacing', 0, 50),
    fade: pick('fade', 0, 0.8),
    hueRange: pick('hueRange', 20, 360),
    hueSpeed: pick('hueSpeed', 0.2, 3),
    glow: pick('glow', 0.2, 1.5),
  });
}

async function shareLink() {
  const hash = toHash(settings, audio.mode === 'element' ? audio.track : null);
  history.replaceState(null, '', `${location.pathname}${hash}`);
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied. It opens with this look and track.');
  } catch {
    toast('Copy the address bar to share this look.');
  }
}

/* ---------- Panels ---------- */
const panels = { tune: $('tune-toggle'), sources: $('sources-toggle') };
function setPanel(name, open) {
  const panel = $(name);
  if (open && narrow.matches) {
    for (const other of Object.keys(panels)) if (other !== name) setPanel(other, false);
  }
  panel.hidden = !open;
  panels[name].setAttribute('aria-expanded', String(open));
  if (open && name === 'sources' && !$('src-search').hidden) $('search-input').focus();
}
const togglePanel = (name) => setPanel(name, $(name).hidden);

function selectTab(tab) {
  for (const t of document.querySelectorAll('[role="tab"]')) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (tab.id === 'tab-search') $('search-input').focus();
}

/* ---------- Track lists ---------- */
function trackItem(track, index, onPlay) {
  const li = document.createElement('li');
  li.dataset.id = track.id;
  const b = document.createElement('button');
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  if (track.thumb) thumb.style.backgroundImage = `url("${track.thumb}")`;
  else thumb.textContent = String(index + 1);
  const text = document.createElement('span');
  const t = Object.assign(document.createElement('span'), { className: 't', textContent: track.title });
  const s = Object.assign(document.createElement('span'), { className: 's', textContent: track.subtitle });
  text.append(t, s);
  b.append(thumb, text);
  b.addEventListener('click', () => {
    onPlay();
    b.blur();
  });
  li.append(b);
  return li;
}

function renderList(el, tracks) {
  el.replaceChildren(...tracks.map((t, i) => trackItem(t, i, () => playFrom(tracks, i))));
  markCurrent();
}

function markCurrent() {
  const id = audio.track?.id;
  for (const li of document.querySelectorAll('.tracks li')) {
    li.setAttribute('aria-current', String(li.dataset.id === id));
  }
}

/* ---------- Playback ---------- */
function playFrom(list, index) {
  queue = list;
  queueIndex = (index + list.length) % list.length;
  if (!started) begin();
  audio.playTrack(queue[queueIndex]);
}
function next() {
  if (audio.mode === 'stream') return;
  playFrom(queue, queueIndex + 1);
}
function prev() {
  if (audio.mode === 'stream') return;
  if (audio.currentTime > 3) audio.seek(0);
  else playFrom(queue, queueIndex - 1);
}

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let seeking = false;
function renderState() {
  body.classList.toggle('playing', audio.playing);
  body.classList.toggle('loading', audio.loading);
  body.classList.toggle('live', audio.mode === 'stream');
  $('play').setAttribute('aria-label', audio.playing ? 'Pause' : 'Play');
  $('prev').disabled = $('next').disabled = audio.mode === 'stream';
  $('play').disabled = audio.mode === 'stream';
  if (!seeking) {
    const d = audio.duration;
    $('time').textContent = fmtTime(audio.currentTime);
    $('duration').textContent = fmtTime(d);
    $('seek').value = d ? (audio.currentTime / d) * 1000 : 0;
    setFill($('seek'));
  }
  if ('mediaSession' in navigator && audio.duration && audio.mode === 'element') {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1,
      });
    } catch { /* not supported */ }
  }
}

function renderTrack(track) {
  $('title').textContent = track?.title ?? 'Nothing playing';
  $('subtitle').textContent = track?.preview ? `${track.subtitle} (preview)` : track?.subtitle ?? '';
  const art = $('art');
  art.style.backgroundImage = track?.artwork ? `url("${track.artwork}")` : '';
  art.classList.toggle('has-art', !!track?.artwork);
  const link = $('store-link');
  link.hidden = !track?.link;
  if (track?.link) link.href = track.link;
  document.title = track ? `${track.title} · ring` : 'ring';
  markCurrent();
  if ('mediaSession' in navigator && track) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.subtitle,
      album: 'ring',
      artwork: track.artwork
        ? [{ src: track.artwork, sizes: '300x300', type: 'image/jpeg' }]
        : [{ src: '/favicon/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
}

audio.addEventListener('state', renderState);
audio.addEventListener('track', (e) => renderTrack(e.detail));
audio.addEventListener('ended', next);
audio.addEventListener('error', (e) => toast(e.detail.message));
audio.addEventListener('streamended', () => {
  renderTrack(null);
  toast('Stopped listening to live audio.');
});

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    previoustrack: prev,
    nexttrack: next,
    seekbackward: () => audio.skip(-5),
    seekforward: () => audio.skip(5),
    seekto: (d) => audio.seek(d.seekTime),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

/* ---------- Sources ---------- */
let searchTimer;
let searchAbort;
async function runSearch(term) {
  const status = $('search-status');
  searchAbort?.abort();
  if (!term.trim()) {
    status.textContent = 'Plays 30-second previews from Apple Music.';
    $('search-list').replaceChildren();
    return;
  }
  searchAbort = new AbortController();
  status.textContent = 'Searching…';
  try {
    const results = await searchSongs(term.trim(), searchAbort.signal);
    renderList($('search-list'), results);
    status.textContent = results.length
      ? `${results.length} previews. Pick one to play.`
      : `No songs found for “${term.trim()}”. Try an artist name.`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    status.textContent = "Search isn't reachable right now. Check your connection and try again.";
  }
}

function playFiles(files) {
  const tracks = [...files]
    .filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac|webm)$/i.test(f.name))
    .map((f, i) => ({
      kind: 'url',
      id: `file:${i}:${f.name}:${f.size}`,
      title: f.name.replace(/\.[^.]+$/, ''),
      subtitle: 'From your device',
      src: URL.createObjectURL(f),
    }));
  if (!tracks.length) {
    toast('That file isn’t audio. Try an MP3, M4A, WAV or OGG.');
    return;
  }
  playFrom(tracks, 0);
}

async function goLive(kind) {
  if (!started) begin(false);
  try {
    if (kind === 'tab') await audio.useTabAudio();
    else await audio.useMicrophone();
    setPanel('sources', false);
    toast(kind === 'tab' ? 'Listening to the shared tab.' : 'Listening to your microphone.');
  } catch (err) {
    toast(liveError(kind, err), 7000);
  }
}

// Browsers report a user cancel, an OS-level block and an unsupported context with
// the same error name, so tell them apart by message.
function liveError(kind, err) {
  console.warn('[ring] live audio failed:', err.name, err.message);
  const msg = String(err.message || '');
  const tab = kind === 'tab';
  if (err.name === 'NotAllowedError' && /by system/i.test(msg)) {
    return tab
      ? 'macOS is blocking screen sharing for this browser. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the browser.'
      : 'macOS is blocking the microphone for this browser. Allow it in System Settings → Privacy & Security → Microphone.';
  }
  if (err.name === 'NotAllowedError' && /user agent|platform|context|gesture|activation/i.test(msg)) {
    return 'This browser blocked the request. Try Chrome or Edge on a computer.';
  }
  if (err.name === 'NotAllowedError') {
    return tab
      ? 'Sharing didn’t start. Pick the tab, turn on “Share tab audio”, then click Share.'
      : 'Microphone access is blocked. Allow it in your browser’s site settings.';
  }
  if (err.name === 'NotSupportedError' || err.name === 'TypeError' || err.name === 'InvalidStateError') {
    return 'This browser can’t share audio. Try Chrome or Edge on a computer.';
  }
  if (err.name === 'NotReadableError' || err.name === 'AbortError') {
    return 'The browser couldn’t start capturing. Close other apps using the screen or microphone and try again.';
  }
  return err.message || 'Couldn’t start live audio.';
}

/* ---------- Start screen ---------- */
function begin(play = true) {
  if (started) return;
  started = true;
  body.classList.add('started');
  $('start').classList.add('gone');
  audio.unlock();
  if (play && pendingTrack) {
    const i = LIBRARY.indexOf(pendingTrack);
    if (i >= 0) playFrom(LIBRARY, i);
    else playFrom([pendingTrack], 0);
  }
  bumpIdle();
}

/* ---------- Idle hiding ---------- */
let idleTimer;
function bumpIdle() {
  body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const panelOpen = !$('tune').hidden || !$('sources').hidden || $('keys').open;
    const busy = document.activeElement && document.activeElement !== body && document.activeElement.tagName === 'INPUT';
    if (started && audio.playing && !panelOpen && !busy) body.classList.add('idle');
  }, 3200);
}

/* ---------- Fullscreen ---------- */
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ---------- Wire up ---------- */
buildParams();
applySettings(settings);
renderList($('library-list'), LIBRARY);
renderState();

if (shared.track?.startsWith('lib:')) {
  pendingTrack = LIBRARY.find((t) => t.shareId === shared.track) || pendingTrack;
} else if (shared.track?.startsWith('it:')) {
  lookupSong(shared.track.slice(3)).then((t) => {
    if (!t) return;
    pendingTrack = t;
    if (!started) renderTrack(t);
  }).catch(() => {});
}

$('start-btn').addEventListener('click', () => begin());
$('start-btn').focus();
$('play').addEventListener('click', () => audio.toggle());
$('next').addEventListener('click', next);
$('prev').addEventListener('click', prev);
$('tune-toggle').addEventListener('click', () => togglePanel('tune'));
$('sources-toggle').addEventListener('click', () => togglePanel('sources'));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => setPanel(b.dataset.close, false)));
$('randomize').addEventListener('click', randomize);
$('reset').addEventListener('click', () => applySettings(DEFAULTS));
$('share').addEventListener('click', shareLink);
const showKeys = () => { if (!$('keys').open) $('keys').showModal(); };
$('help').addEventListener('click', showKeys);
$('keys').querySelector('[data-close-dialog]').addEventListener('click', () => $('keys').close());
$('keys').addEventListener('click', (e) => { if (e.target === $('keys')) $('keys').close(); });

if (!document.fullscreenEnabled) $('fullscreen').hidden = true;
$('fullscreen').addEventListener('click', toggleFullscreen);

const seek = $('seek');
seek.addEventListener('input', () => {
  seeking = true;
  setFill(seek);
  $('time').textContent = fmtTime((seek.value / 1000) * audio.duration);
});
seek.addEventListener('change', () => {
  audio.seek((seek.value / 1000) * audio.duration);
  seeking = false;
});

const volume = $('volume');
volume.value = audio.volume;
setFill(volume);
volume.addEventListener('input', () => {
  audio.volume = Number(volume.value);
  setFill(volume);
});
function nudgeVolume(d) {
  audio.volume = audio.volume + d;
  volume.value = audio.volume;
  setFill(volume);
}

const tabs = [...document.querySelectorAll('[role="tab"]')];
tabs.forEach((t, i) => {
  t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1;
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const n = tabs[(i + d + tabs.length) % tabs.length];
    selectTab(n);
    n.focus();
  });
});

$('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 350);
});
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  runSearch($('search-input').value);
});

$('file-input').addEventListener('change', (e) => {
  playFiles(e.target.files);
  e.target.value = '';
});

const useTab = $('use-tab');
if (!AudioEngine.canCaptureTab) {
  useTab.disabled = true;
  useTab.querySelector('span').textContent = 'Needs Chrome or Edge on a computer.';
}
useTab.addEventListener('click', () => goLive('tab'));
const useMic = $('use-mic');
if (!AudioEngine.canUseMic) useMic.disabled = true;
useMic.addEventListener('click', () => goLive('mic'));

// Drag and drop audio files anywhere
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  body.classList.remove('dragging');
  playFiles(e.dataTransfer.files);
});

// Clicking the visual returns keyboard shortcuts to the page
$('stage').addEventListener('pointerdown', () => {
  if (document.activeElement !== body) document.activeElement?.blur?.();
});

for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel']) {
  window.addEventListener(ev, bumpIdle, { passive: true });
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const tag = t.tagName;
  const type = t.type;
  const typing = (tag === 'INPUT' && !['range', 'checkbox', 'file'].includes(type)) || tag === 'TEXTAREA';
  if (typing) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  const onControl = tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'LABEL';
  const isRange = tag === 'INPUT' && type === 'range';
  if (!started && e.key !== 'Escape') return;

  switch (e.key) {
    case 'Enter':
      if (onControl) return;
      audio.toggle();
      break;
    case ' ':
      if (onControl) return;
      audio.seek(0);
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      if (isRange || t.getAttribute('role') === 'tab') return;
      audio.skip(e.key === 'ArrowLeft' ? -5 : 5);
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      if (isRange) return;
      nudgeVolume(e.key === 'ArrowUp' ? 0.1 : -0.1);
      break;
    case 'n': next(); break;
    case 'p': prev(); break;
    case 't': togglePanel('tune'); break;
    case 'm': togglePanel('sources'); break;
    case 'r': randomize(); break;
    case 'f': toggleFullscreen(); break;
    case 'h':
      body.classList.toggle('hide-ui');
      break;
    case '?':
      showKeys();
      break;
    case 'Escape':
      if (!$('sources').hidden) setPanel('sources', false);
      else if (!$('tune').hidden) setPanel('tune', false);
      else body.classList.remove('hide-ui');
      break;
    default:
      return;
  }
  e.preventDefault();
});

/* ---------- Render loop ---------- */
// Before anything plays, a gentle synthetic wave keeps the ring alive.
const idleWave = new Uint8Array(SAMPLES);
function synth(t) {
  const k = (Math.PI * 2) / SAMPLES;
  for (let i = 0; i < SAMPLES; i++) {
    const v = Math.sin(i * k * 3 + t * 1.3) * 0.14 + Math.sin(i * k * 7 - t * 2.1) * 0.07 + Math.sin(i * k * 17 + t * 0.6) * 0.03;
    idleWave[i] = 128 + v * 127;
  }
  return idleWave;
}

let last = performance.now();
let hueClock = 0;
const root = document.documentElement;
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  let wave = null;
  if (audio.sample()) wave = audio.timeData;
  else if (audio.mode === 'idle') wave = synth(now / 1000);
  // A paused track leaves wave null, which freezes the tunnel so you can orbit it.
  vis.frame(dt, now, wave, audio.bass);

  hueClock += dt;
  if (hueClock > 0.12) {
    hueClock = 0;
    root.style.setProperty('--hue', String(Math.round(vis.hueStart)));
    if (audio.mode === 'element') renderState();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if (import.meta.env.DEV) window.ring = { audio, vis, get settings() { return settings; } };
