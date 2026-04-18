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
const CACHE_TTL  = 7 * 24 * 60 * 60 * 1000;
const JWT_SECRET = process.env.JWT_SECRET || 'meridian_fallback_change_me';
const MAX_DAILY  = 5;

const MODEL      = 'claude-sonnet-4-20250514';
const rateLimits = {};

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(bp.json({ limit: '1mb' }));

// Serve frontend (never exposes .env or server.js)
app.get('/',                  (_req, res) => res.sendFile(path.join(__dirname, 'meridian-app.html')));
app.get('/meridian-app.html', (_req, res) => res.sendFile(path.join(__dirname, 'meridian-app.html')));

// ── Cache helpers ─────────────────────────────────────────
function cacheFile(country, riskProfile) {
    const key = `${country.toLowerCase().replace(/[\s/]+/g, '_')}_${riskProfile}`;
    return path.join(CACHE_DIR, `${key}.json`);
}
function readCache(country, riskProfile) {
    try {
        const file = cacheFile(country, riskProfile);
        if (!fs.existsSync(file)) return null;
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Date.now() - raw.cachedAt > CACHE_TTL) { fs.unlinkSync(file); return null; }
        return raw;
    } catch { return null; }
}
function writeCache(country, riskProfile, data) {
    try { fs.writeFileSync(cacheFile(country, riskProfile), JSON.stringify(data, null, 2)); }
    catch (e) { console.error('[cache write]', e.message); }
}

// ── Anthropic helper ──────────────────────────────────────
function anthropicHeaders() {
    return {
        'x-api-key':                process.env.ANTHROPIC_API_KEY,
        'anthropic-version':        '2023-06-01',
        'anthropic-beta':           'web-search-2025-03-05',
        'content-type':             'application/json',
    };
}
function extractText(content = []) {
    return content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
}
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

// ── STEP 1: Web Search — get latest news ──────────────────
async function getLatestNews(country) {
    console.log(`[Step 1] Fetching news for ${country}…`);
    const today = new Date().toISOString().split('T')[0];

    const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
            model: MODEL,
            max_tokens: 800,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
            messages: [{
                role: 'user',
                content: `Search for the latest news about the ${country} stock market as of ${today}. \
Include: recent economic data, central bank decisions, key earnings, sector trends, geopolitical events. \
Write a concise 200-250 word summary of the most important developments.`,
            }],
        },
        { headers: anthropicHeaders(), timeout: 60000 }
    );

    const summary = extractText(resp.data.content);
    if (!summary) throw new Error('No news summary returned from web search');
    console.log(`[Step 1] Got ${summary.split(' ').length} word summary`);
    return summary;
}

// ── STEP 2: Analysis — no web search, uses news context ───
async function analyzeMarket(country, riskProfile, newsContext) {
    console.log(`[Step 2] Analysing ${country} (${riskProfile})…`);

    const system = `You are a senior global macro investment analyst. \
You provide structured, data-driven long-term investment analysis. \
Respond ONLY with valid raw JSON — no markdown, no code fences, no explanation. \
Start with { and end with }.`;

    const user = `Latest market intelligence for ${country} (as of today):

${newsContext}

Using the above news AND your knowledge of ${country}'s economy and markets, \
provide a ${riskProfile} investor analysis for a 1–10 year horizon.

Return ONLY this JSON:
{
  "country": "${country}",
  "flag": "appropriate flag emoji",
  "exchange": "main stock exchange(s)",
  "outlook": "Bullish",
  "confidence": 72,
  "summary": "2-3 sentences grounded in the news above",
  "whyNow": "1-2 sentences on the key current opportunity or risk",
  "timeHorizon": "3-5 years",
  "riskProfile": "${riskProfile}",
  "sectors": [
    { "name": "Sector", "reason": "brief reason referencing current events" }
  ],
  "companies": [
    { "ticker": "TICK", "name": "Company", "exchange": "Exchange", "reason": "thesis", "conviction": "High" }
  ],
  "risks": ["risk 1", "risk 2", "risk 3"],
  "allocationPct": 15,
  "entryStrategy": "Phased over 6 months"
}

Include 3 sectors and 3-4 companies. Tailor for ${riskProfile} risk profile.`;

    const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
            model: MODEL,
            max_tokens: 1200,
            system,
            messages: [{ role: 'user', content: user }],
            // No web_search tool — uses news context from Step 1
        },
        { headers: anthropicHeaders(), timeout: 60000 }
    );

    const data = extractJSON(resp.data.content);
    console.log(`[Step 2] Analysis complete — outlook: ${data.outlook}`);
    return data;
}

