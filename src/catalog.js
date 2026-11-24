// Apple's public iTunes Search API: no key, CORS-enabled, and its 30-second
// previews are served with Access-Control-Allow-Origin: *, so the analyser can read them.
// (Spotify / Apple Music full tracks are DRM-protected and can't be analysed in a browser.)
const API = 'https://itunes.apple.com';

function country() {
  const region = (navigator.language || '').split('-')[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : 'US';
}

function toTrack(r) {
  return {
    kind: 'url',
    id: `it:${r.trackId}`,
    shareId: `it:${r.trackId}`,
    title: r.trackName,
    subtitle: r.artistName,
    src: r.previewUrl,
    artwork: r.artworkUrl100?.replace('100x100bb', '300x300bb'),
    thumb: r.artworkUrl60,
    link: r.trackViewUrl,
    preview: true,
  };
}

export async function searchSongs(term, signal) {
  const q = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '25', country: country() });
  const res = await fetch(`${API}/search?${q}`, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = await res.json();
  return data.results.filter((r) => r.previewUrl).map(toTrack);
}

export async function lookupSong(trackId) {
  const q = new URLSearchParams({ id: trackId, country: country() });
  const res = await fetch(`${API}/lookup?${q}`);
  if (!res.ok) return null;
  const data = await res.json();
  const r = data.results?.find((x) => x.previewUrl);
  return r ? toTrack(r) : null;
}
