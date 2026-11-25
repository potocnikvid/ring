import '@fontsource-variable/inconsolata/wdth.css';
import './style.css';
import { inject } from '@vercel/analytics';
import { AudioEngine, SAMPLES } from './audio.js';
import { Visualizer } from './visualizer.js';
import { DEFAULTS, GROUPS, PARAMS, PRESETS, fromHash, loadStored, sameValue, sanitize, store, toHash } from './settings.js';
import { describeStats, styleFromImage, styleFromVideo } from './style/extract.js';
import { aiAvailable, aiStyle } from './style/ai.js';
import { LIBRARY } from './library.js';
import { lookupSong, searchSongs } from './catalog.js';
import { FORMATS, MAX_SECONDS, Recorder, canRecord } from './recorder.js';
import * as spotify from './spotify.js';
import { MilkDrop } from './milkdrop.js';
import { MILK_PRESETS } from './milkdrop-presets.js';

// Vercel Web Analytics. Only the path is sent: the query string can hold a
// Spotify sign-in code and the hash holds the shared style settings.
inject({
  mode: import.meta.env.DEV ? 'development' : 'production',
  beforeSend: (event) => {
    const url = new URL(event.url);
    return { ...event, url: url.origin + url.pathname };
  },
});

const $ = (id) => document.getElementById(id);
const body = document.body;

const audio = new AudioEngine();
const vis = new Visualizer($('stage'));
const recorder = new Recorder();
const milk = new MilkDrop();

const shared = fromHash(location.hash);
let settings = shared.settings || loadStored() || { ...DEFAULTS };
let queue = LIBRARY;
let queueIndex = 0;
let pendingTrack = LIBRARY[0];
let started = false;

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

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

function segmented(options, onPick, label) {
  const wrap = document.createElement('div');
  wrap.className = 'segmented';
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
    b.dataset.value = value;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => onPick(value));
    wrap.append(b);
  }
  wrap.select = (value) => {
    for (const b of wrap.children) b.setAttribute('aria-checked', String(b.dataset.value === value));
  };
  return wrap;
}

function buildParams() {
  const root = $('params');
  for (const group of GROUPS) {
    const fs = document.createElement('fieldset');
    fs.className = 'group';
    fs.append(Object.assign(document.createElement('legend'), { textContent: group.name }));
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
      } else if (p.type === 'preset') {
        row.className = 'param preset';
        input = Object.assign(document.createElement('select'), { id, className: 'preset-select' });
        input.append(...p.options.map((name) => Object.assign(document.createElement('option'), { value: name, textContent: name })));
        input.addEventListener('change', () => setParam(p.key, input.value));
        const nav = document.createElement('div');
        nav.className = 'preset-nav';
        for (const [label, step] of [['Previous', -1], ['Next', 1], ['Random', 0]]) {
          const b = Object.assign(document.createElement('button'), { type: 'button', className: 'text-btn', textContent: label });
          b.addEventListener('click', () => stepPreset(step));
          nav.append(b);
        }
        row.append(label, input, nav);
      } else if (p.type === 'choice') {
        row.className = 'param';
        input = segmented(p.options, (v) => setParam(p.key, v), p.label);
        input.id = id;
        label.removeAttribute('for');
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
    else if (p.type === 'choice') input.select(v);
    else if (p.type === 'preset') input.value = v;
    else {
      input.value = v;
      output.textContent = format(p, v);
      setFill(input);
    }
  }
  const same = (a, b) => Object.keys(DEFAULTS).every((k) => sameValue(k, a[k], b[k]));
  for (const b of $('presets').children) {
    b.setAttribute('aria-pressed', String(same(settings, PRESETS[b.dataset.preset])));
  }
}

let saveTimer;
function applySettings(next) {
  settings = sanitize(next);
  vis.apply(settings);
  milk.setPreset(settings.milkPreset);
  ensureMilk();
  syncControls();
  document.body.style.backgroundColor = settings.background;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store(settings), 300);
}
function setParam(key, value) {
  applySettings({ ...settings, [key]: value });
}

function stepPreset(step) {
  const i = MILK_PRESETS.indexOf(settings.milkPreset);
  const next = step === 0
    ? MILK_PRESETS[Math.floor(Math.random() * MILK_PRESETS.length)]
    : MILK_PRESETS[(i + step + MILK_PRESETS.length) % MILK_PRESETS.length];
  applySettings({ ...settings, milkPreset: next, milkLayer: settings.milkLayer === 'off' && settings.milkColors === 0 ? 'walls' : settings.milkLayer });
}

