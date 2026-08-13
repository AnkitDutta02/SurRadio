/**
 * POST /api/curate
 *   body: { name, lang, genres, mood, moodQ }
 *   -> { tracks: [ { t, a, w }, ... ] }
 *
 * The Anthropic key lives ONLY here, in Vercel's environment variables. It must
 * never appear in index.html - that file is public, and anyone could read the key
 * out of it and spend your credit.
 *
 * Caching is the other half of the cost story: there are only 36 states x 6 moods
 * = 216 possible requests, so a 24h CDN cache means at most 216 model calls a day
 * no matter how much traffic arrives.
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // Not an error the visitor should see as a crash: the site falls back to its
    // built-in song lists, so just say so plainly.
    return res.status(200).json({ tracks: [], note: 'ANTHROPIC_API_KEY not configured' });
  }

  const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
  const clip = (v, n) => String(v || '').slice(0, n);
  const name   = clip(b.name, 80);
  const lang   = clip(b.lang, 120);
  const genres = clip(b.genres, 200);
  const mood   = clip(b.mood, 40);
  const moodQ  = clip(b.moodQ, 80);
  if (!name) return res.status(400).json({ error: 'name is required' });

  const system =
    'You curate a regional Indian radio station. Reply with ONLY raw JSON, no markdown fences, ' +
    'matching this shape:\n{"tracks":[{"t":"song title","a":"artist or film","w":"why it belongs, max 12 words"}]}\n' +
    'Give 12 tracks. Rules: only REAL released songs that plausibly exist on YouTube. Prefer ' +
    'well-known recordings with official uploads. Never invent titles. Match the state\'s actual ' +
    'languages and musical traditions. Order them like a radio set, not a ranked chart.';

  const user =
    'Indian state or union territory: ' + name +
    '\nLanguages: ' + lang +
    '\nMusical traditions there: ' + genres +
    '\nRequested mood: ' + mood + ' - ' + moodQ +
    '\nReturn the JSON now.';

  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: c.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    clearTimeout(t);

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.warn('[curate] anthropic', r.status, detail.slice(0, 300));
      // 200 with empty tracks: the client already treats this as "use built-ins".
      return res.status(200).json({ tracks: [], note: 'upstream ' + r.status });
    }

    const d = await r.json();
    const text = (d.content || [])
      .filter(x => x.type === 'text')
      .map(x => x.text)
      .join('\n')
      .replace(/```json|```/g, '')
      .trim();

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      console.warn('[curate] unparseable model output');
      return res.status(200).json({ tracks: [], note: 'unparseable' });
    }

    const tracks = (parsed.tracks || [])
      .filter(x => x && x.t && x.a)
      .slice(0, 12)
      .map(x => ({ t: String(x.t).slice(0, 120), a: String(x.a).slice(0, 120), w: String(x.w || '').slice(0, 160) }));

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ tracks });
  } catch (e) {
    console.warn('[curate] failed:', e.message);
    return res.status(200).json({ tracks: [], note: 'error' });
  }
};
