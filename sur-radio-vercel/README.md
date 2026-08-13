# Deploying Sur Radio on Vercel

Everything here is deploy-ready. Hosting is free on Vercel's Hobby plan.

```
sur-radio/
├── index.html          the whole site, one file
├── api/
│   ├── resolve.js      finds a YouTube video for a song title (cached, shared)
│   └── curate.js       asks Claude for a per-state playlist (key stays server-side)
├── vercel.json         security headers + function timeout
├── package.json
└── .env.example        template for your keys
```

---

## Read this first: what costs money

| Thing | Cost | Needed? |
|---|---|---|
| Vercel hosting | **Free** (Hobby plan) | yes |
| YouTube song lookup | **Free** — public mirrors, no key | no key needed |
| YouTube Data API key | Free tier, 100 searches/day | optional, improves accuracy |
| Anthropic API key | **Paid, no free tier** | optional |

**The site works fully free with no keys at all.** It ships with 219 built-in songs across 36 states, and finds them on YouTube through public open-source mirrors. AI curation is an upgrade, not a requirement — without a Claude key you just get the built-in lists, and nothing breaks.

So: deploy first with zero keys, confirm it works, add keys later if you want.

---

## Step 1 — Deploy (pick one)

### Option A: drag and drop (fastest, ~2 minutes)

1. Put the four items (`index.html`, `api/`, `vercel.json`, `package.json`) in a folder
2. Go to **vercel.com/new**
3. Sign in with GitHub, GitLab, or email
4. Drag the folder onto the upload area
5. Click **Deploy**

You get a live URL like `sur-radio-abc123.vercel.app`.

### Option B: GitHub (best if you'll keep editing)

```bash
git init
git add .
git commit -m "Sur Radio"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/sur-radio.git
git push -u origin main
```

Then **vercel.com/new** → Import Git Repository → pick the repo → Deploy. Every future `git push` redeploys automatically.

### Option C: CLI

```bash
npm i -g vercel
cd sur-radio
vercel          # preview deploy
vercel --prod   # production
```

**No build settings to configure.** Vercel serves `index.html` as a static file and auto-detects anything in `api/` as a serverless function. Leave framework preset as "Other".

---

## Step 2 — Add API keys (optional)

Never put keys in `index.html`. That file is public — anyone can open DevTools and read it. That's exactly why `api/curate.js` exists.

### In the Vercel dashboard

Project → **Settings** → **Environment Variables** → add:

| Name | Value | Environments |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Production, Preview, Development |
| `YOUTUBE_API_KEY` | `AIza...` | Production, Preview, Development |

Then **Deployments** → latest → **⋯** → **Redeploy**. Environment variables only apply to builds made after they're set.

### Getting the keys

**Anthropic** (paid): console.anthropic.com → API Keys → Create Key. Add credit under Billing. Set a **monthly spend limit** while you're there — this is the single most important thing to do, and it caps your worst case.

**YouTube** (free): console.cloud.google.com → create a project → APIs & Services → Library → enable **YouTube Data API v3** → Credentials → Create Credentials → API key.

Then restrict it, or someone else can use your quota:
- **Application restrictions** → HTTP referrers → add `your-domain.vercel.app/*`
- **API restrictions** → restrict to YouTube Data API v3

(The referrer restriction is belt-and-braces here, since the key is only ever used server-side.)

---

## Step 3 — Verify it's live

1. Open your URL. You should see the dial landing page.
2. Click **Turn the dial** → a random state starts playing within a few seconds.
3. Tap a few states on the map. Try changing the mood.
4. Open DevTools → Network:
   - `/api/resolve?q=...` returning `{"id":"..."}` → server resolution working
   - `/api/curate` returning 12 tracks → Claude working
   - `"Up next"` showing **AI CURATED** rather than **BUILT-IN LIST** → same thing, visible in the UI

**Check the key is not exposed:** DevTools → Sources → `index.html` → Ctrl+F for `sk-ant`. Zero results is correct.

---

## The quota problem, honestly

The YouTube Data API free tier is 10,000 units/day, and a search costs 100 units. **That's 100 searches per day** — which sounds fatal for a public site, and would be, without caching.

`api/resolve.js` sets `s-maxage=2592000`, so Vercel's CDN caches each resolved song for 30 days. Consequences:

- The *first* person to hear "Rangabati" costs one search. The next 10,000 people cost nothing.
- Only *unique* song queries consume quota, not plays.
- When quota runs out, the function silently falls back to public mirrors. The site keeps working — matching just gets slightly less precise.

So it degrades instead of dying. If you outgrow it: request a quota increase in Google Cloud, or drop `YOUTUBE_API_KEY` entirely and run on mirrors alone.

**Claude costs** are bounded the same way: there are only 36 states × 6 moods = **216 possible requests**, cached 24 hours. So at most 216 model calls a day regardless of traffic. Check current pricing at anthropic.com/pricing — with `max_tokens: 1000` this is a small bill, but set that spend limit anyway.

---

## Step 4 — Custom domain (optional, free)

Project → Settings → **Domains** → Add. Point your registrar at Vercel's nameservers or add the CNAME they show you. HTTPS is provisioned automatically.

Remember to add the new domain to your YouTube key's referrer restrictions.

---

## Local development

```bash
npm i -g vercel
cp .env.example .env.local     # add your keys here
vercel dev                     # http://localhost:3000
```

`vercel dev` runs the `api/` functions locally too, which plain `python3 -m http.server` cannot.

Without the CLI you can still preview the front end:

```bash
python3 -m http.server 8000    # then open http://localhost:8000
```

The `/api/*` calls will 404, and the site falls back to built-in lists and browser-side lookup — by design. **Do not open `index.html` by double-clicking it**; the YouTube player cannot work from a `file://` origin.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Blank page, console mentions `postMessage` | Opened as `file://` | Serve over http |
| Songs show **NOT FOUND** | Mirrors rate-limited and no key | Add `YOUTUBE_API_KEY`, redeploy |
| Always says **BUILT-IN LIST** | No Claude key, or not redeployed after adding it | Check env var, then Redeploy |
| Map area empty | Boundary CDN blocked | Click Retry; the station list still works |
| `/api/*` returns 404 | `api/` folder missing from upload | Re-upload with the folder intact |
| Nothing plays, no errors | Browser blocked autoplay | Press the play button once |

Function logs live in Vercel → your project → **Logs**. Anything the code logs is prefixed `[resolve]` or `[curate]`.

---

## Before you share it widely

- **Vercel Hobby is for non-commercial use.** Ads or payments mean you need a Pro plan. Check Vercel's current terms.
- **Map boundaries.** India requires published maps to match official Survey of India boundaries. The dataset used is derived from Survey of India / DataMeet sources and carries a no-liability disclaimer. For a public Indian audience, verify against indiamaps.gov.in and keep the attribution note that's already in the footer.
- **Music is streamed via YouTube's official IFrame player**, so plays are counted and rightsholders are paid. Don't replace it with an audio-only extractor — that breaks YouTube's terms and cuts artists out.
- **Set that Anthropic spend limit.** A public URL is an open invitation to your API budget. The 24-hour cache is your main protection; the spend limit is the backstop.
