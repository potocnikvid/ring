# ring

A 3D audio visualiser: every frame of the sound becomes a ring of particles, and the last few seconds stretch into a tunnel you can orbit. Record clips of it to share.

https://ring-umber.vercel.app/

<img width="1799" alt="ring v1" src="https://github.com/potocnikvid/ring/assets/54533045/4ad2fb10-eb8f-449f-b6a5-114b4cafb473">

## Music sources

Everything starts from the search box (press `/`).

- **Search**: any song in the Apple Music catalogue, as a 30-second preview (iTunes Search API, no key needed).
- **Library**: the tracks in `public/audio` (128 kbps AAC).
- **Your files**: pick or drop any audio file. It never leaves the browser.
- **A browser tab**: share a YouTube, SoundCloud or web-player tab with “Share tab audio” on.
- **Computer audio**: share “Entire screen” with “Share system audio” on, which covers desktop apps such as Spotify. Chrome 141+ on macOS 14.2+, Chrome or Edge on Windows.
- **Microphone or input**: the room, or a loopback device such as [BlackHole](https://existential.audio/blackhole/) that carries the computer's sound without screen sharing.

Browsers only allow capture straight from a click, so the capture request is made before anything else is awaited.

### Spotify

Spotify's audio is DRM-protected and can't be analysed by a web page, so ring listens to your computer's audio and uses the Spotify Web API for what's playing: track, artwork, play/pause/skip/seek and Spotify search.

To turn it on:

1. Create an app at https://developer.spotify.com/dashboard (the owner account needs Spotify Premium).
2. Add redirect URIs `https://ring-umber.vercel.app/` and `http://127.0.0.1:5173/`, and enable the Web API.
3. Set the client ID as `VITE_SPOTIFY_CLIENT_ID` (in Vercel, and in `.env.local` for development).
4. Under User Management, add each Spotify account that should be able to connect.

Development-mode apps allow at most 5 users and 10 search results. Spotify's developer policy doesn't allow its recordings in videos, so clips recorded while Spotify is the source are silent.

## Style from anything

The Style panel turns a reference into a look: palette, background, particle shape, symmetry, twist, trails, glow and motion.

- **Images and videos** (drop, pick or paste): analysed in the browser. A k-means palette plus brightness, contrast, colourfulness, edge density, left-right symmetry and (for video) motion map to settings. Busy, graphic images become outlined cubes; soft ones become glowing dots with trails; symmetric ones turn on kaleidoscope symmetry. Works with no server.
- **Websites, image links and descriptions**: sent to `api/style.js`, a Vercel Function that asks Claude (`claude-opus-5-5`, structured JSON output) to art-direct a style. For websites it reads the page's title, description, theme colour, most-used CSS colours and social preview image first. With AI on, image and video styles are refined by Claude too.

AI styles need `ANTHROPIC_API_KEY` in the Vercel project's environment variables (and in `.env.local` for `npm run dev`, which serves `api/` itself). Without it, the panel says so and image/video styles still work. The function blocks private and local addresses, caps sizes, and rate-limits each IP (best effort).

## Recording

Record (`V`) captures the canvas only, never the controls, with the audio feeding the ring. Frames: Screen, Square 1080×1080, Vertical 1080×1920, 1080p. Output is MP4 (H.264/AAC) where the browser supports it, WebM otherwise, at about 9 Mbps. Up to 10 minutes.

## Controls

Tune panel (`T`): presets, waveform or spectrum mode (`S`), symmetry, twist, particle shape (cubes, spheres, dots), tunnel and trails, rainbow or palette colours, glow, beat motion, auto-rotate. Randomize (`R`) and Copy link, which saves the look and track in the URL.

| Key | Action |
| --- | --- |
| / | Search |
| Enter | Play or pause |
| Space | Back to the start of the track |
| ← → | Seek 5 seconds |
| ↑ ↓ | Volume |
| N / P | Next or previous track |
| V | Start or stop recording |
| H | Hide the interface |
| F | Full screen |
| ? | All shortcuts |
| Drag, scroll, double-click | Orbit, zoom, reset the view |

## How it works

- `src/audio.js`: Web Audio graph. An `<audio>` element (streamed) or a `MediaStream` feeds one `AnalyserNode` and a recording tap, both before the volume stage. Also builds the mirrored log-scale spectrum and detects beats.
- `src/visualizer.js`: three.js. All particles are one instanced draw call; waveform history lives in a ring-buffer texture and the vertex shader places and colours every cube. Bloom, beat motion, adaptive resolution, fixed-size rendering for recordings.
- `src/recorder.js`: `MediaRecorder` over `canvas.captureStream()` plus the audio tap.
- `src/spotify.js`: PKCE sign-in and Web API calls.
- `src/settings.js`, `src/catalog.js`, `src/library.js`, `src/main.js`: parameters and presets, Apple Music search, the library, UI wiring.

## Develop

```bash
npm install
npm run dev
```

`npm run build` outputs to `dist/`. Vercel settings are in `vercel.json`.
