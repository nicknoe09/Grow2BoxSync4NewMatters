# clio-box-sync

Webhook service that listens for `matter.created` events from Clio, waits a configurable delay (default 60 minutes) for intake documents to be uploaded, then pulls all documents from Clio and uploads them to the matter's **Vital Documents** folder in Box. Sends a Slack DM confirmation when complete.

---

## How It Works

1. Clio fires `matter.created` webhook → this service receives it
2. Validates signature, checks responsible attorney matches `RESPONSIBLE_ATTORNEY_NAME`
3. Enqueues a delayed job (default 60 min) via BullMQ + Redis
4. When job fires:
   - Searches Box for the matter folder by matter number
   - Finds the `Vital Documents` subfolder
   - Pulls all documents from Clio API
   - Uploads each to Box `Vital Documents`
   - Sends Slack DM to `SLACK_DM_CHANNEL` with file list and Box link
5. On failure: Slacks an error message and retries up to 3 times

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CLIO_WEBHOOK_SECRET` | Yes | HMAC secret from Clio webhook settings |
| `CLIO_ACCESS_TOKEN` | Yes | Clio OAuth access token |
| `RESPONSIBLE_ATTORNEY_NAME` | Yes | Full name as shown in Clio (e.g. `Nick Noe`) |
| `DELAY_MINUTES` | No | Minutes to wait before syncing (default: `60`) |
| `BOX_CLIENT_ID` | Preferred | Box app client ID (for auto-refresh) |
| `BOX_CLIENT_SECRET` | Preferred | Box app client secret |
| `BOX_REFRESH_TOKEN` | Preferred | Box OAuth refresh token |
| `BOX_ACCESS_TOKEN` | Fallback | Static Box token (expires ~60 min) |
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-...`) |
| `SLACK_DM_CHANNEL` | Yes | Slack channel/DM ID (default: `UQCGA53CJ`) |
| `REDIS_URL` | Yes | Redis connection URL |
| `PORT` | No | HTTP port (default: `3000`) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |

Copy `.env.example` to `.env` and fill in values.

---

## Setup

### 1. Register Webhook in Clio

1. Log into Clio → **Settings → Integrations → Webhooks**
2. Click **New Webhook**
3. Resource: `Matter` | Event: `Created`
4. URL: `https://your-railway-url.railway.app/webhooks/clio`
5. Copy the signing secret into `CLIO_WEBHOOK_SECRET`

### 2. Get Clio Access Token

1. Go to [Clio Developer Portal](https://app.clio.com/settings/developer_applications)
2. Create or use an existing app
3. Generate an access token and set as `CLIO_ACCESS_TOKEN`

> Note: Clio access tokens expire. For production use, implement Clio OAuth refresh flow or regenerate periodically.

### 3. Get Box OAuth Credentials (Preferred)

Box access tokens expire every 60 minutes. Use refresh token flow for unattended operation:

1. Go to [Box Developer Console](https://developer.box.com)
2. Create an app → OAuth 2.0 → Standard Access
3. Add redirect URI (can be localhost for initial token generation)
4. Use the Box CLI or OAuth flow to generate an initial `access_token` + `refresh_token`
5. Set `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `BOX_REFRESH_TOKEN`

The service auto-refreshes the token in memory. **Important:** If the service restarts, you'll need to provide a fresh `BOX_REFRESH_TOKEN` (Box rotates refresh tokens on each use).

**Fallback:** Set `BOX_ACCESS_TOKEN` with your current token from the Box File Manager MCP. Works for ~60 min per token.

### 4. Slack Bot Token

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create app → **Bot Token Scopes:** `chat:write`
3. Install to workspace → copy `Bot User OAuth Token` → set as `SLACK_BOT_TOKEN`
4. Invite bot to your DM: `/invite @your-bot-name`

---

## Deploy to Railway

### New project:

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```

### Add Redis:

In Railway dashboard → **New Service → Database → Redis**. Railway auto-sets `REDIS_URL`.

### Set environment variables:

In Railway dashboard → your service → **Variables**, add all required env vars from `.env.example`.

### Get your URL:

Railway dashboard → Settings → Domains → Generate Domain. Use this as your Clio webhook URL.

---

## Local Development

```bash
# Start Redis + app
docker-compose up

# Or run app directly (requires Redis running locally)
npm install
cp .env.example .env   # fill in values
npm run dev
```

Test the webhook locally:
```bash
curl -X POST http://localhost:3000/webhooks/clio \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "matter",
    "action": "created",
    "data": {
      "id": 12345,
      "display_number": "01001",
      "description": "Test Matter",
      "responsible_attorney": {"name": "Nick Noe"},
      "client": {"id": 99, "name": "Smith, John"}
    }
  }'
```

Check queue health:
```bash
curl http://localhost:3000/health
```

---

## File Structure

```
src/
  index.js      — Express server, startup
  webhook.js    — POST /webhooks/clio handler + signature validation
  queue.js      — BullMQ setup, job enqueue, worker
  sync.js       — Core sync: Clio docs → Box Vital Documents → Slack
  box-auth.js   — Box OAuth token manager with auto-refresh
  logger.js     — Lightweight logger
```