// Loads MilkDrop the first time a setting needs it and audio is unlocked.
let milkFailed = false;
function ensureMilk() {
  if (milk.ready || milkFailed || !vis.milkWanted || !audio.ctx) return;
  if (!MilkDrop.supported) {
    milkFailed = true;
    toast('MilkDrop needs WebGL 2, which this browser doesn’t have.');
    return;
  }
  milk.load(audio.ctx, audio.tap)
    .then(() => vis.setMilkCanvas(milk.canvas))
    .catch((err) => {
      milkFailed = true;
      console.warn('[ring] MilkDrop failed', err);
      toast('MilkDrop couldn’t start in this browser.');
    });
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
    beatMotion: pick('beatMotion', 0, 0.8),
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

/* ---------- Side panels (Tune, Record) ---------- */
const sides = { tune: $('tune-toggle'), record: $('record-toggle'), style: $('style-toggle') };
function setSide(name, open) {
  if (open) for (const other of Object.keys(sides)) if (other !== name) setSide(other, false);
  $(name).hidden = !open;
  sides[name].setAttribute('aria-expanded', String(open));
  if (open) closePalette();
  if (open && name === 'record') updateRecordPanel();
}
const toggleSide = (name) => setSide(name, $(name).hidden);

/* ---------- Track options ---------- */
function optionEl(track, index, onPick, idPrefix) {
  const li = document.createElement('li');
  li.setAttribute('role', 'option');
  li.id = `${idPrefix}-${index}`;
  li.dataset.id = track.id;
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  if (track.thumb) thumb.style.backgroundImage = `url("${track.thumb}")`;
  else thumb.textContent = String(index + 1);
  const text = document.createElement('span');
  text.className = 'text';
  text.append(
    Object.assign(document.createElement('span'), { className: 't', textContent: track.title }),
    Object.assign(document.createElement('span'), { className: 's', textContent: track.subtitle }),
  );
  li.append(thumb, text);
  li.pick = onPick;
  li.addEventListener('click', onPick);
  return li;
}

function renderList(el, tracks, onPick, prefix) {
  el.replaceChildren(...tracks.map((t, i) => optionEl(t, i, () => onPick(tracks, i), prefix || el.id)));
  markCurrent();
}

function currentId() {
  return sp.on && sp.track ? sp.track.id : audio.track?.id;
}
function markCurrent() {
  const id = currentId();
  for (const li of document.querySelectorAll('.tracks [role="option"]')) {
    li.setAttribute('aria-current', String(li.dataset.id === id));
  }
}

/* ---------- Recently played ---------- */
const RECENT_KEY = 'ring:recent';
function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}
function pushRecent(track) {
  if (!track?.shareId) return; // library and catalog tracks only; files can't be replayed
  const keep = ({ kind, id, shareId, title, subtitle, src, artwork, thumb, link, preview }) =>
    ({ kind, id, shareId, title, subtitle, src, artwork, thumb, link, preview });
  const list = [keep(track), ...loadRecent().filter((t) => t.id !== track.id)].slice(0, 6);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage blocked */ }
  renderHome();
}

function renderHome() {
  const recent = loadRecent();
  $('recent-section').hidden = !recent.length;
  renderList($('recent-list'), recent, pickTrack, 'recent');
  renderList($('library-list'), LIBRARY, pickTrack, 'lib');
}

/* ---------- Search palette ---------- */
const q = $('q');
const palette = $('palette');
let activeOption = null;

function openPalette() {
  if (!palette.hidden) return;
  palette.hidden = false;
  q.setAttribute('aria-expanded', 'true');
  refreshInputs();
  for (const name of Object.keys(sides)) setSide(name, false);
}
function closePalette() {
  if (palette.hidden) return;
  palette.hidden = true;
  q.setAttribute('aria-expanded', 'false');
  setActive(null);
}
function visibleOptions() {
  return [...palette.querySelectorAll('[role="option"]')].filter((el) => el.offsetParent !== null);
}
function setActive(el) {
  activeOption?.classList.remove('active');
  activeOption?.setAttribute('aria-selected', 'false');
  activeOption = el;
  if (el) {
    el.classList.add('active');
    el.setAttribute('aria-selected', 'true');
    q.setAttribute('aria-activedescendant', el.id);
    el.scrollIntoView({ block: 'nearest' });
  } else q.removeAttribute('aria-activedescendant');
}
function moveActive(d) {
  const opts = visibleOptions();
  if (!opts.length) return;
  const i = opts.indexOf(activeOption);
  setActive(opts[i < 0 ? (d > 0 ? 0 : opts.length - 1) : (i + d + opts.length) % opts.length]);
}

