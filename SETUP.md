# MERIDIAN — Deployment Guide

## Prerequisites

- Node.js 18+ and npm
- Git
- PM2 process manager: `npm install -g pm2`

---

## 1. Clone & Install

```bash
git clone https://github.com/milindharia1-del/Finance.git
cd Finance
git checkout claude/meridian-investment-dashboard-Sfotm
npm install
```

---

## 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

Fill in the values:

```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx
PASSWORD=your-secure-password
JWT_SECRET=any-random-string-at-least-32-chars
PORT=3000
```

Save and exit (`Ctrl+X`, `Y`, `Enter`).

---

## 3. Start the Server

```bash
pm2 start server.js --name meridian
pm2 save
pm2 startup
```

Run the command that `pm2 startup` prints (it will look like `sudo env PATH=... pm2 startup ...`).

---

## 4. Open the App

Visit: **http://144.126.227.77:3000**

Log in with the `PASSWORD` you set in `.env`.

---

## 5. Verify

```bash
# Check server is running
pm2 status

# View live logs
pm2 logs meridian

# Health check
curl http://localhost:3000/health
```

Expected health response: `{"status":"ok","version":"4.0.0",...}`

---

## Updating

```bash
cd Finance
git pull origin claude/meridian-investment-dashboard-Sfotm
pm2 restart meridian
```

---

## Cache

Analysis results are cached in `./cache/` for 7 days. To clear all cached data:

```bash
rm -rf cache/*
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Port 3000 already in use | `pm2 delete meridian` then restart |
| `ANTHROPIC_API_KEY` missing | Check `.env` — key must start with `sk-ant-` |
| JWT errors on login | Ensure `JWT_SECRET` is set and not empty |
| App not reachable from browser | Check firewall: `ufw allow 3000` |