// ── Auth middleware ───────────────────────────────────────
function requireAuth(req, res, next) {
    // Accept token from Authorization header OR request body
    const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : req.body?.token;

    if (!bearer) return res.status(401).json({ success: false, error: 'Authentication required' });
    try {
        req.user = jwt.verify(bearer, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ success: false, error: 'Token expired or invalid — please log in again' });
    }
}

// ── Rate limit middleware ─────────────────────────────────
function rateLimit(req, res, next) {
    const id    = req.user.user;
    const today = new Date().toDateString();
    if (!rateLimits[id] || rateLimits[id].date !== today) rateLimits[id] = { count: 0, date: today };
    if (rateLimits[id].count >= MAX_DAILY) {
        return res.status(429).json({
            success: false,
            error: `Daily limit of ${MAX_DAILY} live analyses reached. Cached results are still available.`,
        });
    }
    next();
}

// ── POST /login ───────────────────────────────────────────
app.post('/login', (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ success: false, error: 'Password is required' });
    if (password !== process.env.PASSWORD) return res.status(401).json({ success: false, error: 'Incorrect password' });

    const token = jwt.sign({ user: 'meridian_user' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, expiresIn: 86400 });
});

// ── POST /api/analyze ─────────────────────────────────────
app.post('/api/analyze', requireAuth, rateLimit, async (req, res) => {
    const { country, riskProfile = 'balanced' } = req.body || {};
    if (!country) return res.status(400).json({ success: false, error: 'country is required' });

    // Serve from cache if fresh
    const cached = readCache(country, riskProfile);
    if (cached) {
        console.log(`[cache hit] ${country} (${riskProfile})`);
        return res.json({ success: true, ...cached, fromCache: true });
    }

    try {
        // Step 1: get fresh news via web search (~10-15s)
        const newsContext = await getLatestNews(country);

        // Step 2: analyse using news context — no second web search (~5-10s)
        const analysis = await analyzeMarket(country, riskProfile, newsContext);

        const result = {
            ...analysis,
            newsContext,           // store so future cache hits can show it
            timestamp:  Date.now(),
            cachedAt:   Date.now(),
            fromCache:  false,
        };

        writeCache(country, riskProfile, result);
        rateLimits[req.user.user].count++;

        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[/api/analyze]', err.response?.data || err.message);
        res.status(err.response?.status || 500).json({
            success: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ── GET /api/cache-status ─────────────────────────────────
app.get('/api/cache-status', requireAuth, (_req, res) => {
    try {
        const entries = fs.readdirSync(CACHE_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
                    return { key: f.replace('.json', ''), ageDays: +((Date.now() - d.cachedAt) / 86400000).toFixed(1) };
                } catch { return null; }
            }).filter(Boolean);
        res.json({ entries, count: entries.length });
    } catch { res.json({ entries: [], count: 0 }); }
});

// ── GET /health ───────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: Date.now(), version: '2.1.0' }));

// ── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ╔══════════════════════════════════╗`);
    console.log(`  ║  MERIDIAN Server v2.1            ║`);
    console.log(`  ║  http://0.0.0.0:${PORT}             ║`);
    console.log(`  ╚══════════════════════════════════╝\n`);
    console.log(`  API key  : ${process.env.ANTHROPIC_API_KEY ? '✓ loaded' : '✗ MISSING'}`);
    console.log(`  Password : ${process.env.PASSWORD         ? '✓ set'    : '✗ MISSING'}`);
    console.log(`  JWT      : ${process.env.JWT_SECRET       ? '✓ set'    : '⚠ using fallback'}\n`);
    console.log(`  Two-step mode: Step1=web search (1 call) + Step2=analysis (1 call)\n`);
});
server.timeout = 150000; // 150s max per request