let searchTimer;
let searchSeq = 0;
let searchAbort;
async function runSearch(term) {
  term = term.trim();
  const seq = ++searchSeq;
  searchAbort?.abort();
  $('palette-home').hidden = !!term;
  $('palette-results').hidden = !term;
  setActive(null);
  if (!term) return;

  // Library matches are instant.
  const needle = term.toLowerCase();
  const libHits = LIBRARY.filter((t) => t.title.toLowerCase().includes(needle));
  $('lib-results-section').hidden = !libHits.length;
  renderList($('lib-results'), libHits, pickTrack);

  const status = $('search-status');
  status.textContent = 'Searching…';
  searchAbort = new AbortController();

  const am = searchSongs(term, searchAbort.signal)
    .then((results) => {
      if (seq !== searchSeq) return;
      renderList($('am-results'), results, pickTrack);
      status.textContent = results.length ? '' : `No previews found for “${term}”. Try an artist name.`;
    })
    .catch((err) => {
      if (err.name === 'AbortError' || seq !== searchSeq) return;
      $('am-results').replaceChildren();
      status.textContent = "Search isn't reachable right now. Check your connection and try again.";
    });

  const spSection = $('sp-results-section');
  spSection.hidden = !spotify.isConnected();
  const spReq = spotify.isConnected()
    ? spotify.search(term).then((results) => {
      if (seq !== searchSeq) return;
      spSection.hidden = !results.length;
      renderList($('sp-results'), results, (list, i) => pickSpotify(list[i]));
    }).catch(() => { if (seq === searchSeq) spSection.hidden = true; })
    : null;
  await Promise.allSettled([am, spReq]);
}

function pickTrack(list, index) {
  closePalette();
  q.blur();
  playFrom(list, index);
}

/* ---------- Playback ---------- */
function playFrom(list, index) {
  queue = list;
  queueIndex = (index + list.length) % list.length;
  if (!started) begin(false);
  stopSpotify();
  audio.playTrack(queue[queueIndex]);
}
function next() {
  if (sp.on && sp.track) return spotifyAction(spotify.next);
  if (audio.mode === 'stream') return;
  playFrom(queue, queueIndex + 1);
}
function prev() {
  if (sp.on && sp.track) return spotifyAction(spotify.previous);
  if (audio.mode === 'stream') return;
  if (audio.currentTime > 3) audio.seek(0);
  else playFrom(queue, queueIndex - 1);
}
function togglePlay() {
  if (sp.on && sp.track) return spotifyAction(sp.playing ? spotify.pause : spotify.resume, { playing: !sp.playing });
  audio.toggle();
}

/* ---------- Spotify ---------- */
// While on, the ring listens to live computer audio and the player shows
// (and controls) what Spotify is playing.
const sp = { on: false, track: null, playing: false, progressMs: 0, stamp: 0, device: null, timer: 0 };

function spProgress() {
  return sp.progressMs + (sp.playing ? performance.now() - sp.stamp : 0);
}
async function spPoll() {
  try {
    const n = await spotify.nowPlaying();
    const changed = n.track?.id !== sp.track?.id;
    Object.assign(sp, { track: n.track, playing: n.playing, progressMs: n.progressMs, stamp: performance.now(), device: n.device });
    if (changed) renderNow();
    renderState();
  } catch (err) {
    toast(err.message);
    if (!spotify.isConnected()) {
      stopSpotify();
      updateSpotifyTile();
    }
  }
}
function startSpotify() {
  if (!spotify.spotifyAvailable || !spotify.isConnected() || sp.on) return;
  sp.on = true;
  body.classList.add('spotify');
  spPoll();
  clearInterval(sp.timer);
  sp.timer = setInterval(spPoll, 4000);
  updateRecordPanel();
}
function stopSpotify() {
  if (!sp.on) return;
  sp.on = false;
  sp.track = null;
  body.classList.remove('spotify');
  clearInterval(sp.timer);
  renderNow();
  updateRecordPanel();
}
async function spotifyAction(fn, optimistic) {
  if (optimistic) Object.assign(sp, optimistic, { progressMs: spProgress(), stamp: performance.now() });
  renderState();
  try {
    await fn();
  } catch (err) {
    toast(err.message);
  }
  setTimeout(spPoll, 500);
}

async function listenWithSpotify() {
  if (!spotify.isConnected()) {
    spotify.connect();
    return;
  }
  if (audio.mode !== 'stream') {
    const ok = await goLive(AudioEngine.canCaptureDisplay ? 'system' : 'input');
    if (!ok) return;
  }
  startSpotify();
  closePalette();
}

async function pickSpotify(track) {
  closePalette();
  q.blur();
  if (audio.mode !== 'stream') {
    // goLive asks for capture synchronously, so this still counts as the click.
    const ok = await goLive(AudioEngine.canCaptureDisplay ? 'system' : 'input');
    if (!ok) return;
  }
  startSpotify();
  await spotifyAction(() => spotify.playUri(track.uri), { track, playing: true, progressMs: 0 });
  renderNow();
}

function updateSpotifyTile() {
  const tile = $('tile-spotify');
  tile.hidden = !spotify.spotifyAvailable;
  if (!spotify.spotifyAvailable) return;
  const connected = spotify.isConnected();
  $('spotify-tile-text').textContent = connected
    ? 'Connected. Shows and controls what Spotify plays while the ring listens to your computer.'
    : 'Connect to see and control what’s playing. Needs computer audio for the visual.';
  tile.setAttribute('aria-pressed', String(sp.on));
  let dc = $('sp-disconnect');
  if (!dc) {
    dc = Object.assign(document.createElement('button'), { id: 'sp-disconnect', className: 'text-btn', textContent: 'Disconnect Spotify' });
    dc.addEventListener('click', () => {
      spotify.disconnect();
      stopSpotify();
      updateSpotifyTile();
      toast('Spotify disconnected.');
    });
    $('inputs').before(dc);
  }
  dc.hidden = !connected;
}

