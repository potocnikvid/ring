// One analyser fed by either an <audio> element (library, catalog previews, local
// files) or a MediaStream (microphone, shared tab / system audio).
//
// The element streams with range requests instead of p5's loadSound(), which
// downloaded and decoded the whole MP3 (3–12 MB) before anything could play.
export const SAMPLES = 1024;

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.el = new Audio();
    this.el.crossOrigin = 'anonymous';
    this.el.preload = 'none';
    this.ctx = null;
    this.mode = 'idle'; // idle | element | stream
    this.track = null;
    this.stream = null;
    this.streamSource = null;
    this._volume = 0.5;
    this.timeData = new Uint8Array(SAMPLES);
    this.freqData = new Uint8Array(SAMPLES / 2);
    this.bass = 0;
    this._fast = 0;
    this._slow = 0;

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
      // Analyse before the volume stage so the ring still reacts when muted.
      this.elSource = this.ctx.createMediaElementSource(this.el);
      this.elSource.connect(this.analyser);
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

  async playTrack(track) {
    await this.unlock();
    this._stopStream();
    this.mode = 'element';
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

  async useMicrophone() {
    // Ask before any other await, while the click still counts as a user gesture.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    await this.unlock();
    this._useStream(stream, { id: 'mic', title: 'Microphone', subtitle: 'Live input' });
  }

  // Lets people visualise Spotify, YouTube, Apple Music… playing in another tab.
  async useTabAudio() {
    // Ask before any other await: browsers only allow this directly from a click.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    });
    await this.unlock();
    const audioTracks = stream.getAudioTracks();
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!audioTracks.length) {
      throw new Error('No audio came through. Pick a tab and turn on “Share tab audio”.');
    }
    const label = audioTracks[0].label || 'Shared audio';
    this._useStream(new MediaStream(audioTracks), { id: 'tab', title: 'Shared tab audio', subtitle: label });
  }

  static get canCaptureTab() {
    // Firefox, Safari and mobile browsers don't capture audio via getDisplayMedia.
    const ua = navigator.userAgent;
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
    return !!navigator.mediaDevices?.getDisplayMedia && !safari && !/Firefox|iPhone|iPad|Android/.test(ua);
  }
  static get canUseMic() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  _useStream(stream, track) {
    this.el.pause();
    this._stopStream();
    this.stream = stream;
    // Not connected to the speakers: the tab or room is already audible.
    this.streamSource = this.ctx.createMediaStreamSource(stream);
    this.streamSource.connect(this.analyser);
    this.mode = 'stream';
    this.track = track;
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (this.stream !== stream) return;
      this._stopStream();
      this.mode = 'idle';
      this._emit('state');
      this._emit('streamended');
    });
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

  // Fills timeData with the current waveform and updates the bass envelope.
  // Returns false when there's nothing live to read.
  sample() {
    if (!this.analyser || !this.playing) {
      this.bass *= 0.9;
      return false;
    }
    this.analyser.getByteTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);
    let sum = 0;
    for (let i = 1; i <= 8; i++) sum += this.freqData[i]; // ≈ 40–350 Hz
    const level = sum / (8 * 255);
    this._fast += (level - this._fast) * 0.5;
    this._slow += (level - this._slow) * 0.03;
    const kick = Math.min(1, Math.max(0, (this._fast - this._slow) * 4));
    this.bass = Math.max(kick, this.bass * 0.88);
    return true;
  }
}
