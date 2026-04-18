require('dotenv').config();
const express = require('express');
const jwt     = require('jsonwebtoken');
const axios   = require('axios');
const cors    = require('cors');
const bp      = require('body-parser');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const PORT       = process.env.PORT || 3000;
const CACHE_DIR  = path.join(__dirname, 'cache');
const CACHE_TTL  = 7 * 24 * 60 * 60 * 1000;   // 7 days
const STALE_TTL  = 3 * 24 * 60 * 60 * 1000;   // 3 days → serve + refresh bg
const JWT_SECRET = process.env.JWT_SECRET || 'meridian_fallback_change_me';
const MAX_DAILY  = 10;
const MODEL      = 'claude-sonnet-4-5-20250514'; // verified model ID

const rateLimits     = {};
const bgRefreshQueue = new Set(); // track in-progress background refreshes

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(bp.json({ limit: '1mb' }));

app.get('/',                  (_req, res) => res.sendFile(path.join(__dirname, 'meridian-app.html')));
app.get('/meridian-app.html', (_req, res) => res.sendFile(path.join(__dirname, 'meridian-app.html')));

// ── Country → Marketaux code map ──────────────────────────
const COUNTRY_CODES = {
    'United States': 'us',
    'United Kingdom': 'gb',
    'India':          'in',
    'Germany':        'de',
    'Japan':          'jp',
    'France':         'fr',
    'China':          'cn',
};

// ── Horizon → prompt guidance ─────────────────────────────
const HORIZON_GUIDANCE = {
    '6m':  'Focus on near-term catalysts: upcoming earnings, momentum plays, short-term macro events. Prefer liquid large-caps.',
    '1y':  'Focus on sector rotation and rate cycle positioning. Balance defensive and growth. Consider upcoming elections or policy changes.',
    '2y':  'Balance growth and value. Emphasise earnings trajectory, margin expansion, and companies with pricing power.',
    '3y':  'Structural trends and competitive moats. Focus on companies with strong balance sheets and consistent free cash flow.',
    '4y':  'Long-term compounders. Demographics, innovation cycles, valuation margin of safety. ESG and regulatory tailwinds matter.',
    '5y':  'Decade-long structural winners. Transformative technology, emerging middle class, infrastructure build-out. Think in cycles.',
    '10y': 'Generational investment thesis. Population trends, energy transition, AI/automation disruption. Deep value or deep growth.',
};

// ── Cache helpers ─────────────────────────────────────────
function cacheKey(country, horizon, riskProfile) {
    return [country, horizon, riskProfile]
        .join('_').toLowerCase().replace(/[\s/]+/g, '_');
}
function cacheFile(key) { return path.join(CACHE_DIR, `${key}.json`); }

function readCache(country, horizon, riskProfile) {
    try {
        const file = cacheFile(cacheKey(country, horizon, riskProfile));
        if (!fs.existsSync(file)) return null;
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Date.now() - raw.cachedAt > CACHE_TTL) { fs.unlinkSync(file); return null; }
        return raw;
    } catch { return null; }
}

function writeCache(country, horizon, riskProfile, data) {
    try {
        fs.writeFileSync(
            cacheFile(cacheKey(country, horizon, riskProfile)),
            JSON.stringify({ ...data, cachedAt: Date.now() }, null, 2)
        );
    } catch (e) { console.error('[cache write]', e.message); }
}

function isStale(cached) {
    return cached && (Date.now() - cached.cachedAt) > STALE_TTL;
}

// ── STEP 1: Get news via Marketaux ────────────────────────
async function getMarketNews(country) {
    const code = COUNTRY_CODES[country];
    if (!code) throw new Error(`No Marketaux code for country: ${country}`);

    console.log(`[Step 1] Fetching Marketaux news for ${country} (${code})…`);

    const resp = await axios.get('https://api.marketaux.com/v1/news/all', {
        params: {
            api_token:       process.env.MARKETAUX_API_KEY,
            countries:       code,
            filter_entities: true,
            language:        'en',
            limit:           8,
            published_after: new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0],
        },
        timeout: 10000,
    });

    const articles = resp.data?.data || [];
    if (!articles.length) return `No recent news found for ${country} from Marketaux.`;

    const summary = articles.map((a, i) =>
        `${i + 1}. ${a.title} (${a.source}) — ${a.description || ''}`.slice(0, 200)
    ).join('\n');

    console.log(`[Step 1] Got ${articles.length} articles for ${country}`);
    return summary;
}