/* ---------- Live sources ---------- */
// Called straight from click handlers: the capture request must happen before any
// other await, or browsers stop treating it as a user gesture.
async function goLive(kind, deviceId) {
  if (!started) begin(false);
  try {
    if (kind === 'input') await audio.useInput(deviceId);
    else await audio.useDisplayAudio(kind);
    closePalette();
    const msg = { tab: 'Listening to the shared tab.', system: 'Listening to your computer’s audio.', input: `Listening to ${audio.track.title}.` };
    toast(msg[kind]);
    if (kind === 'input') refreshInputs();
    return true;
  } catch (err) {
    toast(liveError(kind, err), 7000);
    return false;
  }
}

// Browsers report a user cancel, an OS-level block and an unsupported context with
// the same error name, so tell them apart by message.
function liveError(kind, err) {
  console.warn('[ring] live audio failed:', err.name, err.message);
  const msg = String(err.message || '');
  const display = kind !== 'input';
  if (err.name === 'NotAllowedError' && /by system/i.test(msg)) {
    return display
      ? 'macOS is blocking screen sharing for this browser. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the browser.'
      : 'macOS is blocking the microphone for this browser. Allow it in System Settings → Privacy & Security → Microphone.';
  }
  if (err.name === 'NotAllowedError' && /user agent|platform|context|gesture|activation/i.test(msg)) {
    return 'This browser blocked the request. Try Chrome or Edge on a computer.';
  }
  if (err.name === 'NotAllowedError') {
    if (kind === 'tab') return 'Sharing didn’t start. Pick the tab, turn on “Share tab audio”, then click Share.';
    if (kind === 'system') return 'Sharing didn’t start. Pick “Entire screen”, turn on “Share system audio”, then click Share.';
    return 'Microphone access is blocked. Allow it in your browser’s site settings.';
  }
  if (err.name === 'NotFoundError') return 'No audio input found.';
  if (err.name === 'NotSupportedError' || err.name === 'TypeError' || err.name === 'InvalidStateError') {
    return 'This browser can’t share audio. Try Chrome or Edge on a computer.';
  }
  if (err.name === 'NotReadableError' || err.name === 'AbortError') {
    return 'The browser couldn’t start capturing. Close other apps using the screen or microphone and try again.';
  }
  return err.message || 'Couldn’t start live audio.';
}

async function refreshInputs() {
  const list = await AudioEngine.listInputs().catch(() => []);
  const labelled = list.filter((d) => d.label);
  const wrap = $('inputs');
  wrap.hidden = !labelled.length; // labels only appear after the first permission
  if (!labelled.length) return;
  const current = audio.streamKind === 'input' ? audio.stream?.getAudioTracks()[0]?.getSettings().deviceId : '';
  const select = $('input-select');
  select.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: 'Choose an input…', disabled: true, selected: !current }),
    ...labelled.map((d) => Object.assign(document.createElement('option'), { value: d.deviceId, textContent: d.label, selected: d.deviceId === current })),
  );
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
  closePalette();
  playFrom(tracks, 0);
}

/* ---------- Player rendering ---------- */
let seeking = false;
function renderState() {
  const spOn = sp.on && sp.track;
  const isLive = audio.mode === 'stream';
  const playing = spOn ? sp.playing : audio.playing;
  body.classList.toggle('playing', playing);
  body.classList.toggle('loading', !spOn && audio.loading);
  body.classList.toggle('live', isLive && !spOn);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const noTransport = isLive && !spOn;
  $('prev').disabled = $('next').disabled = $('play').disabled = noTransport || (!spOn && audio.mode === 'idle');
  $('stop-live').hidden = !isLive;
  if (seeking) return;
  const d = spOn ? sp.track.durationMs / 1000 : audio.duration;
  const t = spOn ? Math.min(spProgress() / 1000, d) : audio.currentTime;
  $('time').textContent = fmtTime(t);
  $('duration').textContent = fmtTime(d);
  $('seek').value = d ? (t / d) * 1000 : 0;
  setFill($('seek'));
  if ('mediaSession' in navigator && audio.duration && audio.mode === 'element') {
    try {
      navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 });
    } catch { /* not supported */ }
  }
}

