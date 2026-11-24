// One analyser fed by either an <audio> element (library, catalog previews, local
// files) or a MediaStream (microphone / audio input, shared tab, whole-computer audio).
//
// The element streams with range requests instead of p5's loadSound(), which
// downloaded and decoded the whole file before anything could play.
export const SAMPLES = 1024;

const RAW_INPUT = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.el = new Audio();
    this.el.crossOrigin = 'anonymous';
    this.el.preload = 'none';
    this.ctx = null;
    this.mode = 'idle'; // idle | element | stream
    this.streamKind = null; // input | tab | system
    this.track = null;
    this.stream = null;
    this.streamSource = null;
    this._volume = 0.5;
    this.timeData = new Uint8Array(SAMPLES);
    this.freqData = new Uint8Array(SAMPLES / 2);
    this.specData = new Uint8Array(SAMPLES).fill(128);
    this.bass = 0;
    this.level = 0;
    this.beat = false;
    this._fast = 0;
    this._slow = 0;
    this._lastBeat = 0;
    this._specMap = buildSpectrumMap();

    for (const ev of ['play', 'pause', 'timeupdate', 'durationchange', 'waiting', 'playing', 'loadstart']) {
      this.el.addEventListener(ev, () => this._emit('state'));
    }
    this.el.addEventListener('ended', () => this._emit('ended'));
    this.el.addEventListener('error', () => {
      if (!this.el.getAttribute('src')) return;
      this._emit('error', { message: `Couldn't play “${this.track?.title ?? 'this track'}”.` });
    });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // Must run inside a user gesture: browsers keep audio locked until then.
  async unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = SAMPLES;
      this.analyser.smoothingTimeConstant = 0.8;
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this._volume;
      // Recording tap: taken before the volume stage, like the analyser,
      // so a muted tab still records at full level.
      this.recordTap = this.ctx.createMediaStreamDestination();
      // Every source also feeds this node, so extra listeners (MilkDrop) connect
      // once and keep hearing whatever plays.
      this.tap = this.ctx.createGain();
      this.elSource = this.ctx.createMediaElementSource(this.el);
      this.elSource.connect(this.tap);
      this.elSource.connect(this.analyser);
      this.elSource.connect(this.recordTap);
      this.elSource.connect(this.gain);
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  get playing() {
    if (this.mode === 'stream') return true;
    return this.mode === 'element' && !this.el.paused;
  }
  get loading() {
    return this.mode === 'element' && !this.el.paused && this.el.readyState < 3;
  }
  get currentTime() {
    return this.el.currentTime || 0;
  }
  get duration() {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }
  get volume() {
    return this._volume;
  }
  set volume(v) {
    this._volume = Math.min(1, Math.max(0, v));
    if (this.gain) this.gain.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.02);
    this._emit('state');
  }
  get recordingStream() {
    return this.recordTap?.stream ?? null;
  }

  async playTrack(track) {
    await this.unlock();
    this._stopStream();
    this.mode = 'element';
    this.streamKind = null;
    this.track = track;
    this.el.src = track.src;
    this._emit('track', track);
    try {
      await this.el.play();
    } catch (err) {
      if (err.name !== 'AbortError') this._emit('error', { message: `Couldn't play “${track.title}”.` });
    }
  }

  async play() {
    if (this.mode !== 'element') return;
    await this.unlock();
    await this.el.play().catch(() => {});
  }
  pause() {
    if (this.mode === 'element') this.el.pause();
  }
  toggle() {
    if (this.mode === 'element') this.el.paused ? this.play() : this.pause();
  }
  seek(t) {
    if (this.mode !== 'element' || !this.duration) return;
    this.el.currentTime = Math.min(this.duration - 0.05, Math.max(0, t));
  }
  skip(dt) {
    this.seek(this.currentTime + dt);
  }

  // Microphone, or any audio input: an audio interface, or a loopback device such
  // as BlackHole / Loopback that carries the computer's own sound.
  async useInput(deviceId) {
    // Ask before any other await, while the click still counts as a user gesture.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { ...RAW_INPUT, deviceId: { exact: deviceId } } : RAW_INPUT,
    });
    await this.unlock();
    const label = stream.getAudioTracks()[0]?.label || 'Microphone';
    this._useStream(stream, 'input', { id: 'input', title: label.replace(/\s*\([^)]*\)\s*$/, ''), subtitle: 'Live input' });
  }

  static async listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  }

  // kind 'tab': a browser tab (Spotify web player, YouTube…).
  // kind 'system': the whole screen with "Share system audio", which also covers
  // desktop apps (Chrome 141+ on macOS 14.2+, Chrome / Edge on Windows).
  async useDisplayAudio(kind) {
    // Ask before any other await: browsers only allow this directly from a click.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // The video is never shown, so ask for as little of it as possible.
      video: {
        displaySurface: kind === 'system' ? 'monitor' : 'browser',
        frameRate: { ideal: 1, max: 5 },
        width: { max: 640 },
        height: { max: 360 },
      },
      audio: RAW_INPUT,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
    });
    await this.unlock();
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        kind === 'system'
          ? 'No audio came through. Pick “Entire screen” and turn on “Share system audio”.'
          : 'No audio came through. Pick a tab and turn on “Share tab audio”.',
      );
    }
    // Keep the video track running (just disabled) for as long as we listen. On
    // macOS, Chrome captures computer audio through the same screen capture, and
    // stopping the video can leave the audio track live but silent.
    stream.getVideoTracks().forEach((t) => { t.enabled = false; });
    console.info('[ring] sharing', kind, audioTracks[0].label, audioTracks[0].getSettings());
    const title = kind === 'system' ? 'Computer audio' : 'Shared tab';
    this._useStream(stream, kind, { id: kind, title, subtitle: 'Live' });
  }

  static get canCaptureDisplay() {
    // Firefox, Safari and mobile browsers don't capture audio via getDisplayMedia.
    const ua = navigator.userAgent;
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
    return !!navigator.mediaDevices?.getDisplayMedia && !safari && !/Firefox|iPhone|iPad|Android/.test(ua);
  }
  static get canUseInput() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  stopLive() {
    if (this.mode !== 'stream') return;
    this._stopStream();
    this.mode = 'idle';
    this.streamKind = null;
    this.track = null;
    this._emit('track', null);
    this._emit('state');
  }

  _useStream(stream, kind, track) {
    this.el.pause();
    this._stopStream();
    this.stream = stream;
    // Not connected to the speakers: the tab, app or room is already audible.
    this.streamSource = this.ctx.createMediaStreamSource(stream);
    this.streamSource.connect(this.analyser);
    this.streamSource.connect(this.recordTap);
    this.streamSource.connect(this.tap);
    this.mode = 'stream';
    this.streamKind = kind;
    this.track = track;
    // Either track ending (e.g. the browser's "Stop sharing" bar) ends listening.
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.stopLive();
        this._emit('streamended');
      });
    }
    this._emit('track', track);
    this._emit('state');
  }

  _stopStream() {
    if (!this.stream) return;
    this.streamSource?.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.streamSource = null;
  }

  // Reads the analyser: waveform, spectrum, bass envelope and beats.
  // Returns false when there's nothing live to read.
  sample(now = performance.now()) {
    this.beat = false;
    if (!this.analyser || !this.playing) {
      this.bass *= 0.9;
      this.level = 0;
      return false;
    }
    this.analyser.getByteTimeDomainData(this.timeData);
    let sq = 0;
    for (let i = 0; i < SAMPLES; i += 4) {
      const v = this.timeData[i] - 128;
      sq += v * v;
    }
    const rms = Math.sqrt(sq / (SAMPLES / 4)) / 128;
    this.level += (rms - this.level) * 0.3;
    this.analyser.getByteFrequencyData(this.freqData);

    // Spectrum laid around the circle, mirrored so it stays symmetric, on a log
    // scale so bass and treble get similar room. Silence sits at the waveform's
    // resting radius and loud bins push outward.
    const map = this._specMap;
    for (let i = 0; i < SAMPLES; i++) this.specData[i] = 128 + (this.freqData[map[i]] * 127) / 255;

    let sum = 0;
    for (let i = 1; i <= 8; i++) sum += this.freqData[i]; // ≈ 40–350 Hz
    const level = sum / (8 * 255);
    this._fast += (level - this._fast) * 0.5;
    this._slow += (level - this._slow) * 0.03;
    const kick = Math.min(1, Math.max(0, (this._fast - this._slow) * 4));
    if (kick > 0.55 && this.bass < 0.5 && now - this._lastBeat > 280) {
      this.beat = true;
      this._lastBeat = now;
    }
    this.bass = Math.max(kick, this.bass * 0.88);
    return true;
  }
}

function buildSpectrumMap() {
  const bins = SAMPLES / 2;
  const lo = 2; // skip DC
  const hi = Math.floor(bins * 0.7); // the top of the range is mostly empty
  const map = new Uint16Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const half = i < SAMPLES / 2 ? i : SAMPLES - 1 - i; // mirror
    const x = half / (SAMPLES / 2 - 1);
    map[i] = Math.round(lo * Math.pow(hi / lo, x));
  }
  // Rotate so the bass sits at the bottom of the ring.
  const shift = SAMPLES / 4;
  return Uint16Array.from({ length: SAMPLES }, (_, i) => map[(i + shift) % SAMPLES]);
}
