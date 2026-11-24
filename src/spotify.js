// Spotify connection: now playing, search, and playback control through the Web API.
//
// Spotify's audio is DRM-protected and never reachable from a web page, so the ring
// itself listens to the computer's sound (system audio or a loopback input) while
// this module supplies the track, artwork and transport controls.
//
// Needs a Spotify app (developer.spotify.com/dashboard) whose client ID is set as
// VITE_SPOTIFY_CLIENT_ID. Authorization Code with PKCE: no client secret involved.
const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID || '';
const SCOPES = 'user-read-playback-state user-read-currently-playing user-modify-playback-state';
const TOKEN_KEY = 'ring:spotify';
const VERIFIER_KEY = 'ring:spotify-verifier';
const API = 'https://api.spotify.com/v1';

export const spotifyAvailable = !!CLIENT_ID;

// Spotify only accepts loopback IPs, not "localhost", as http redirect URIs.
function redirectUri() {
  const origin = location.origin.replace('//localhost', '//127.0.0.1');
  return `${origin}/`;
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function readTokens() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
  } catch {
    return null;
  }
}
function writeTokens(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: the session lasts until reload */
  }
  tokens = t;
}
let tokens = readTokens();

export const isConnected = () => !!tokens?.refresh_token;

export async function connect() {
  if (location.hostname === 'localhost') {
    // Keep the PKCE verifier on the same origin as the redirect.
    location.href = location.href.replace('//localhost', '//127.0.0.1');
    return;
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state, hash: location.hash }));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  location.href = `https://accounts.spotify.com/authorize?${q}`;
}

export function disconnect() {
  writeTokens(null);
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  if (!res.ok) throw new Error('Spotify sign-in failed. Try connecting again.');
  const t = await res.json();
  writeTokens({
    access_token: t.access_token,
    refresh_token: t.refresh_token || tokens?.refresh_token,
    expires_at: Date.now() + (t.expires_in - 60) * 1000,
  });
}

// Finishes the redirect back from Spotify. Returns true if this page load was one.
export async function completeConnect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return false;
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(VERIFIER_KEY) || 'null');
  } catch { /* ignore */ }
  sessionStorage.removeItem(VERIFIER_KEY);
  history.replaceState(null, '', `${location.pathname}${saved?.hash || ''}`);
  if (params.has('error')) throw new Error('Spotify connection was cancelled.');
  if (!saved || saved.state !== params.get('state')) throw new Error('Spotify sign-in expired. Try connecting again.');
  await tokenRequest({
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: redirectUri(),
    code_verifier: saved.verifier,
  });
  return true;
}

async function accessToken() {
  if (!tokens) throw new Error('Not connected to Spotify.');
  if (Date.now() > tokens.expires_at) {
    try {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    } catch (err) {
      writeTokens(null);
      throw err;
    }
  }
  return tokens.access_token;
}

const REASONS = {
  NO_ACTIVE_DEVICE: 'Open Spotify on your computer or phone first, then try again.',
  PREMIUM_REQUIRED: 'Controlling playback needs Spotify Premium.',
};

async function api(path, { method = 'GET', body, retried = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204 || res.status === 202) return null;
  if (res.status === 401 && !retried) {
    tokens.expires_at = 0; // force a refresh, then try once more
    return api(path, { method, body, retried: true });
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const reason = data?.error?.reason;
    if (res.status === 403 && /user may not be registered|not registered/i.test(data?.error?.message || '')) {
      throw new Error('This Spotify account isn’t on the app’s user list. Add it in the Spotify developer dashboard.');
    }
    throw new Error(REASONS[reason] || data?.error?.message || `Spotify request failed (${res.status}).`);
  }
  return data;
}

function toTrack(item) {
  if (!item) return null;
  const images = item.album?.images || [];
  return {
    kind: 'spotify',
    id: `sp:${item.id}`,
    uri: item.uri,
    title: item.name,
    subtitle: (item.artists || []).map((a) => a.name).join(', '),
    artwork: images[0]?.url,
    thumb: images[images.length - 1]?.url,
    link: item.external_urls?.spotify,
    durationMs: item.duration_ms,
  };
}

export async function nowPlaying() {
  const data = await api('/me/player?additional_types=track');
  if (!data?.item) return { track: null, playing: false, progressMs: 0, device: data?.device?.name ?? null };
  return { track: toTrack(data.item), playing: data.is_playing, progressMs: data.progress_ms, device: data.device?.name ?? null };
}

export async function search(term) {
  // Development-mode apps get at most 10 results.
  const q = new URLSearchParams({ q: term, type: 'track', limit: '10' });
  const data = await api(`/search?${q}`);
  return (data?.tracks?.items || []).map(toTrack);
}

export const playUri = (uri) => api('/me/player/play', { method: 'PUT', body: { uris: [uri] } });
export const resume = () => api('/me/player/play', { method: 'PUT' });
export const pause = () => api('/me/player/pause', { method: 'PUT' });
export const next = () => api('/me/player/next', { method: 'POST' });
export const previous = () => api('/me/player/previous', { method: 'POST' });
export const seek = (ms) => api(`/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}`, { method: 'PUT' });