function renderNow() {
  const spOn = sp.on && sp.track;
  const track = spOn ? sp.track : audio.track;
  $('title').textContent = track?.title ?? 'Nothing playing';
  let sub = track?.subtitle ?? '';
  if (spOn) sub = sp.device ? `${sub} on ${sp.device}` : sub;
  else if (track?.preview) sub = `${sub} (preview)`;
  $('subtitle').textContent = sub;
  const art = $('art');
  art.style.backgroundImage = track?.artwork ? `url("${track.artwork}")` : '';
  art.classList.toggle('has-art', !!track?.artwork);
  const link = $('store-link');
  link.hidden = !track?.link;
  if (track?.link) {
    link.href = track.link;
    link.textContent = spOn ? 'Open in Spotify' : 'Apple Music';
  }
  document.title = track ? `${track.title} · ring` : 'ring';
  markCurrent();
  updateSpotifyTile();
  renderState();
  if ('mediaSession' in navigator && track && !spOn) {
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
// Live sources that stay silent get a hint after a few seconds.
const live = { since: 0, heard: false, warned: false };
const SILENCE_HINTS = {
  system: 'The ring is listening, but no sound is coming through. If the music plays in this browser (SoundCloud, YouTube), choose “A browser tab” instead. Otherwise share again with “Share system audio” on.',
  tab: 'No sound from the shared tab yet. Press play there, and make sure “Share tab audio” was on.',
  input: 'No sound from this input yet. Check its level, or pick another input.',
};

audio.addEventListener('track', (e) => {
  const track = e.detail;
  ensureMilk();
  if (audio.mode === 'stream') Object.assign(live, { since: performance.now(), heard: false, warned: false });
  if (audio.mode === 'stream' && spotify.isConnected()) startSpotify();
  if (audio.mode !== 'stream') stopSpotify();
  if (audio.mode === 'element') pushRecent(track);
  renderNow();
});
audio.addEventListener('ended', next);
audio.addEventListener('error', (e) => toast(e.detail.message));
audio.addEventListener('streamended', () => {
  stopSpotify();
  renderNow();
  toast('Stopped listening to live audio.');
});

if ('mediaSession' in navigator) {
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
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ }
  }
}

/* ---------- Recording ---------- */
let recFormat = 'screen';
let clipUrl = null;
const formatPicker = segmented(Object.entries(FORMATS).map(([k, f]) => [k, f.label]), (v) => {
  recFormat = v;
  formatPicker.select(v);
}, 'Frame');
$('formats').replaceWith(formatPicker);
formatPicker.id = 'formats';
formatPicker.select(recFormat);

function updateRecordPanel() {
  const sw = $('rec-audio');
  const note = $('rec-note');
  if (!canRecord()) {
    $('rec-start').disabled = true;
    note.textContent = 'This browser can’t record video. Try Chrome, Edge or Safari on a computer.';
    return;
  }
  if (sp.on) {
    sw.checked = false;
    sw.disabled = true;
    note.textContent = 'Spotify doesn’t allow its music in videos, so clips made while Spotify plays are silent.';
  } else {
    sw.disabled = false;
    note.textContent = 'Records the visual only, never the controls. Up to 10 minutes.';
  }
}

async function startRecording() {
  if (recorder.active) return;
  if (!canRecord()) return toast('This browser can’t record video.');
  if (!started) begin();
  discardClip();
  const size = FORMATS[recFormat].size;
  vis.holdResolution = true;
  vis.setFixedSize(size);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const canvas = $('stage');
  const withAudio = $('rec-audio').checked && !sp.on && audio.recordingStream;
  try {
    recorder.start(canvas, withAudio ? audio.recordingStream : null, { width: canvas.width, height: canvas.height });
  } catch (err) {
    vis.setFixedSize(null);
    vis.holdResolution = false;
    toast(`Recording failed to start: ${err.message}`);
    return;
  }
  setSide('record', false);
  body.classList.add('recording');
  $('rec-pill').hidden = false;
  $('rec-time').textContent = '0:00';
}

async function stopRecording() {
  if (!recorder.active) return;
  const clip = await recorder.stop();
  body.classList.remove('recording');
  $('rec-pill').hidden = true;
  vis.setFixedSize(null);
  vis.holdResolution = false;
  showClip(clip);
}

function showClip({ blob, ext, seconds }) {
  clipUrl = URL.createObjectURL(blob);
  const title = (sp.on && sp.track ? sp.track.title : audio.track?.title) || 'ring';
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const name = `ring-${slug}-${stamp}.${ext}`;
  const video = $('clip-video');
  video.src = clipUrl;
  video.play().catch(() => {});
  $('clip-meta').textContent = `${fmtTime(seconds)}, ${(blob.size / 1e6).toFixed(1)} MB, ${ext.toUpperCase()}`;
  const save = $('clip-save');
  save.href = clipUrl;
  save.download = name;
  const file = new File([blob], name, { type: blob.type });
  const share = $('clip-share');
  share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  share.onclick = () => navigator.share({ files: [file], title: 'ring' }).catch(() => {});
  $('clip').hidden = false;
  setSide('record', true);
}

function discardClip() {
  if (clipUrl) URL.revokeObjectURL(clipUrl);
  clipUrl = null;
  $('clip-video').removeAttribute('src');
  $('clip').hidden = true;
}

