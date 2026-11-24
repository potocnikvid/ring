// MilkDrop (via Butterchurn) rendered off-screen; the visualizer uses its canvas
// as a live texture. Butterchurn and its presets load only when first needed.
import { MILK_PRESETS } from './milkdrop-presets.js';

const SIZE = 640;

export class MilkDrop {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.visualizer = null;
    this.presets = null;
    this.preset = null;
    this.loading = null;
  }

  get ready() {
    return !!this.visualizer;
  }

  static get supported() {
    return typeof WebGL2RenderingContext !== 'undefined';
  }

  // Loads Butterchurn and the preset pack, and starts listening to `audioNode`.
  load(audioContext, audioNode) {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const [bcMod, presetsMod] = await Promise.all([import('butterchurn'), import('butterchurn-presets')]);
      const unwrap = (m) => (m.default?.default ?? m.default ?? m);
      const butterchurn = unwrap(bcMod);
      const presets = unwrap(presetsMod);
      this.presets = presets.getPresets();
      this.visualizer = butterchurn.createVisualizer(audioContext, this.canvas, {
        width: SIZE,
        height: SIZE,
        pixelRatio: 1,
        textureRatio: 1,
      });
      this.visualizer.connectAudio(audioNode);
      if (this.pending) this.setPreset(this.pending, 0);
    })();
    return this.loading;
  }

  setPreset(name, blendSeconds = 2.5) {
    if (!MILK_PRESETS.includes(name)) return;
    if (!this.visualizer) {
      this.pending = name;
      return;
    }
    if (name === this.preset) return;
    this.preset = name;
    this.visualizer.loadPreset(this.presets[name], blendSeconds);
  }

  render() {
    if (this.visualizer) this.visualizer.render();
  }
}
