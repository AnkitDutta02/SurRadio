/**
 * GET /api/resolve?q=<song title artist language song>
 *   -> { id: "<11-char YouTube id>" }  or  { none: true }
 *
 * Why this exists on the server instead of the browser:
 *  - One shared cache. The same song resolves once for every visitor on earth,
 *    instead of once per person. This is what keeps the free YouTube quota alive.
 *  - The API key stays out of the client.
 *  - Public mirrors are tried as a fallback, so the site works even with no key.
 *
 * Caching: Vercel's CDN honours s-maxage, so a hit costs zero quota and zero
 * function time. 30 days is safe because a resolved video id rarely changes.
 */

/**
 * YouTube's public oEmbed endpoint answers 401/403 for a video whose owner has
 * disabled embedding, and 404 if it is gone. That lets us drop those candidates
 * before they ever reach the player, which is the difference between a song that
 * plays and the "blocked from embedding" dead end.
 */
async function embeddable(id, ms = 2500) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id),
      { signal: c.signal }
    );
    return r.status === 200;
  } catch (e) {
    return true;          // network hiccup: do not discard a possibly good video
  } finally { clearTimeout(t); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const q = String((req.query && req.query.q) || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'q is required' });

  const withTimeout = async (url, ms = 5000) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(url, { signal: c.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  };

  const valid = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
  let id = null;
  let via = null;

  // 1. Official API, if a key is configured.
  const key = process.env.YOUTUBE_API_KEY;
  if (key) {
    try {
      const j = await withTimeout(
        'https://www.googleapis.com/youtube/v3/search' +
        '?part=snippet&type=video&videoEmbeddable=true&maxResults=3&q=' +
        encodeURIComponent(q) + '&key=' + encodeURIComponent(key));
      const items = (j && j.items) || [];
      for (const it of items) {
        if (it.id && valid(it.id.videoId)) { id = it.id.videoId; via = 'youtube'; break; }
      }
    } catch (e) {
      // quotaExceeded lands here too, which is exactly when we want the mirrors
      console.warn('[resolve] youtube api failed:', e.message);
    }
  }

  // 2. Public open-source mirrors, raced so one slow host cannot stall the page.
  if (!id) {
    const mirrors = [
      'https://pipedapi.kavin.rocks/search?filter=videos&q=',
      'https://pipedapi.adminforge.de/search?filter=videos&q=',
      'https://api.piped.private.coffee/search?filter=videos&q=',
    ];
    const invidious = [
      'https://inv.nadeko.net/api/v1/search?type=video&q=',
      'https://invidious.nerdvpn.de/api/v1/search?type=video&q=',
    ];
    const attempts = mirrors.map(base => withTimeout(base + encodeURIComponent(q), 4500)
      .then(j => {
        const arr = (j && j.items) || (Array.isArray(j) ? j : []);
        const cands = [];
        for (const it of arr) {
          const u = it && it.url;
          const dur = it && typeof it.duration === 'number' ? it.duration : null;
          if (dur !== null && (dur < 45 || dur > 1500)) continue;   // skip clips and full-album rips
          if (u && u.includes('watch?v=')) {
            const cand = u.split('watch?v=')[1].split('&')[0];
            if (valid(cand)) cands.push(cand);
          }
          if (cands.length >= 5) break;
        }
        if (!cands.length) throw new Error('no match');
        return cands;
      })
    ).concat(invidious.map(base => withTimeout(base + encodeURIComponent(q), 4500)
      .then(j => {
        const arr = Array.isArray(j) ? j : [];
        for (const it of arr) if (it && valid(it.videoId)) return it.videoId;
        throw new Error('no match');
      })
    ));

    try {
      const cands = await Promise.any(attempts);
      /* Walk the candidates in order and take the first that can actually be
         embedded, rather than betting everything on the top result. */
      for (const c of (Array.isArray(cands) ? cands : [cands])) {
        if (await embeddable(c)) { id = c; via = 'mirror'; break; }
      }
      if (!id) { id = null; via = 'blocked'; }
    } catch (e) { id = null; }
  }

  if (!id) {
    // Cache misses briefly too, so a broken query cannot hammer the function.
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ none: true, reason: via === 'blocked' ? 'not embeddable' : 'no match' });
  }

  res.setHeader('Cache-Control', 's-maxage=2592000, stale-while-revalidate=31536000');
  return res.status(200).json({ id, via });
};
