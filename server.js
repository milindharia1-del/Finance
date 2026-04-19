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
const MAX_DAILY  = 20;
const MODEL      = 'claude-sonnet-4-6';

const rateLimits = {};
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(bp.json({ limit: '1mb' }));
app.get('/',                  (_q, r) => r.sendFile(path.join(__dirname, 'meridian-app.html')));
app.get('/meridian-app.html', (_q, r) => r.sendFile(path.join(__dirname, 'meridian-app.html')));

// ── Cache ─────────────────────────────────────────────────
function cacheFile(country, horizon, risk) {
    const k = `${country}_${horizon}_${risk}`.toLowerCase().replace(/[\s/]+/g,'_');
    return path.join(CACHE_DIR, `${k}.json`);
}
function readCache(country, horizon, risk) {
    try {
        const f = cacheFile(country, horizon, risk);
        if (!fs.existsSync(f)) return null;
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Date.now() - d.cachedAt > CACHE_TTL) { fs.unlinkSync(f); return null; }
        return d;
    } catch { return null; }
}
function writeCache(country, horizon, risk, data) {
    try { fs.writeFileSync(cacheFile(country, horizon, risk), JSON.stringify({ ...data, cachedAt: Date.now() }, null, 2)); }
    catch (e) { console.error('[cache]', e.message); }
}

// ── Horizon guidance ──────────────────────────────────────
const HORIZON_GUIDANCE = {
    '6m':  'Near-term catalysts, momentum, upcoming earnings. Prefer liquid large-caps.',
    '1y':  'Sector rotation, rate cycle, macro policy shifts. Balance defensive and growth.',
    '2y':  'Earnings trajectory, margin expansion, pricing power. Mix growth and value.',
    '3y':  'Structural trends, competitive moats, free cash flow consistency.',
    '4y':  'Long-term compounders, balance sheet strength, ESG and regulatory tailwinds.',
    '5y':  'Transformative themes, emerging middle class, infrastructure. Think in cycles.',
    '10y': 'Generational thesis: AI/automation, energy transition, demographics.',
};

// ── Claude call (no web search, zero timeout risk) ────────
async function callClaude(country, horizon, riskProfile) {
    const today   = new Date().toISOString().split('T')[0];
    const guide   = HORIZON_GUIDANCE[horizon] || HORIZON_GUIDANCE['1y'];

    const system = `You are a senior global macro investment analyst with 25+ years of experience. \
Respond ONLY with valid raw JSON — no markdown, no code fences, no explanation. \
Start with { and end with }.`;

    const user = `Today is ${today}. Analyse the ${country} stock market for a ${riskProfile} investor \
with a ${horizon} investment horizon.

Horizon focus: ${guide}

Return ONLY this JSON:
{
  "country": "${country}",
  "flag": "flag emoji",
  "exchange": "main exchange(s)",
  "outlook": "Bullish",
  "confidence": 72,
  "summary": "2-3 sentence market overview",
  "whyNow": "1-2 sentences on the key opportunity for ${horizon} horizon",
  "horizon": "${horizon}",
  "riskProfile": "${riskProfile}",
  "sectors": [
    { "name": "Sector", "reason": "why this sector for ${horizon}" }
  ],
  "companies": [
    { "ticker": "TICK", "name": "Company", "exchange": "Exchange", "reason": "thesis", "conviction": "High" }
  ],
  "risks": ["risk 1", "risk 2", "risk 3"],
  "suggestedAllocationPct": 20,
  "entryStrategy": "Lump sum"
}

Include 3 sectors and 3-5 companies suited to ${horizon} horizon and ${riskProfile} risk profile.`;

    // Retry up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const resp = await axios.post(
                'https://api.anthropic.com/v1/messages',
                { model: MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] },
                {
                    headers: {
                        'x-api-key':         process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01',
                        'content-type':      'application/json',
                    },
                    timeout: 45000,
                }
            );
            return extractJSON(resp.data.content);
        } catch (err) {
            const retry = err.code === 'ECONNABORTED' || (err.response?.status >= 500);
            if (retry && attempt === 1) {
                console.log(`[claude] attempt 1 failed (${err.message}), retrying in 3s…`);
                await new Promise(r => setTimeout(r, 3000));
            } else throw err;
        }
    }
}

function extractJSON(content = []) {
    const texts = content.filter(b => b.type === 'text').map(b => b.text);
    for (let i = texts.length - 1; i >= 0; i--) {
        const s = texts[i].replace(/^```(?:json)?\n?/m,'').replace(/\n?```$/m,'').trim();
        for (const src of [s, texts[i].trim()]) {
            try { const p = JSON.parse(src); if (p.outlook || p.sectors) return p; } catch {}
        }
        const m = texts[i].match(/\{[\s\S]*?"(?:outlook|sectors)"[\s\S]*?\}/);
        if (m) { try { return JSON.parse(m[0]); } catch {} }
    }
    throw new Error('Could not parse JSON from Claude response');
}

// ── Auth ──────────────────────────────────────────────────
function requireAuth(req, res, next) {
    const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7) : req.body?.token;
    if (!bearer) return res.status(401).json({ success: false, error: 'Authentication required' });
    try { req.user = jwt.verify(bearer, JWT_SECRET); next(); }
    catch { res.status(401).json({ success: false, error: 'Session expired — please log in again' }); }
}

function rateLimit(req, res, next) {
    const id = req.user.user, today = new Date().toDateString();
    if (!rateLimits[id] || rateLimits[id].date !== today) rateLimits[id] = { count: 0, date: today };
    if (rateLimits[id].count >= MAX_DAILY)
        return res.status(429).json({ success: false, error: 'Daily limit reached. Cached results still available.' });
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

// ── POST /api/analyze ─────────────────────────────────────
app.post('/api/analyze', requireAuth, rateLimit, async (req, res) => {
    const { country, horizon = '1y', riskProfile = 'balanced' } = req.body || {};
    if (!country) return res.status(400).json({ success: false, error: 'country is required' });

    const cached = readCache(country, horizon, riskProfile);
    if (cached) return res.json({ success: true, ...cached, fromCache: true });

    try {
        const data   = await callClaude(country, horizon, riskProfile);
        const result = { ...data, timestamp: Date.now(), fromCache: false };
        writeCache(country, horizon, riskProfile, result);
        rateLimits[req.user.user].count++;
        res.json({ success: true, ...result });
    } catch (err) {
        const apiErr = err.response?.data?.error?.message || err.response?.data?.message;
        console.error('[/api/analyze]', apiErr || err.message, err.response?.data || '');
        res.status(err.response?.status || 500).json({ success: false, error: apiErr || err.message });
    }
});

// ── GET /health ───────────────────────────────────────────
app.get('/health', (_q, r) => r.json({ status: 'ok', version: '4.0.0', timestamp: Date.now() }));

// ── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  MERIDIAN v4.0  →  http://0.0.0.0:${PORT}\n`);
    console.log(`  Anthropic : ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
    console.log(`  Password  : ${process.env.PASSWORD          ? '✓' : '✗ MISSING'}`);
    console.log(`  JWT       : ${process.env.JWT_SECRET        ? '✓' : '⚠ fallback'}\n`);
});
server.timeout = 120000;
