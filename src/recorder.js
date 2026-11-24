// Records the canvas (never the interface) plus the audio feeding the ring.
const TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export const FORMATS = {
  screen: { label: 'Screen', size: null },
  square: { label: 'Square', size: [1080, 1080] },
  vertical: { label: 'Vertical', size: [1080, 1920] },
  wide: { label: '1080p', size: [1920, 1080] },
};

export const MAX_SECONDS = 600;

export function canRecord() {
  return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream && TYPES.some((t) => MediaRecorder.isTypeSupported(t));
}

export class Recorder {
  constructor() {
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  get active() {
    return this.recorder?.state === 'recording';
  }
  get elapsed() {
    return this.active ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  start(canvas, audioStream, { width, height }) {
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const video = canvas.captureStream(60);
    const tracks = [...video.getVideoTracks()];
    if (audioStream) tracks.push(...audioStream.getAudioTracks().map((t) => t.clone()));
    this.stream = new MediaStream(tracks);
    // ~0.07 bits per pixel per frame (≈9 Mbps at 1080p60): crisp particles,
    // about 65 MB per minute.
    const videoBitsPerSecond = Math.round(Math.min(12e6, Math.max(5e6, width * height * 60 * 0.07)));
    this.recorder = new MediaRecorder(this.stream, { mimeType: type, videoBitsPerSecond, audioBitsPerSecond: 192e3 });
    this.type = this.recorder.mimeType || type;
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.done = new Promise((resolve) => {
      this.recorder.onstop = () => {
        this.stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(this.chunks, { type: this.type.split(';')[0] });
        resolve({ blob, ext: this.type.includes('mp4') ? 'mp4' : 'webm', seconds: (performance.now() - this.startedAt) / 1000 });
      };
    });
    this.recorder.start(1000);
    this.startedAt = performance.now();
  }

  stop() {
    if (this.active) this.recorder.stop();
    return this.done;
  }
}
