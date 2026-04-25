# ClerkAI Cloudflare Workers Deployment Guide

## Prerequisites

1. **Cloudflare Account**: [Sign up here](https://dash.cloudflare.com/sign-up)
2. **Node.js & npm**: [Download](https://nodejs.org)
3. **Wrangler CLI**: `npm install -g wrangler`

## Step 1: Create KV Namespace

```bash
wrangler kv:namespace create "CLERK_KV"
wrangler kv:namespace create "CLERK_KV" --preview
```

Copy the returned namespace IDs and add to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CLERK_KV"
id = "your-production-id-here"
preview_id = "your-preview-id-here"
```

## Step 2: Set Admin Secret

```bash
wrangler secret put ADMIN_SECRET
# Enter your secret (e.g., a strong password)
```

## Step 3: Test Locally

```bash
wrangler dev
```

Test the health endpoint:
```bash
curl http://localhost:8787/health
```

## Step 4: Deploy to Cloudflare

```bash
wrangler publish
```

You'll receive a URL like: `https://clerkai-medical-worker.{your-subdomain}.workers.dev`

## Step 5: Configure GitHub Secrets for CI/CD

Go to **Settings → Secrets and variables → Actions** and add:

- **CLOUDFLARE_API_TOKEN**: [Generate here](https://dash.cloudflare.com/profile/api-tokens)
  - Scope: `Account.Workers Scripts - Edit`
- **CLOUDFLARE_ACCOUNT_ID**: From your [Cloudflare dashboard](https://dash.cloudflare.com)

Once added, every push to `main` will auto-deploy!

## API Endpoints

### Health Check
```bash
GET /health
```

### Start Session
```bash
POST /session/start
Body: { "caseId": "case_id", "learnerId": "learner_id" }
```

### Send Message
```bash
POST /session/message
Body: { "sessionId": "...", "message": "..." }
```

### Get Session State
```bash
GET /session/state?sessionId=...
```

### Ingest Cases (Admin Only)
```bash
POST /admin/ingest
Headers: { "Authorization": "Bearer {ADMIN_SECRET}" }
Body: { "cases": [...], "knowledge": {...}, "intentBank": {...} }
```

## Troubleshooting

### KV Binding Error
**Issue**: "CLERK_KV is not defined"
- Check `wrangler.toml` has correct binding name
- Verify namespace IDs are set

### Authentication Failed
**Issue**: "Unauthorized" on admin endpoints
- Ensure `ADMIN_SECRET` is set: `wrangler secret put ADMIN_SECRET`
- Use correct header: `Authorization: Bearer {your-secret}`

### Deployment Fails in GitHub Actions
- Check that `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set in repo secrets
- Verify token has `Account.Workers Scripts - Edit` permission

## Next Steps

1. **Ingest case data** via `/admin/ingest`
2. **Build frontend** to consume the API
3. **Monitor logs**: `wrangler tail`