/* ---------- Style from a reference ---------- */
// Images and videos are analysed in the browser and applied at once; when AI
// styles are available, Claude then refines the look. Links and descriptions
// need Claude.
let styleUndo = null;
let styleAbort = null;
let aiOn = false;
let lastVisual = null; // { kind, images, measurements } from the latest image or video

function paletteAt(stops, p) {
  const t = 1 - Math.abs(2 * (((p % 1) + 1) % 1) - 1);
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const c = (h, k) => parseInt(h.slice(1 + k * 2, 3 + k * 2), 16);
  const mix = [0, 1, 2].map((k) => Math.round(c(stops[i], k) + (c(stops[i + 1], k) - c(stops[i], k)) * f));
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function styleNote(text) {
  $('style-note').textContent = text || '';
}

function applyStyle(style, why) {
  styleUndo = styleUndo || settings;
  applySettings({ ...DEFAULTS, ...style.settings, colorMode: 'palette', palette: style.palette, background: style.background });
  $('style-swatches').replaceChildren(...settings.palette.map((c) => {
    const i = document.createElement('i');
    i.style.background = c;
    return i;
  }));
  $('style-name').textContent = style.name || 'Your style';
  $('style-why').textContent = why || style.why || '';
  $('style-result').hidden = false;
}

async function refineWithClaude(request, label) {
  styleAbort?.abort();
  styleAbort = new AbortController();
  body.classList.add('styling');
  styleNote(label);
  try {
    const style = await aiStyle(request, styleAbort.signal);
    applyStyle(style);
    styleNote('');
    return true;
  } catch (err) {
    if (err.name !== 'AbortError') styleNote(err.message);
    return false;
  } finally {
    body.classList.remove('styling');
  }
}

async function styleFromFile(file) {
  if (!started) begin(false);
  setSide('style', true);
  const isVideo = file.type.startsWith('video/');
  styleNote(isVideo ? 'Reading the video…' : 'Reading the image…');
  styleUndo = null;
  try {
    const result = isVideo ? await styleFromVideo(file) : await styleFromImage(file);
    const zone = $('style-drop');
    zone.classList.toggle('has-preview', !!result.preview);
    if (result.preview) zone.style.setProperty('--preview', `url("${result.preview}")`);
    applyStyle(result.style, `From the ${isVideo ? 'video' : 'image'}’s colours, contrast and detail.`);
    lastVisual = { kind: isVideo ? 'video frames' : 'image', images: result.images, measurements: describeStats(result.stats) };
    styleNote('');
    if (aiOn && $('style-ai').checked) {
      await refineWithClaude({ ...lastVisual, prompt: $('style-prompt').value.trim() }, 'Claude is refining it…');
    }
  } catch (err) {
    styleNote(err.message || 'That file couldn’t be read.');
  }
}

async function createStyle() {
  const url = $('style-url').value.trim();
  const prompt = $('style-prompt').value.trim();
  if (!url && !prompt) {
    if (lastVisual && aiOn) return refineWithClaude({ ...lastVisual }, 'Claude is refining it…');
    styleNote('Drop an image or video, paste a link, or describe a mood.');
    return;
  }
  if (!aiOn) {
    styleNote('Links and descriptions need AI styles, which aren’t set up on this site yet. Images and videos work without it.');
    return;
  }
  if (!started) begin(false);
  styleUndo = null;
  // A description alongside a dropped image refines that image's style.
  const withVisual = prompt && !url && lastVisual ? lastVisual : {};
  await refineWithClaude(
    { kind: url ? 'website or image link' : withVisual.kind || 'description', ...withVisual, url: url || undefined, prompt: prompt || undefined },
    url ? 'Reading the site and asking Claude…' : 'Asking Claude…',
  );
}

function setupStylePanel() {
  const zone = $('style-drop');
  const input = $('style-file');
  input.addEventListener('change', () => {
    if (input.files[0]) styleFromFile(input.files[0]);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', () => zone.classList.remove('over'));
  $('style-go').addEventListener('click', createStyle);
  $('style-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      createStyle();
    }
  });
  $('style-url').addEventListener('keydown', (e) => e.key === 'Enter' && createStyle());
  $('style-undo').addEventListener('click', () => {
    if (!styleUndo) return;
    applySettings(styleUndo);
    styleUndo = null;
    $('style-result').hidden = true;
    styleNote('Back to the previous look.');
  });
  $('style-copy').addEventListener('click', shareLink);

  // Paste an image (or a link while the panel is open) anywhere.
  window.addEventListener('paste', (e) => {
    const t = e.target;
    if (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range')) return;
    const file = [...(e.clipboardData?.files || [])].find((f) => /^(image|video)\//.test(f.type));
    if (file) {
      e.preventDefault();
      styleFromFile(file);
      return;
    }
    const text = e.clipboardData?.getData('text')?.trim();
    if (text && /^https?:\/\//.test(text) && !$('style').hidden) {
      e.preventDefault();
      $('style-url').value = text;
      createStyle();
    }
  });

  aiAvailable().then((ok) => {
    aiOn = ok;
    $('style-ai-row').hidden = !ok;
    if (!ok) {
      $('style-url').disabled = $('style-prompt').disabled = true;
      $('style-url').placeholder = 'Needs AI styles';
      $('style-prompt').placeholder = 'Needs AI styles';
      styleNote('Images and videos are styled right here. Links and descriptions need AI styles, which aren’t set up on this site yet.');
    }
  });
}

/* ---------- Start screen ---------- */
const search = $('search');
$('start-slot').append(search);

function begin(play = true) {
  if (started) return;
  started = true;
  body.classList.add('started');
  $('start').classList.add('gone');
  const hadFocus = document.activeElement === q;
  $('top-slot').append(search);
  if (hadFocus) q.focus();
  audio.unlock().then(ensureMilk);
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
    const open = !$('tune').hidden || !$('record').hidden || !$('style').hidden || !palette.hidden || $('keys').open;
    const typing = document.activeElement?.tagName === 'INPUT' && document.activeElement.type !== 'range';
    if (started && (audio.playing || sp.playing) && !open && !typing) body.classList.add('idle');
  }, 3200);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ---------- Wire up ---------- */
buildParams();
applySettings(settings);
setupStylePanel();
renderHome();
renderNow();
updateRecordPanel();

if (shared.track?.startsWith('lib:')) {
  pendingTrack = LIBRARY.find((t) => t.shareId === shared.track) || pendingTrack;
} else if (shared.track?.startsWith('it:')) {
  lookupSong(shared.track.slice(3)).then((t) => {
    if (t) pendingTrack = t;
  }).catch(() => {});
}

spotify.completeConnect().then((done) => {
  if (done) toast('Spotify connected. Choose “Visualise my computer’s audio” to start.', 6000);
  updateSpotifyTile();
}).catch((err) => toast(err.message));

$('start-btn').addEventListener('click', () => begin());
// Opens the source tiles, so people pick a tab (music in this browser) or
// computer audio (desktop apps) rather than guessing.
$('start-system').addEventListener('click', () => {
  if (spotify.isConnected()) return listenWithSpotify();
  begin(false);
  openPalette();
});
if (!AudioEngine.canCaptureDisplay && !AudioEngine.canUseInput) $('start-system').hidden = true;

$('play').addEventListener('click', togglePlay);
$('next').addEventListener('click', next);
$('prev').addEventListener('click', prev);
$('stop-live').addEventListener('click', () => {
  stopSpotify();
  audio.stopLive();
});
$('tune-toggle').addEventListener('click', () => toggleSide('tune'));
$('style-toggle').addEventListener('click', () => toggleSide('style'));
$('record-toggle').addEventListener('click', () => (recorder.active ? stopRecording() : toggleSide('record')));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => setSide(b.dataset.close, false)));
$('randomize').addEventListener('click', randomize);
$('reset').addEventListener('click', () => applySettings(DEFAULTS));
$('share').addEventListener('click', shareLink);
const showKeys = () => { if (!$('keys').open) $('keys').showModal(); };
$('help').addEventListener('click', showKeys);
$('keys').querySelector('[data-close-dialog]').addEventListener('click', () => $('keys').close());
$('keys').addEventListener('click', (e) => { if (e.target === $('keys')) $('keys').close(); });
$('rec-start').addEventListener('click', startRecording);
$('rec-stop').addEventListener('click', stopRecording);
$('clip-discard').addEventListener('click', discardClip);

