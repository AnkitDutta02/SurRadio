/**
 * GET /api/search?q=<query>
 *   -> { results: [ { id, title, author }, ... ] }
 *
 * Returns a LIST so the listener can pick the right song, instead of the app
 * guessing one for them. Same tier order as /api/resolve: official key first if
 * configured, then public mirrors, raced so one slow host cannot stall typing.
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const q = String((req.query && req.query.q) || '').trim().slice(0, 200);
  if (q.length < 2) return res.status(400).json({ error: 'q too short' });

  const MAX = 10;
  const valid = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);

  const get = async (url, ms = 4500) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(url, { signal: c.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  };

  let results = null;

  const key = process.env.YOUTUBE_API_KEY;
  if (key) {
    try {
      const j = await get('https://www.googleapis.com/youtube/v3/search' +
        '?part=snippet&type=video&videoEmbeddable=true&maxResults=' + MAX +
        '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(key), 5000);
      const out = [];
      for (const it of (j.items || [])) {
        const id = it.id && it.id.videoId;
        if (valid(id)) out.push({ id, title: clean(it.snippet && it.snippet.title),
                                  author: clean(it.snippet && it.snippet.channelTitle) });
      }
      if (out.length) results = out;
    } catch (e) { console.warn('[search] youtube api:', e.message); }
  }

  if (!results) {
    const piped = [
      'https://pipedapi.kavin.rocks/search?filter=videos&q=',
      'https://pipedapi.adminforge.de/search?filter=videos&q=',
      'https://api.piped.private.coffee/search?filter=videos&q=',
    ].map(base => get(base + encodeURIComponent(q)).then(j => {
      const arr = (j && j.items) || (Array.isArray(j) ? j : []);
      const out = [];
      for (const it of arr) {
        const u = it && it.url;
        const dur = it && typeof it.duration === 'number' ? it.duration : null;
        if (dur !== null && (dur < 45 || dur > 1500)) continue;   // skip clips and full-album rips
        if (u && u.includes('watch?v=')) {
          const id = u.split('watch?v=')[1].split('&')[0];
          if (valid(id)) out.push({ id, title: clean(it.title), author: clean(it.uploaderName) });
        }
        if (out.length >= MAX) break;
      }
      if (!out.length) throw new Error('empty');
      return out;
    }));

    const inv = [
      'https://inv.nadeko.net/api/v1/search?type=video&q=',
      'https://invidious.nerdvpn.de/api/v1/search?type=video&q=',
    ].map(base => get(base + encodeURIComponent(q)).then(j => {
      const arr = Array.isArray(j) ? j : [];
      const out = [];
      for (const it of arr) {
        if (it && valid(it.videoId)) out.push({ id: it.videoId, title: clean(it.title), author: clean(it.author) });
        if (out.length >= MAX) break;
      }
      if (!out.length) throw new Error('empty');
      return out;
    }));

    try { results = await Promise.any(piped.concat(inv)); }
    catch (e) { results = []; }
  }

  res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=2592000');
  return res.status(200).json({ results: (results || []).slice(0, MAX) });
};