// ── STEP 2: Analyse with Claude (no web search) ───────────
async function analyzeMarket(country, horizon, riskProfile, newsContext) {
    console.log(`[Step 2] Analysing ${country} | horizon:${horizon} | risk:${riskProfile}…`);

    const horizonGuide = HORIZON_GUIDANCE[horizon] || HORIZON_GUIDANCE['1y'];
    const today        = new Date().toISOString().split('T')[0];

    const system = `You are a senior global macro investment analyst. \
Respond ONLY with valid raw JSON — no markdown, no code fences, no explanation. \
Start with { and end with }.`;

    const user = `Today is ${today}. Latest news for ${country} stock market:

${newsContext}

Analyse ${country} for a ${riskProfile} investor with a ${horizon} investment horizon.
Horizon guidance: ${horizonGuide}

Return ONLY this JSON:
{
  "country": "${country}",
  "flag": "flag emoji",
  "exchange": "main exchange(s)",
  "outlook": "Bullish",
  "confidence": 72,
  "summary": "2-3 sentences grounded in the news above",
  "whyNow": "1-2 sentences on the key opportunity for the ${horizon} horizon",
  "horizon": "${horizon}",
  "riskProfile": "${riskProfile}",
  "sectors": [
    { "name": "Sector", "reason": "brief reason referencing news" }
  ],
  "companies": [
    { "ticker": "TICK", "name": "Company", "exchange": "Exchange", "reason": "thesis for ${horizon}", "conviction": "High" }
  ],
  "risks": ["risk 1", "risk 2", "risk 3"],
  "suggestedAllocationPct": 20,
  "entryStrategy": "Phased over 3 months"
}

Include 3 sectors and 3-5 companies suited to a ${horizon} horizon and ${riskProfile} risk profile.`;

    const MAX_RETRIES = 2;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const resp = await axios.post(
                'https://api.anthropic.com/v1/messages',
                {
                    model:      MODEL,
                    max_tokens: 1200,
                    system,
                    messages:   [{ role: 'user', content: user }],
                },
                {
                    headers: {
                        'x-api-key':         process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01',
                        'content-type':      'application/json',
                    },
                    timeout: 60000, // 60s per attempt
                }
            );
            return extractJSON(resp.data.content);
        } catch (err) {
            lastErr = err;
            const isRetryable = err.code === 'ECONNABORTED'
                || err.message?.includes('timeout')
                || err.message?.includes('idle')
                || err.response?.status >= 500;
            if (isRetryable && attempt < MAX_RETRIES) {
                console.log(`[analyzeMarket] Attempt ${attempt} failed (${err.message}), retrying in 3s…`);
                await new Promise(r => setTimeout(r, 3000));
            } else {
                throw err;
            }
        }
    }
    throw lastErr;
}

// ── JSON extractor ────────────────────────────────────────
function extractJSON(content = []) {
    const texts = content.filter(b => b.type === 'text').map(b => b.text);
    for (let i = texts.length - 1; i >= 0; i--) {
        const stripped = texts[i].replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
        for (const src of [stripped, texts[i].trim()]) {
            try { const p = JSON.parse(src); if (p.outlook || p.sectors) return p; } catch {}
        }
        const m = texts[i].match(/\{[\s\S]*?"(?:outlook|sectors)"[\s\S]*?\}/);
        if (m) { try { return JSON.parse(m[0]); } catch {} }
    }
    throw new Error('Could not parse JSON from Claude response');
}

// ── Full analysis pipeline ────────────────────────────────
async function runAnalysis(country, horizon, riskProfile) {
    const news     = await getMarketNews(country);
    const analysis = await analyzeMarket(country, horizon, riskProfile, news);
    return { ...analysis, newsContext: news, timestamp: Date.now(), cachedAt: Date.now(), fromCache: false };
}

// ── Auth middleware ───────────────────────────────────────
function requireAuth(req, res, next) {
    const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : req.body?.token;
    if (!bearer) return res.status(401).json({ success: false, error: 'Authentication required' });
    try { req.user = jwt.verify(bearer, JWT_SECRET); next(); }
    catch { res.status(401).json({ success: false, error: 'Token expired — please log in again' }); }
}

// ── Rate limit middleware ─────────────────────────────────
function rateLimit(req, res, next) {
    const id    = req.user.user;
    const today = new Date().toDateString();
    if (!rateLimits[id] || rateLimits[id].date !== today) rateLimits[id] = { count: 0, date: today };
    if (rateLimits[id].count >= MAX_DAILY) {
        return res.status(429).json({ success: false, error: `Daily limit of ${MAX_DAILY} analyses reached. Cached results still available.` });
    }
    next();
}

