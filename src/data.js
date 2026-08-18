const DAY_MS = 86400000;

const daysInYear = y => ((y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365);

// The CHMI feed sends no CORS header, so the browser cannot poll it directly:
// api/refresh.php does the conditional GET + tail merge and reports what changed.
// Any failure (plain static server, offline, slow feed) is non-fatal — the app
// then draws whatever is already in data/.
async function refreshFromFeed() {
  try {
    const r = await fetch('api/refresh.php', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { ok: false, reason: `no refresh endpoint (HTTP ${r.status})` };
    return await r.json();
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' ? 'feed timed out' : 'refresh unreachable' };
  }
}

// Per-day fraction of its calendar year -> one spiral revolution per year, leap
// years included. Also the index of Jan 1 for every year, for the slider.
function buildGrid(meta) {
  const n = meta.days;
  const startYear = +meta.start.slice(0, 4);
  const endYear = +meta.end.slice(0, 4);
  const startMs = Date.parse(meta.start + 'T00:00:00Z');
  const frac = new Float32Array(n);
  const firstIdx = new Int32Array(endYear - startYear + 1);

  let year = startYear;
  let doy = Math.round((startMs - Date.UTC(startYear, 0, 1)) / DAY_MS);
  let diy = daysInYear(year);
  for (let i = 0; i < n; i++) {
    if (doy === 0) firstIdx[year - startYear] = i;
    frac[i] = (doy + 0.5) / diy;
    if (++doy === diy) { doy = 0; diy = daysInYear(++year); }
  }
  return { meta, n, startMs, startYear, endYear, frac, firstIdx };
}

export async function loadData() {
  // The refresh only ever appends to (or revises) the tail, so it is not a
  // prerequisite for drawing anything. Awaiting it here used to serialize three
  // round-trips ahead of first paint — refresh, then meta.json, then the .i16 —
  // and a slow CHMI feed bought a 6 s blank page with no indicator. Start it,
  // paint from what data/ already holds, and let the caller fold the result in
  // through data.refreshDone.
  const refreshDone = refreshFromFeed();

  let cache = new Map();
  let elementReq = 0;

  const data = {
    // ok: null distinguishes "still checking" from "the check failed", which is
    // what setFreshness keys the footer off.
    refresh: { ok: null, updated: false },
    refreshDone,
    version: 0,
    temps: null,
    element: null,
    dateOf: i => new Date(data.startMs + i * DAY_MS),

    // Re-reads meta.json and the current element after a refresh has changed
    // them. Mutates in place: the UI closures hold this object, not its fields.
    async reload() {
      const meta = await fetch('data/meta.json', { cache: 'no-store' }).then(r => r.json());
      Object.assign(data, buildGrid(meta));
      cache = new Map();
      data.version++;
      await data.setElement(data.element ?? 'tma');
    },

    // The token is what keeps a slow element from landing after a fast one: the
    // first pick may be a network round-trip while the second is a cache hit
    // that resolves in the same microtask, and without this the stale response
    // would overwrite data.temps behind the newer selection. Returns whether
    // this call is still the current one.
    async setElement(key) {
      const req = ++elementReq;
      if (!cache.has(key)) {
        const buf = await fetch(data.meta.elements[key].file, { cache: 'no-store' })
          .then(r => r.arrayBuffer());
        const raw = new Int16Array(buf);
        const temps = new Float32Array(raw.length);
        for (let i = 0; i < raw.length; i++) temps[i] = raw[i] === -32768 ? NaN : raw[i] / 10;
        cache.set(key, temps);
      }
      if (req !== elementReq) return false;
      data.temps = cache.get(key);
      data.element = key;
      return true;
    },
  };

  await data.reload();
  return data;
}
