require('dotenv').config();
const express  = require('express');
const jwt      = require('jsonwebtoken');
const axios    = require('axios');
const cors     = require('cors');
const bp       = require('body-parser');
const fs       = require('fs');
const path     = require('path');

const app       = express();
const PORT      = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_DAILY = 5;
const JWT_SECRET = process.env.JWT_SECRET || 'meridian_fallback_secret_change_me';

// In-memory rate limit store
const rateLimits = {};

// Ensure cache dir exists
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(bp.json({ limit: '1mb' }));

// Serve only the app HTML (never expose .env / server.js)
app.get('/',                  (req, res) => res.sendFile(path.join(__dirname, 'meridian-app.html')));
app.get('/meridian-app.html', (req, res) => res.sendFile(path.join(__dirname, 'meridian-app.html')));

// ── POST /login ───────────────────────────────────────────
app.post('/login', (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password is required' });

    if (password !== process.env.PASSWORD) {
        return res.status(401).json({ error: 'Incorrect password' });
    }

    const token = jwt.sign({ user: 'meridian_user' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, expiresIn: 86400 });
});

// ── Auth middleware ───────────────────────────────────────
function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        req.user = jwt.verify(auth.slice(7), JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Token expired or invalid — please log in again' });
    }
}

// ── Rate limit middleware ─────────────────────────────────
function rateLimit(req, res, next) {
    const id    = req.user.user;
    const today = new Date().toDateString();
    if (!rateLimits[id] || rateLimits[id].date !== today) {
        rateLimits[id] = { count: 0, date: today };
    }
    if (rateLimits[id].count >= MAX_DAILY) {
        return res.status(429).json({
            error: `Daily limit of ${MAX_DAILY} live analyses reached. Cached results are still available.`,
        });
    }
    next();
}

// ── Cache helpers ─────────────────────────────────────────
function cacheFile(country, riskProfile) {
    const key = `${country.toLowerCase().replace(/[\s/]+/g, '_')}_${riskProfile.toLowerCase()}`;
    return path.join(CACHE_DIR, `${key}.json`);
}

function readCache(country, riskProfile) {
    const file = cacheFile(country, riskProfile);
    try {
        if (!fs.existsSync(file)) return null;
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Date.now() - raw.cachedAt > CACHE_TTL) { fs.unlinkSync(file); return null; }
        return raw;
    } catch { return null; }
}

function writeCache(country, riskProfile, data) {
    const file = cacheFile(country, riskProfile);
    try { fs.writeFileSync(file, JSON.stringify({ ...data, cachedAt: Date.now() }, null, 2)); }
    catch (e) { console.error('Cache write error:', e.message); }
}

