import {
  BoxGeometry, Color, DataTexture, IcosahedronGeometry, InstancedBufferAttribute, InstancedBufferGeometry,
  LinearFilter, Mesh, NearestFilter, PerspectiveCamera, PlaneGeometry, RGBAFormat, RedFormat, SRGBColorSpace, Scene,
  ShaderMaterial, UnsignedByteType, Vector2, WebGLRenderer,
} from 'three';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SAMPLES } from './audio.js';

export const MAX_RINGS = 100;
const MAX_INSTANCES = MAX_RINGS * SAMPLES;

// Each instance is one cube: (which ring in the history, which waveform sample).
// Everything else (radius, size, colour) is computed here on the GPU from the
// waveform history texture, the same maths ring v1 ran per box in JavaScript.
const SHAPES = { cube: 0, sphere: 1, dot: 2 };

const vertexShader = /* glsl */ `
  uniform sampler2D uHistory;
  uniform sampler2D uPalette;
  uniform float uHead, uLength, uDispersal, uRingSize, uSize, uSizeVar, uSpacing;
  uniform float uHueStart, uHueRange, uPulse, uBass, uFade;
  uniform float uSymmetry, uTwist, uShape, uUsePalette;
  attribute float aRing;
  attribute float aSample;
  varying vec3 vColor;
  varying vec2 vUv;
  varying float vShade;

  vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
  }

  void main() {
    // Symmetry folds the first half of the waveform into N mirrored petals.
    float lookup = aSample;
    if (uSymmetry > 0.5) {
      float seg = fract(aSample / ${SAMPLES}.0 * uSymmetry);
      lookup = (1.0 - abs(2.0 * seg - 1.0)) * (${SAMPLES}.0 * 0.5 - 1.0);
    }
    float row = mod(uHead - aRing + ${MAX_RINGS}.0, ${MAX_RINGS}.0);
    float s = texture2D(uHistory, vec2((lookup + 0.5) / ${SAMPLES}.0, (row + 0.5) / ${MAX_RINGS}.0)).r;

    float r = mix(150.0 / uDispersal * uRingSize, 250.0 * uDispersal * uRingSize, s);
    r *= 1.0 + uPulse * uBass * 0.25;
    float a = aSample / ${SAMPLES}.0 * 6.28318530718 + aRing * uTwist;
    float size = max(0.0, mix(uSize - uSize * uSizeVar, uSize + uSize * uSizeVar, s));
    vec3 center = vec3(r * cos(a), r * sin(a), -aRing * uSpacing);

    float t = uLength > 1.0 ? aRing / (uLength - 1.0) : 0.0;
    vec3 srgb;
    if (uUsePalette > 0.5) {
      // Walk the palette with depth; mirrored so the gradient never jumps.
      float p = fract(uHueStart / 360.0 + t * uHueRange / 360.0);
      srgb = texture2D(uPalette, vec2(1.0 - abs(2.0 * p - 1.0), 0.5)).rgb;
    } else {
      float hue = mod(uHueStart + t * uHueRange, 360.0) / 360.0;
      float sat = clamp((255.0 - size * 10.0) / 100.0, 0.0, 1.0);
      srgb = hsv2rgb(vec3(hue, sat, 1.0));
    }
    vColor = pow(srgb, vec3(2.2)) * (1.0 - uFade * t);
    vUv = uv;

    if (uShape > 1.5) {
      // Dots face the camera.
      vShade = 1.0;
      vec4 mv = modelViewMatrix * vec4(center, 1.0);
      mv.xy += position.xy * size * 1.3;
      gl_Position = projectionMatrix * mv;
    } else {
      vShade = 0.84 + 0.16 * dot(normal, vec3(0.27, 0.53, 0.8));
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position * size + center, 1.0);
    }
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOutline, uShape;
  varying vec3 vColor;
  varying vec2 vUv;
  varying float vShade;

  void main() {
    float k = 1.0;
    if (uShape > 1.5) {
      // Soft round dot.
      float d = length(vUv - 0.5) * 2.0;
      if (d > 1.0) discard;
      k = 1.0 - d * d * 0.55;
    } else if (uShape < 0.5) {
      // Dark cube edges, standing in for v1's black stroke.
      float e = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
      k = mix(1.0, smoothstep(0.06, 0.16, e), uOutline);
    }
    gl_FragColor = vec4(vColor * vShade * k, 1.0);
    #include <colorspace_fragment>
  }
`;

