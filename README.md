# MERIDIAN — Global Investment Intelligence

An AI-powered investment advisor that analyses current global macro events and recommends long-term stock market investments across 13 markets: 🇺🇸 US · 🇬🇧 UK · 🇮🇳 India · 🇩🇪 Germany · 🇯🇵 Japan · 🇫🇷 France · 🇨🇳 China · 🇦🇺 Australia · 🇨🇦 Canada · 🇰🇷 South Korea · 🇸🇬 Singapore · 🇧🇷 Brazil · 🇨🇭 Switzerland

Built for **1–10 year investment horizons** — not day trading.

## Features

- Claude-powered macro analysis per country and time horizon
- Sector recommendations, top stock picks, and portfolio allocation
- Optional live news context via [Marketaux](https://www.marketaux.com/)
- Portfolio optimizer across multiple markets
- 7-day server-side caching to reduce API usage
- PWA-ready with offline support

## Quick Start

See [SETUP.md](./SETUP.md) for full deployment instructions.

```bash
git clone https://github.com/milindharia1-del/Finance.git
cd Finance
cp .env.example .env   # fill in your API keys
npm install
npm start              # http://localhost:3000
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key (`sk-ant-…`) |
| `PASSWORD` | ✅ | Login password for the app |
| `JWT_SECRET` | ✅ | Random string ≥ 32 chars |
| `MARKETAUX_API_KEY` | optional | Enables live news headlines |
| `PORT` | optional | Default: `3000` |

## Tech Stack

- **Backend**: Node.js + Express
- **AI**: Anthropic Claude (`claude-sonnet-4-6`)
- **Frontend**: Single-file HTML/CSS/JS (`meridian-app.html`)