if (!document.fullscreenEnabled) $('fullscreen').hidden = true;
$('fullscreen').addEventListener('click', toggleFullscreen);

const seek = $('seek');
seek.addEventListener('input', () => {
  seeking = true;
  setFill(seek);
  const d = sp.on && sp.track ? sp.track.durationMs / 1000 : audio.duration;
  $('time').textContent = fmtTime((seek.value / 1000) * d);
});
seek.addEventListener('change', () => {
  seeking = false;
  if (sp.on && sp.track) {
    const ms = (seek.value / 1000) * sp.track.durationMs;
    spotifyAction(() => spotify.seek(ms), { progressMs: ms });
  } else audio.seek((seek.value / 1000) * audio.duration);
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

// Search box
q.addEventListener('focus', openPalette);
q.addEventListener('click', openPalette);
let slashFocus = false;
q.addEventListener('input', () => {
  // Some input methods still deliver the '/' that opened search: drop it.
  if (slashFocus && q.value === '/') q.value = '';
  slashFocus = false;
  openPalette();
  search.classList.toggle('has-text', !!q.value);
  clearTimeout(searchTimer);
  const term = q.value;
  if (!term.trim()) runSearch('');
  else searchTimer = setTimeout(() => runSearch(term), 280);
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    openPalette();
    moveActive(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = activeOption || (q.value.trim() ? visibleOptions()[0] : null);
    if (target) target.pick();
    else if (q.value.trim()) {
      clearTimeout(searchTimer);
      runSearch(q.value);
    }
  } else if (e.key === 'Escape') {
    if (q.value && palette.hidden) q.value = '';
    closePalette();
    q.blur();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!search.contains(e.target)) closePalette();
});

$('tile-files').querySelector('input').addEventListener('change', (e) => {
  playFiles(e.target.files);
  e.target.value = '';
});
for (const [id, kind] of [['tile-tab', 'tab'], ['tile-system', 'system']]) {
  const tile = $(id);
  if (!AudioEngine.canCaptureDisplay) {
    tile.disabled = true;
    tile.querySelector('span').textContent = 'Needs Chrome or Edge on a computer';
  }
  tile.addEventListener('click', () => goLive(kind));
}
const tileInput = $('tile-input');
if (!AudioEngine.canUseInput) tileInput.disabled = true;
tileInput.addEventListener('click', () => goLive('input', $('input-select').value || undefined));
$('input-select').addEventListener('change', (e) => goLive('input', e.target.value));
$('tile-spotify').addEventListener('click', listenWithSpotify);

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
  const visual = [...e.dataTransfer.files].find((f) => /^(image|video)\//.test(f.type));
  if (visual) styleFromFile(visual);
  else playFiles(e.dataTransfer.files);
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
  const typing = (tag === 'INPUT' && !['range', 'checkbox', 'file'].includes(type)) || tag === 'TEXTAREA' || tag === 'SELECT';
  if (typing) return;
  if (e.key === '/') {
    e.preventDefault();
    slashFocus = true;
    q.focus();
    return;
  }
  const onControl = tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'LABEL' || t.getAttribute('role') === 'option';
  const isRange = tag === 'INPUT' && type === 'range';
  if (!started && e.key !== 'Escape') return;

  switch (e.key) {
    case 'Enter':
      if (onControl) return;
      togglePlay();
      break;
    case ' ':
      if (onControl) return;
      if (sp.on && sp.track) spotifyAction(() => spotify.seek(0), { progressMs: 0 });
      else audio.seek(0);
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      if (isRange || t.getAttribute('role') === 'radio') return;
      audio.skip(e.key === 'ArrowLeft' ? -5 : 5);
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      if (isRange) return;
      nudgeVolume(e.key === 'ArrowUp' ? 0.1 : -0.1);
      break;
    case 'n': next(); break;
    case 'p': prev(); break;
    case 't': toggleSide('tune'); break;
    case 'v': recorder.active ? stopRecording() : startRecording(); break;
    case 's': setParam('mode', settings.mode === 'wave' ? 'spectrum' : 'wave'); break;
    case 'm': stepPreset(1); break;
    case 'r': randomize(); break;
    case 'f': toggleFullscreen(); break;
    case 'h': body.classList.toggle('hide-ui'); break;
    case '?': showKeys(); break;
    case 'Escape':
      if (!palette.hidden) closePalette();
      else if (!$('record').hidden) setSide('record', false);
      else if (!$('style').hidden) setSide('style', false);
      else if (!$('tune').hidden) setSide('tune', false);
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
let uiClock = 0;
const root = document.documentElement;
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  let wave = null;
  if (audio.sample(now)) wave = settings.mode === 'spectrum' ? audio.specData : audio.timeData;
  else if (audio.mode === 'idle') wave = synth(now / 1000);
  // A paused track leaves wave null, which freezes the tunnel so you can orbit it.
  if (milk.ready && vis.milkWanted) milk.render();
  vis.frame(dt, now, wave, audio.bass, audio.beat);

  uiClock += dt;
  if (uiClock > 0.12) {
    uiClock = 0;
    root.style.setProperty('--hue', String(Math.round(vis.hueStart)));
    if (settings.colorMode === 'palette') {
      const c = paletteAt(settings.palette, vis.hueStart / 360);
      root.style.setProperty('--accent', c);
      root.style.setProperty('--accent-soft', `${c}29`);
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-soft');
    }
    if (audio.mode === 'element' || sp.on) renderState();
    if (audio.mode === 'stream') {
      $('meter').style.setProperty('--lvl', `${Math.min(100, audio.level * 500).toFixed(0)}%`);
      if (audio.level > 0.01) live.heard = true;
      if (!live.heard && !live.warned && now - live.since > 5000) {
        live.warned = true;
        toast(SILENCE_HINTS[audio.streamKind] || SILENCE_HINTS.input, 12000);
      }
    }
    if (recorder.active) {
      $('rec-time').textContent = fmtTime(recorder.elapsed);
      if (recorder.elapsed >= MAX_SECONDS) stopRecording();
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if (import.meta.env.DEV) window.ring = { audio, vis, recorder, spotify, sp, get settings() { return settings; } };