// ── Claude API call (with retry) ──────────────────────────
async function callClaude(country, riskProfile, attempt = 1) {
    const today = new Date().toISOString().split('T')[0];

    const system = `You are a senior global macro investment analyst with 25+ years of experience. \
Provide concise, data-driven long-term investment analysis. \
Respond with ONLY valid raw JSON — no markdown, no code fences, no explanation. \
Start your response with { and end with }.`;

    const user = `Search the web for the latest news on the ${country} stock market, economy, \
central bank decisions, and sector trends as of ${today}.

Return ONLY this JSON (no other text):
{
  "country": "${country}",
  "flag": "flag emoji",
  "exchange": "main exchange(s)",
  "outlook": "Bullish",
  "confidence": 75,
  "summary": "2-3 sentence market overview referencing specific recent events",
  "whyNow": "1-2 sentences on the key catalyst or opportunity right now",
  "timeHorizon": "3-5 years",
  "riskProfile": "${riskProfile}",
  "sectors": [
    { "name": "Sector Name", "reason": "brief reason tied to current events" }
  ],
  "companies": [
    { "ticker": "TICK", "name": "Company Name", "exchange": "Exchange", "reason": "investment thesis", "conviction": "High" }
  ],
  "risks": ["Specific risk 1", "Specific risk 2", "Specific risk 3"],
  "allocationPct": 15,
  "entryStrategy": "Phased over 6 months"
}

Include 3-4 sectors and 3-4 companies. Tailor for a ${riskProfile} risk profile investor.`;

    let resp;
    try {
        resp = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1500,
                system,
                tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
                messages: [{ role: 'user', content: user }],
            },
            {
                headers: {
                    'x-api-key': process.env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'web-search-2025-03-05',
                    'content-type': 'application/json',
                },
                timeout: 180000, // 3 minutes
            }
        );
    } catch (err) {
        // Retry on timeout (up to 2 attempts)
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.message?.includes('idle');
        if (isTimeout && attempt < 3) {
            console.log(`[callClaude] Timeout on attempt ${attempt}, retrying in 3s…`);
            await new Promise(r => setTimeout(r, 3000));
            return callClaude(country, riskProfile, attempt + 1);
        }
        throw err;
    }

    const texts = (resp.data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text);

    for (let i = texts.length - 1; i >= 0; i--) {
        const raw     = texts[i];
        const stripped = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

        for (const src of [stripped, raw.trim()]) {
            try {
                const p = JSON.parse(src);
                if (p.sectors || p.outlook || p.companies) return p;
            } catch {}
        }

        const m = raw.match(/\{[\s\S]*?"(?:outlook|sectors|companies)"[\s\S]*?\}/);
        if (m) { try { return JSON.parse(m[0]); } catch {} }
    }

    throw new Error('Could not parse structured response from Claude');
}

// ── POST /api/analyze ─────────────────────────────────────
app.post('/api/analyze', requireAuth, rateLimit, async (req, res) => {
    const { country, riskProfile = 'balanced' } = req.body || {};
    if (!country) return res.status(400).json({ error: 'country is required' });

    // Serve from cache if fresh
    const cached = readCache(country, riskProfile);
    if (cached) return res.json({ ...cached, fromCache: true });

    // Call Claude API
    try {
        const data   = await callClaude(country, riskProfile);
        const result = { ...data, timestamp: Date.now(), fromCache: false, cachedAt: Date.now() };
        writeCache(country, riskProfile, result);

        // Increment counter only on actual API call
        rateLimits[req.user.user].count++;

        res.json(result);
    } catch (err) {
        console.error('[/api/analyze error]', err.response?.data || err.message);
        res.status(err.response?.status || 500).json({
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ── GET /api/cache-status ─────────────────────────────────
app.get('/api/cache-status', requireAuth, (req, res) => {
    try {
        const files   = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
        const entries = files.map(f => {
            try {
                const d      = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
                const ageMs  = Date.now() - d.cachedAt;
                return { key: f.replace('.json', ''), ageDays: +(ageMs / 86400000).toFixed(1), expired: ageMs > CACHE_TTL };
            } catch { return null; }
        }).filter(Boolean);
        res.json({ entries, count: entries.length });
    } catch (e) {
        res.json({ entries: [], count: 0 });
    }
});

// ── GET /health ───────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: Date.now(), version: '2.0.0' }));

// ── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ╔══════════════════════════════════╗`);
    console.log(`  ║  MERIDIAN Server v2.0            ║`);
    console.log(`  ║  http://0.0.0.0:${PORT}             ║`);
    console.log(`  ╚══════════════════════════════════╝\n`);
    console.log(`  API key  : ${process.env.ANTHROPIC_API_KEY ? '✓ loaded' : '✗ MISSING — set ANTHROPIC_API_KEY in .env'}`);
    console.log(`  Password : ${process.env.PASSWORD         ? '✓ set'    : '✗ MISSING — set PASSWORD in .env'}`);
    console.log(`  JWT      : ${process.env.JWT_SECRET       ? '✓ set'    : '⚠ using fallback (set JWT_SECRET in .env)'}\n`);
});
server.timeout = 200000; // 200s — longer than axios timeout so Node never cuts first
