require('dotenv').config();
const express = require('express');
const jwt     = require('jsonwebtoken');
const axios   = require('axios');
const cors        = require('cors');
const compression = require('compression');
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
app.use(compression());
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
    const today = new Date().toISOString().split('T')[0];
    const guide = HORIZON_GUIDANCE[horizon] || HORIZON_GUIDANCE['1y'];

    // System prompt as array enables Anthropic prompt caching (saves ~20-30% input cost)
    const system = [{
        type: 'text',
        text: `You are a senior global macro investment analyst with 25+ years of experience. \
Respond ONLY with valid raw JSON — no markdown, no code fences, no explanation. \
Start with { and end with }.`,
        cache_control: { type: 'ephemeral' },
    }];

    const user = `Today is ${today}. Analyse the ${country} stock market for a ${riskProfile} investor \
with a ${horizon} investment horizon.

Horizon focus: ${guide}

Return ONLY this JSON (no markdown, no code fences, no extra text):
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
  "bearReturnPct": -4,
  "baseReturnPct": 12,
  "bullReturnPct": 22,
  "expectedAnnualReturnPct": 12,
  "currencyRisk": "Low — market trades in USD, no conversion risk",
  "sectors": [
    { "name": "Sector", "reason": "why this sector for ${horizon}" }
  ],
  "companies": [
    {
      "ticker": "TICK",
      "name": "Company",
      "exchange": "Exchange",
      "reason": "1-sentence investment thesis",
      "conviction": "High",
      "allocationPct": 25,
      "expectedAnnualReturnPct": 15,
      "dividendYield": 2.3,
      "valuationContext": "Trades at 18x forward P/E vs sector 26x — discount",
      "catalysts": ["Q4 earnings beat expected Mar 2025", "New product launch H1 2025"]
    }
  ],
  "risks": ["risk 1", "risk 2", "risk 3"],
  "suggestedAllocationPct": 20,
  "entryStrategy": "Lump sum"
}

Rules:
- Include exactly 3 sectors
- Include 4-5 companies; their allocationPct values MUST sum to exactly 100
- bearReturnPct: realistic downside annual return (can be negative)
- baseReturnPct: most likely annual return (same as expectedAnnualReturnPct)
- bullReturnPct: realistic upside annual return — all three must differ
- currencyRisk: 1 sentence on FX exposure for a ${riskProfile} investor
- dividendYield: use 0 if no dividend; number only, no % sign
- valuationContext: 1 short sentence on current valuation vs peers
- catalysts: exactly 2 near-term events with approximate dates
- conviction: "High", "Medium", or "Low" only`;

    // Retry up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const resp = await axios.post(
                'https://api.anthropic.com/v1/messages',
                { model: MODEL, max_tokens: 3200, system, messages: [{ role: 'user', content: user }] },
                {
                    headers: {
                        'x-api-key':         process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01',
                        'anthropic-beta':    'prompt-caching-2024-07-31',
                        'content-type':      'application/json',
                    },
                    timeout: 45000,
                }
            );
            if (resp.data.stop_reason === 'max_tokens')
                console.warn('[claude] response truncated — increase max_tokens');
            return extractJSON(resp.data.content);
        } catch (err) {
            // Only retry on server-side errors (529 rate-limit, 503), NOT on timeout
            const retry = err.response?.status === 529 || err.response?.status === 503;
            if (retry && attempt === 1) {
                console.log(`[claude] attempt 1 failed (${err.response?.status}), retrying in 3s…`);
                await new Promise(r => setTimeout(r, 3000));
            } else throw err;
        }
    }
}

