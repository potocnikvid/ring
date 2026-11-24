# ring

A 3D audio visualiser: every frame of the waveform becomes a ring of particles, and the last few seconds stretch into a tunnel you can orbit.

https://ring-umber.vercel.app/

<img width="1799" alt="ring v1" src="https://github.com/potocnikvid/ring/assets/54533045/4ad2fb10-eb8f-449f-b6a5-114b4cafb473">

## Music sources

- **Library**: the tracks in `public/audio`.
- **Search**: any song in the Apple Music catalogue, as a 30-second preview (iTunes Search API, no key needed).
- **Your files**: pick or drop any audio file. It never leaves the browser.
- **Another tab**: share a Spotify, YouTube or Apple Music tab with “Share tab audio” on (Chrome and Edge on desktop).
- **Microphone**: react to whatever is playing in the room.

Spotify and Apple Music full tracks are DRM-protected, so a browser can't analyse them directly. Tab sharing is the way to visualise them.

## Controls

Tune panel (`T`) holds every visual parameter, six presets, Randomize (`R`) and Copy link, which encodes the current look and track in the URL.

| Key | Action |
| --- | --- |
| Enter | Play or pause |
| Space | Back to the start of the track |
| ← → | Seek 5 seconds |
| ↑ ↓ | Volume |
| N / P | Next or previous track |
| M | Music panel |
| H | Hide the interface |
| F | Full screen |
| ? | All shortcuts |
| Drag, scroll, double-click | Orbit, zoom, reset the view |

## How it works

- `src/audio.js`: Web Audio graph. An `<audio>` element (streamed, not decoded up front) or a `MediaStream` feeds one `AnalyserNode`. Analysis happens before the volume stage, so the ring still moves when muted.
- `src/visualizer.js`: three.js. All particles are a single instanced draw call. Waveform history lives in a 1024×100 ring-buffer texture and the vertex shader places and colours every cube, so each frame uploads one 1 KB row. Bloom via `UnrealBloomPass`, and resolution scales down automatically if frames run long.
- `src/settings.js`: parameters, presets, URL and localStorage state.
- `src/main.js`: UI wiring, keyboard, media session, render loop.

## Develop

```bash
npm install
npm run dev
```

`npm run build` outputs to `dist/`. Vercel settings are in `vercel.json`.