function shapeGeometry(shape) {
  if (shape === 'sphere') return new IcosahedronGeometry(0.62, 0);
  if (shape === 'dot') return new PlaneGeometry(1, 1);
  return new BoxGeometry(1, 1, 1);
}

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 1);
    this.maxDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = this.maxDpr;

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(50, 1, 1, 20000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 8000;
    this.userMoved = false;
    this.controls.addEventListener('start', () => (this.userMoved = true));
    canvas.addEventListener('dblclick', () => this.resetView());

    this.history = new Uint8Array(SAMPLES * MAX_RINGS).fill(128);
    this.historyTex = new DataTexture(this.history, SAMPLES, MAX_RINGS, RedFormat, UnsignedByteType);
    this.historyTex.minFilter = this.historyTex.magFilter = NearestFilter;
    this.historyTex.unpackAlignment = 1;
    this.historyTex.needsUpdate = true;
    this.head = 0;
    this.pushClock = 0;
    this.hueStart = 0;

    this.geometry = new InstancedBufferGeometry();
    this.setShape('cube');
    this.aRing = new InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
    this.aSample = new InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
    this.geometry.setAttribute('aRing', this.aRing);
    this.geometry.setAttribute('aSample', this.aSample);

    const u = (value) => ({ value });
    this.uniforms = {
      uHistory: u(this.historyTex), uHead: u(0), uLength: u(10), uDispersal: u(1.5), uRingSize: u(1),
      uSize: u(5), uSizeVar: u(0), uSpacing: u(20), uHueStart: u(0), uHueRange: u(90),
      uPulse: u(0), uBass: u(0), uFade: u(0), uOutline: u(1),
      uSymmetry: u(0), uTwist: u(0), uShape: u(0), uUsePalette: u(0), uPalette: u(null),
    };
    this.paletteData = new Uint8Array(256 * 4);
    this.paletteTex = new DataTexture(this.paletteData, 256, 1, RGBAFormat, UnsignedByteType);
    this.paletteTex.minFilter = this.paletteTex.magFilter = LinearFilter;
    this.uniforms.uPalette.value = this.paletteTex;
    this.paletteKey = '';
    const material = new ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.trails = new AfterimagePass(0);
    this.composer.addPass(this.trails);
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.6, 0.18, 0.32);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.fixedSize = null;
    this.baseFov = this.camera.fov;
    this.spin = 0;
    this.punch = 0;
    this.layoutKey = '';
    this.frameMs = 16.7;
    this.lastDprChange = 0;
    // Observe the canvas itself: it can start at 0×0 (background tab, hidden pane)
    // and window 'resize' doesn't always follow.
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setShape(shape) {
    if (shape === this.shape) return;
    this.shape = shape;
    const g = shapeGeometry(shape);
    this.geometry.setIndex(g.index);
    for (const name of ['position', 'normal', 'uv']) this.geometry.setAttribute(name, g.getAttribute(name));
    this.geometry.computeBoundingSphere?.();
  }

  // Bakes the palette into a 256-step gradient texture.
  setPalette(stops) {
    const key = stops.join();
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    // Stored as sRGB bytes; the shader converts to linear.
    const cols = stops.map((h) => ({
      r: parseInt(h.slice(1, 3), 16) / 255,
      g: parseInt(h.slice(3, 5), 16) / 255,
      b: parseInt(h.slice(5, 7), 16) / 255,
    }));
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * (cols.length - 1);
      const j = Math.min(cols.length - 2, Math.floor(x));
      const f = x - j;
      const a = cols[j];
      const b = cols[j + 1];
      this.paletteData.set([
        Math.round((a.r + (b.r - a.r) * f) * 255),
        Math.round((a.g + (b.g - a.g) * f) * 255),
        Math.round((a.b + (b.b - a.b) * f) * 255),
        255,
      ], i * 4);
    }
    this.paletteTex.needsUpdate = true;
  }

  apply(s) {
    const u = this.uniforms;
    this.setShape(s.shape);
    u.uShape.value = SHAPES[s.shape] ?? 0;
    u.uSymmetry.value = s.symmetry;
    u.uTwist.value = s.twist;
    u.uUsePalette.value = s.colorMode === 'palette' ? 1 : 0;
    this.setPalette(s.palette);
    // The effect composer's render target colour-manages the clear colour once
    // more than the screen does, so it gets a pre-compensated copy.
    this.bgDirect = new Color(s.background);
    this.bgComposer = new Color().setRGB(this.bgDirect.r, this.bgDirect.g, this.bgDirect.b, SRGBColorSpace);
    this.clearPath = null;
    this.trails.damp = s.trails;
    this.trails.enabled = s.trails > 0;
    u.uLength.value = s.length;
    u.uDispersal.value = s.dispersal;
    u.uRingSize.value = s.ringSize;
    u.uSize.value = s.particleSize;
    u.uSizeVar.value = s.sizeVar;
    u.uSpacing.value = s.spacing;
    u.uHueRange.value = s.hueRange;
    u.uPulse.value = s.pulse;
    u.uFade.value = s.fade;
    u.uOutline.value = s.outline ? 1 : 0;
    this.bloom.strength = s.glow;
    this.bloom.enabled = s.glow > 0;
    this.controls.autoRotate = s.autoRotate > 0;
    this.controls.autoRotateSpeed = s.autoRotate;
    this.settings = s;

    // Detail 18 → every 3rd sample, as in v1 (map(detail, 1, 20, 20, 1)).
    const step = 21 - s.detail;
    const length = Math.round(s.length);
    const key = `${step}:${length}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const perRing = Math.ceil(SAMPLES / step);
    const count = perRing * length;
    const ring = this.aRing.array;
    const sample = this.aSample.array;
    for (let k = 0; k < count; k++) {
      ring[k] = Math.floor(k / perRing);
      sample[k] = (k % perRing) * step;
    }
    this.aRing.addUpdateRange(0, count);
    this.aSample.addUpdateRange(0, count);
    this.aRing.needsUpdate = this.aSample.needsUpdate = true;
    this.geometry.instanceCount = count;
  }

  // On each beat: a spin impulse on the ring and a quick zoom punch.
  _beatMotion(dt, beat) {
    const amount = this.settings.beatMotion;
    if (beat && amount > 0) {
      this.spin += (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.6) * amount;
      this.punch = Math.max(this.punch, 0.09 * amount);
    }
    if (Math.abs(this.spin) > 1e-4) {
      this.mesh.rotation.z += this.spin * dt;
      this.spin *= Math.exp(-dt * 2.5);
    }
    if (this.punch > 1e-4 || this.camera.fov !== this.baseFov) {
      this.punch *= Math.exp(-dt * 7);
      this.camera.fov = this.baseFov * (1 - this.punch);
      this.camera.updateProjectionMatrix();
    }
  }

  get particleCount() {
    return this.geometry.instanceCount;
  }

  // Adds one waveform frame (bytes, 128 = silence) as the newest ring.
  push(wave) {
    this.head = (this.head + 1) % MAX_RINGS;
    this.history.set(wave, this.head * SAMPLES);
    this.historyTex.needsUpdate = true;
    this.uniforms.uHead.value = this.head;
  }

  fit() {
    // Typical outer radius of the ring at default settings, with some breathing room.
    const radius = 380;
    const vfov = (this.camera.fov * Math.PI) / 180;
    let dist = radius / Math.tan(vfov / 2);
    if (this.camera.aspect < 1) dist /= this.camera.aspect;
    this.camera.position.set(0, 0, dist * 1.12);
    this.controls.target.set(0, 0, 0);
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
  }

  resetView() {
    this.userMoved = false;
    this.fit();
  }

  // Renders at an exact pixel size (for recording square / vertical clips);
  // the canvas is letterboxed on screen. null returns to filling the window.
  setFixedSize(size) {
    this.fixedSize = size;
    this.canvas.classList.toggle('framed', !!size);
    if (size) this.canvas.style.setProperty('--ar', String(size[0] / size[1]));
    else this.canvas.style.removeProperty('--ar');
    this.userMoved = false;
    this.resize();
  }

  resize() {
    const fixed = this.fixedSize;
    const w = fixed ? fixed[0] : this.canvas.clientWidth;
    const h = fixed ? fixed[1] : this.canvas.clientHeight;
    const dpr = fixed ? 1 : this.dpr;
    this.width = w;
    this.height = h;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    if (!this.userMoved) this.fit();
  }

  // Drops resolution when frames run long, and recovers when there's headroom.
  _adapt(dt, now) {
    // Ignore stalls and throttled background frames: they say nothing about render cost.
    if (document.hidden || dt > 0.07 || this.fixedSize || this.holdResolution) return;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    if (now - this.lastDprChange < 2500) return;
    if (this.frameMs > 24 && this.dpr > 0.75) {
      this.dpr = Math.max(0.75, this.dpr - 0.25);
    } else if (this.frameMs < 17.5 && this.dpr < this.maxDpr && now - this.lastDprChange > 8000) {
      this.dpr = Math.min(this.maxDpr, this.dpr + 0.25);
    } else return;
    this.lastDprChange = now;
    this.resize();
  }

  // wave: Uint8Array to record this frame, or null to freeze the tunnel.
  frame(dt, now, wave, bass, beat = false) {
    this._adapt(dt, now);
    dt = Math.min(dt, 0.1);
    this._beatMotion(dt, beat);
    // Record at most 60 rings per second so the tunnel is the same length on 120 Hz screens.
    this.pushClock += dt;
    if (wave && this.pushClock >= 1 / 61) {
      this.pushClock = 0;
      this.push(wave);
    }
    this.hueStart = (this.hueStart + this.settings.hueSpeed * dt * 60) % 360;
    this.uniforms.uHueStart.value = this.hueStart;
    this.uniforms.uBass.value = bass;
    this.controls.update(dt);
    if (!this.width || !this.height) return;
    const composed = this.bloom.enabled || this.trails.enabled;
    if (composed !== this.clearPath) {
      this.renderer.setClearColor(composed ? this.bgComposer : this.bgDirect, 1);
      this.clearPath = composed;
    }
    if (composed) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