// ── POST /login ───────────────────────────────────────────
app.post('/login', (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ success: false, error: 'Password required' });
    if (password !== process.env.PASSWORD) return res.status(401).json({ success: false, error: 'Incorrect password' });
    const token = jwt.sign({ user: 'meridian_user' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, expiresIn: 86400 });
});

// ── POST /api/analyze — single country ───────────────────
app.post('/api/analyze', requireAuth, rateLimit, async (req, res) => {
    const { country, horizon = '1y', riskProfile = 'balanced' } = req.body || {};
    if (!country) return res.status(400).json({ success: false, error: 'country is required' });
    if (!COUNTRY_CODES[country]) return res.status(400).json({ success: false, error: `Unsupported country: ${country}` });

    const cached = readCache(country, horizon, riskProfile);

    if (cached && !isStale(cached)) {
        // Fresh cache — return instantly
        return res.json({ success: true, ...cached, fromCache: true, cacheAge: 'fresh' });
    }

    if (cached && isStale(cached)) {
        // Stale cache — return immediately, refresh in background
        const bgKey = cacheKey(country, horizon, riskProfile);
        if (!bgRefreshQueue.has(bgKey)) {
            bgRefreshQueue.add(bgKey);
            runAnalysis(country, horizon, riskProfile)
                .then(data => { writeCache(country, horizon, riskProfile, data); })
                .catch(e  => console.error('[bg refresh]', e.message))
                .finally(() => bgRefreshQueue.delete(bgKey));
        }
        return res.json({ success: true, ...cached, fromCache: true, cacheAge: 'stale' });
    }

    // No cache — fetch fresh
    try {
        const result = await runAnalysis(country, horizon, riskProfile);
        writeCache(country, horizon, riskProfile, result);
        rateLimits[req.user.user].count++;
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[/api/analyze]', err.response?.data || err.message);
        res.status(err.response?.status || 500).json({ success: false, error: err.message });
    }
});

// ── POST /api/portfolio — multi-country portfolio ─────────
app.post('/api/portfolio', requireAuth, async (req, res) => {
    const { countries = [], horizon = '1y', riskProfile = 'balanced', amount = 10000, currency = 'GBP' } = req.body || {};
    if (!countries.length) return res.status(400).json({ success: false, error: 'Select at least one country' });

    const results  = [];
    const errors   = [];

    await Promise.all(countries.map(async country => {
        try {
            let data = readCache(country, horizon, riskProfile);
            if (!data) {
                data = await runAnalysis(country, horizon, riskProfile);
                writeCache(country, horizon, riskProfile, data);
                if (rateLimits[req.user.user]) rateLimits[req.user.user].count++;
            }
            results.push(data);
        } catch (e) {
            errors.push({ country, error: e.message });
        }
    }));

    // Normalise allocations to sum to 100
    const totalPct  = results.reduce((s, r) => s + (r.suggestedAllocationPct || 0), 0);
    const portfolio = results.map(r => {
        const pct = totalPct > 0 ? Math.round((r.suggestedAllocationPct / totalPct) * 100) : Math.round(100 / results.length);
        return {
            ...r,
            allocatedPct:    pct,
            allocatedAmount: Math.round((pct / 100) * amount),
            currency,
        };
    });

    res.json({ success: true, portfolio, amount, currency, horizon, riskProfile, errors });
});

// ── GET /health ───────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
    status: 'ok', version: '3.0.0', timestamp: Date.now(),
    marketaux: !!process.env.MARKETAUX_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
}));

// ── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ╔══════════════════════════════════╗`);
    console.log(`  ║  MERIDIAN Server v3.0            ║`);
    console.log(`  ║  http://0.0.0.0:${PORT}             ║`);
    console.log(`  ╚══════════════════════════════════╝\n`);
    console.log(`  Anthropic  : ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
    console.log(`  Marketaux  : ${process.env.MARKETAUX_API_KEY ? '✓' : '✗ MISSING'}`);
    console.log(`  Password   : ${process.env.PASSWORD          ? '✓' : '✗ MISSING'}`);
    console.log(`  JWT        : ${process.env.JWT_SECRET        ? '✓' : '⚠ using fallback'}\n`);
    console.log(`  Endpoints:`);
    console.log(`    POST /login`);
    console.log(`    POST /api/analyze   (single country)`);
    console.log(`    POST /api/portfolio (multi-country + amount split)\n`);
});
server.timeout = 120000;
