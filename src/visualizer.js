import {
  BoxGeometry, DataTexture, InstancedBufferAttribute, InstancedBufferGeometry, Mesh,
  NearestFilter, PerspectiveCamera, RedFormat, Scene, ShaderMaterial, UnsignedByteType,
  Vector2, WebGLRenderer,
} from 'three';
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
const vertexShader = /* glsl */ `
  uniform sampler2D uHistory;
  uniform float uHead, uLength, uDispersal, uRingSize, uSize, uSizeVar, uSpacing;
  uniform float uHueStart, uHueRange, uPulse, uBass, uFade;
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
    float row = mod(uHead - aRing + ${MAX_RINGS}.0, ${MAX_RINGS}.0);
    float s = texture2D(uHistory, vec2((aSample + 0.5) / ${SAMPLES}.0, (row + 0.5) / ${MAX_RINGS}.0)).r;

    float r = mix(150.0 / uDispersal * uRingSize, 250.0 * uDispersal * uRingSize, s);
    r *= 1.0 + uPulse * uBass * 0.25;
    float a = aSample / ${SAMPLES}.0 * 6.28318530718;
    float size = max(0.0, mix(uSize - uSize * uSizeVar, uSize + uSize * uSizeVar, s));
    vec3 center = vec3(r * cos(a), r * sin(a), -aRing * uSpacing);

    float t = uLength > 1.0 ? aRing / (uLength - 1.0) : 0.0;
    float hue = mod(uHueStart + t * uHueRange, 360.0) / 360.0;
    float sat = clamp((255.0 - size * 10.0) / 100.0, 0.0, 1.0);
    vec3 srgb = hsv2rgb(vec3(hue, sat, 1.0));
    vColor = pow(srgb, vec3(2.2)) * (1.0 - uFade * t);

    vUv = uv;
    vShade = 0.84 + 0.16 * dot(normal, vec3(0.27, 0.53, 0.8));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position * size + center, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOutline;
  varying vec3 vColor;
  varying vec2 vUv;
  varying float vShade;

  void main() {
    // Dark cube edges, standing in for v1's black stroke.
    float e = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    float edge = mix(1.0, smoothstep(0.06, 0.16, e), uOutline);
    gl_FragColor = vec4(vColor * vShade * edge, 1.0);
    #include <colorspace_fragment>
  }
`;

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

    const box = new BoxGeometry(1, 1, 1);
    this.geometry = new InstancedBufferGeometry();
    this.geometry.index = box.index;
    for (const name of ['position', 'normal', 'uv']) this.geometry.setAttribute(name, box.getAttribute(name));
    this.aRing = new InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
    this.aSample = new InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
    this.geometry.setAttribute('aRing', this.aRing);
    this.geometry.setAttribute('aSample', this.aSample);

    const u = (value) => ({ value });
    this.uniforms = {
      uHistory: u(this.historyTex), uHead: u(0), uLength: u(10), uDispersal: u(1.5), uRingSize: u(1),
      uSize: u(5), uSizeVar: u(0), uSpacing: u(20), uHueStart: u(0), uHueRange: u(90),
      uPulse: u(0), uBass: u(0), uFade: u(0), uOutline: u(1),
    };
    const material = new ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.6, 0.18, 0.32);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.layoutKey = '';
    this.frameMs = 16.7;
    this.lastDprChange = 0;
    // Observe the canvas itself: it can start at 0×0 (background tab, hidden pane)
    // and window 'resize' doesn't always follow.
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  apply(s) {
    const u = this.uniforms;
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

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.width = w;
    this.height = h;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(w, h);
    if (!this.userMoved) this.fit();
  }

  // Drops resolution when frames run long, and recovers when there's headroom.
  _adapt(dt, now) {
    // Ignore stalls and throttled background frames: they say nothing about render cost.
    if (document.hidden || dt > 0.07) return;
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
  frame(dt, now, wave, bass) {
    this._adapt(dt, now);
    dt = Math.min(dt, 0.1);
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
    if (this.bloom.enabled) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
