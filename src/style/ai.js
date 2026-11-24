// Client for /api/style, which asks Claude to turn a reference into a ring style.
let available = null;

export async function aiAvailable() {
  if (available !== null) return available;
  try {
    const res = await fetch('/api/style', { signal: AbortSignal.timeout(5000) });
    available = res.ok && (await res.json()).enabled === true;
  } catch {
    available = false;
  }
  return available;
}

export async function aiStyle({ kind, prompt, url, images, measurements }, signal) {
  const res = await fetch('/api/style', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, prompt, url, images, measurements }),
    signal,
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* non-JSON error page */ }
  if (!res.ok || !data?.style) throw new Error(data?.error || `Styling failed (${res.status}).`);
  return data.style;
}
