#!/usr/bin/env node
/**
 * Sur Radio - manifest builder
 *
 * A radio must not search for a song at the moment you ask for it. This harvests a
 * playable source id for every track in the catalogue ONCE, ahead of time, and writes
 * public/manifest.json. The app loads that file at boot and seeds its cache, so a
 * deployed Sur Radio performs no lookup at playback time.
 *
 * Nothing here is invented: every id comes from the same /api/resolve endpoint the app
 * would otherwise call at runtime, so the manifest contains only real, verified,
 * embeddable videos.
 *
 * Usage
 *   node tools/build-manifest.js                     # against the deployed site
 *   node tools/build-manifest.js http://localhost:3000
 *
 * Re-run it whenever the catalogue changes. It is incremental: existing entries are
 * kept, so a second run only fetches what is missing.
 */
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'https://sur-radio.vercel.app').replace(/\/$/, '');
const OUT  = path.join(__dirname, '..', 'manifest.json');
const CONCURRENCY = 4;          // gentle: the endpoint is CDN-cached but not free
const PAUSE_MS = 120;

/* Pull the catalogue straight out of index.html, so there is one source of truth. */
function readCatalogue() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

  /* Take each declaration by counting brackets rather than guessing where it ends,
     so reformatting the catalogue cannot silently break the build. */
  function block(decl, open, close) {
    const start = script.indexOf(decl);
    if (start < 0) throw new Error('cannot find ' + decl + ' in index.html');
    let depth = 0;
    for (let i = start; i < script.length; i++) {
      const c = script[i];
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return script.slice(start, i + 1) + ';';
      }
    }
    throw new Error('unterminated ' + decl);
  }

  const src = block('const MOODS', '{', '}') + '\n' +
              block('const REGIONS', '[', ']') + '\n' +
              'return { REGIONS: REGIONS, MOODS: MOODS };';
  return new Function(src)();
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function trackKey(t) { return norm(t.t) + '|' + norm(t.a); }

/* The same phrase the app would search with, so the manifest matches what runtime
   resolution would have found. */
function searchPhrase(t, region) {
  const bits = [t.t, t.a];
  if (region && region.lang) bits.push(region.lang.split(',')[0]);
  return bits.filter(Boolean).join(' ').slice(0, 120);
}

async function resolveOne(phrase) {
  const url = BASE + '/api/resolve?q=' + encodeURIComponent(phrase);
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j && j.id) return j.id;
  return null;                                   // no match, or not embeddable
}

(async () => {
  const { REGIONS } = readCatalogue();

  let manifest = {};
  if (fs.existsSync(OUT)) {
    try {
      manifest = JSON.parse(fs.readFileSync(OUT, 'utf8')) || {};
      console.log('resuming from ' + Object.keys(manifest).length + ' existing entries');
    } catch (e) { manifest = {}; }
  }

  /* de-duplicate: the same song can sit in several stations */
  const jobs = new Map();
  REGIONS.forEach(r => (r.seed || []).forEach(t => {
    const key = trackKey(t);
    if (manifest[key] || jobs.has(key)) return;
    jobs.set(key, { key, phrase: searchPhrase(t, r) });
  }));

  const list = [...jobs.values()];
  console.log(list.length + ' tracks to resolve against ' + BASE);
  if (!list.length) { console.log('nothing to do'); return; }

  let done = 0, found = 0, missed = 0;
  async function worker(slice) {
    for (const job of slice) {
      try {
        const id = await resolveOne(job.phrase);
        if (id) { manifest[job.key] = id; found++; }
        else { missed++; }
      } catch (e) { missed++; }
      done++;
      if (done % 25 === 0) {
        fs.writeFileSync(OUT, JSON.stringify(manifest, null, 0));
        process.stdout.write('\r  ' + done + '/' + list.length +
          '  found ' + found + '  missed ' + missed + '   ');
      }
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }
  }

  const slices = Array.from({ length: CONCURRENCY }, (_, i) =>
    list.filter((_, n) => n % CONCURRENCY === i));
  await Promise.all(slices.map(worker));

  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 0));
  console.log('\nwrote ' + OUT);
  console.log('  ' + Object.keys(manifest).length + ' sources known up front');
  console.log('  ' + missed + ' unresolved (they fall back to on-demand lookup)');
})();