function extractJSON(content = []) {
    const texts = content.filter(b => b.type === 'text').map(b => b.text);
    for (let i = texts.length - 1; i >= 0; i--) {
        const raw = texts[i];
        // Strip markdown fences if present
        const stripped = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
        // Try direct parse first (ideal case — Claude returned clean JSON)
        for (const src of [stripped, raw.trim()]) {
            try {
                const p = JSON.parse(src);
                if (p && typeof p === 'object' && !Array.isArray(p)) return p;
            } catch {}
        }
        // Fallback: extract the outermost {...} block
        const start = raw.indexOf('{');
        const end   = raw.lastIndexOf('}');
        if (start !== -1 && end > start) {
            try {
                const p = JSON.parse(raw.slice(start, end + 1));
                if (p && typeof p === 'object' && !Array.isArray(p)) return p;
            } catch {}
        }
        console.error('[extractJSON] raw text (first 500):', raw.slice(0, 500));
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
    if (cached) { console.log(`[analyze] ${country} — cache hit`); return res.json({ success: true, ...cached, fromCache: true }); }

    const t0 = Date.now();
    console.log(`[analyze] ${country} — calling Claude…`);
    try {
        const data   = await callClaude(country, horizon, riskProfile);
        console.log(`[analyze] ${country} — done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
        const result = { ...data, timestamp: Date.now(), fromCache: false };
        writeCache(country, horizon, riskProfile, result);
        rateLimits[req.user.user].count++;
        res.json({ success: true, ...result });
    } catch (err) {
        const apiErr = err.response?.data?.error?.message || err.response?.data?.message;
        console.error(`[analyze] ${country} — FAILED after ${((Date.now()-t0)/1000).toFixed(1)}s:`, apiErr || err.message, err.response?.data || '');
        res.status(err.response?.status || 500).json({ success: false, error: apiErr || err.message });
    }
});

// ── POST /api/optimize ───────────────────────────────────
async function callClaudeOptimize(markets, horizon, riskProfile) {
    const system = [{
        type: 'text',
        text: `You are a portfolio optimization expert. Respond ONLY with valid raw JSON — no markdown, no explanation.`,
        cache_control: { type: 'ephemeral' },
    }];

    const marketLines = markets.map(m =>
        `- code:"${m.code}" | ${m.outlook || 'Neutral'} outlook | ${m.confidence || 70}% confidence | ${m.expectedAnnualReturnPct || 10}% est. annual return`
    ).join('\n');

    const riskGuide = riskProfile === 'aggressive'
        ? 'Concentrate heavily in highest-return markets — accept concentration risk.'
        : riskProfile === 'conservative'
        ? 'Favour diversification and lower-volatility markets even if returns are lower.'
        : 'Balance return potential with reasonable diversification across markets.';

    const user = `You are optimising a portfolio across ${markets.length} markets for a ${riskProfile} investor with a ${horizon} investment horizon. Goal: maximise risk-adjusted returns.

Markets (use exact code strings in your response):
${marketLines}

Risk guidance: ${riskGuide}

Return ONLY this JSON:
{
  "allocations": [
    { "code": "exact_code_from_above", "allocationPct": 65, "rationale": "1-sentence reason for this weight" }
  ],
  "optimizationNote": "1-2 sentences explaining the overall allocation strategy"
}

Rules:
- Include ALL ${markets.length} markets
- allocationPct values MUST sum to exactly 100
- Do NOT default to equal splits — differentiate based on fundamentals
- Higher confidence + higher return = higher weight for aggressive; more even for conservative`;

    const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: MODEL, max_tokens: 600, system, messages: [{ role: 'user', content: user }] },
        {
            headers: {
                'x-api-key':         process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-beta':    'prompt-caching-2024-07-31',
                'content-type':      'application/json',
            },
            timeout: 30000,
        }
    );
    return extractJSON(resp.data.content);
}

app.post('/api/optimize', requireAuth, async (req, res) => {
    const { markets, horizon = '1y', riskProfile = 'balanced' } = req.body || {};
    if (!markets || !Array.isArray(markets) || markets.length === 0)
        return res.status(400).json({ success: false, error: 'markets array required' });

    if (markets.length === 1)
        return res.json({ success: true, allocations: [{ code: markets[0].code, allocationPct: 100, rationale: 'Full allocation to single selected market.' }], optimizationNote: 'Only one market selected — 100% allocated.' });

    try {
        const result = await callClaudeOptimize(markets, horizon, riskProfile);
        // Validate: all codes present, sum to ~100
        const sum = (result.allocations || []).reduce((s, a) => s + (a.allocationPct || 0), 0);
        if (Math.abs(sum - 100) > 5) throw new Error(`Allocations sum to ${sum}, not 100`);
        res.json({ success: true, ...result });
    } catch (err) {
        const apiErr = err.response?.data?.error?.message || err.message;
        console.error('[/api/optimize]', apiErr);
        res.status(err.response?.status || 500).json({ success: false, error: apiErr });
    }
});

// ── GET /api/status ───────────────────────────────────────
app.get('/api/status', requireAuth, (req, res) => {
    const id    = req.user.user, today = new Date().toDateString();
    const used  = (rateLimits[id]?.date === today) ? rateLimits[id].count : 0;
    res.json({ success: true, used, remaining: MAX_DAILY - used, max: MAX_DAILY });
});

// ── GET /health ───────────────────────────────────────────
app.get('/health', (_q, r) => r.json({ status: 'ok', version: '4.1.0', timestamp: Date.now() }));

// ── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  MERIDIAN v4.0  →  http://0.0.0.0:${PORT}\n`);
    console.log(`  Anthropic : ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
    console.log(`  Password  : ${process.env.PASSWORD          ? '✓' : '✗ MISSING'}`);
    console.log(`  JWT       : ${process.env.JWT_SECRET        ? '✓' : '⚠ fallback'}\n`);
});
server.timeout = 120000;
