# ClerkAI — Cloudflare Worker Suite
### Zero-LLM Medical Intelligence Backend

---

## What this does

This Cloudflare Worker is the intelligent backend for your **ClerkAI** virtual clerking app. It runs entirely without an LLM — instead using a medically-trained rule engine for:

| Feature | How it works |
|---|---|
| **Patient simulation** | 50+ intent patterns matched against student input → case-specific responses |
| **Danger detection** | Regex trap engine catches unsafe clinical choices → penalty scores |
| **Case storage** | Your knowledge bank uploads to Cloudflare KV — served globally |
| **Score persistence** | Scores stored in KV with 90-day TTL |
| **Knowledge pearls** | Clinical teaching points attached to responses from your knowledge bank |
| **Leaderboard** | Top scores per discipline |

---

## Setup — 5 steps

### 1. Install Wrangler CLI
```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespaces
```bash
wrangler kv:namespace create "CASES_KV"
wrangler kv:namespace create "CASES_KV" --preview
wrangler kv:namespace create "SCORES_KV"
wrangler kv:namespace create "SCORES_KV" --preview
wrangler kv:namespace create "KNOWLEDGE_KV"
wrangler kv:namespace create "KNOWLEDGE_KV" --preview
```

Paste the IDs returned into `wrangler.toml`.

### 3. Set your admin secret
```bash
wrangler secret put ADMIN_SECRET
# Enter a strong password — this protects your /admin/ingest endpoint
```

### 4. Deploy
```bash
wrangler deploy
# You'll get a URL like: https://clerkai-medical-worker.yourname.workers.dev
```

### 5. Update your HTML app
In `clerkAI-v12.html`, find the `WORKER_URL` constant and update it:
```javascript
const WORKER_URL = 'https://clerkai-medical-worker.yourname.workers.dev';
```

---

## API Endpoints

### `GET /health`
Check the worker is live.
```json
{ "status": "online", "engine": "ClerkAI Medical Engine v1.0" }
```

### `GET /cases?discipline=peds|med|surg|og`
Returns cases for a discipline. Checks KV first, falls back to built-in bank.
```json
{ "cases": [...], "source": "kv", "count": 3 }
```

### `POST /chat`
The patient simulation engine.
```json
// Request
{
  "caseId": "case_surg_appendicitis_001",
  "message": "When did the pain start?",
  "askedIntents": [],
  "conversationHistory": []
}

// Response
{
  "reply": "It started about 18 hours ago...",
  "intentId": "hpc_onset",
  "type": "history",
  "score": 15,
  "isDangerous": false
}
```

### `POST /scores`
Record a completed case score.
```json
{
  "caseId": "case_surg_appendicitis_001",
  "score": 120,
  "penalties": 15,
  "correct": true,
  "userId": "Dr Amaka"
}
```

### `GET /leaderboard?discipline=surg&limit=10`
Top scores leaderboard.

### `POST /admin/ingest` *(requires Bearer token)*
Upload your medical knowledge bank and new cases.
```bash
curl -X POST https://your-worker.workers.dev/admin/ingest \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d @knowledge-bank-example.json
```

### `GET /admin/knowledge?topic=acute_appendicitis&key=YOUR_SECRET`
Query a specific topic in your knowledge bank.

---

## Loading your own Knowledge Bank

Your knowledge bank is a JSON file. See `knowledge-bank-example.json` for the full schema.

It supports three sections:
1. **`cases`** — New or updated clinical cases (merged into KV by `caseId`)
2. **`knowledge`** — Medical topic data with clinical pearls (keyed by topic name)
3. **`articles`** — Free-form reference articles (stored by `id`)

### Case schema
```json
{
  "caseId": "case_med_myocarditis_001",   // unique ID
  "discipline": "med",                    // peds | med | surg | og
  "difficulty": "hard",                   // beginner | intermediate | hard
  "timeLimit": 600,                       // seconds
  "hospital": "UCH Ibadan",
  "patient": { "name": "...", "age": 40, "sex": "Male", "avatar": "👨" },
  "presentingComplaint": "Chest pain and dyspnoea for 3 days",
  "diagnosis": {
    "primary": "Acute Myocarditis",
    "keywords": ["myocarditis", "viral myocarditis"]
  },
  "differentials": [
    { "name": "Acute Myocarditis", "color": "#6B4520", "initial": 40 },
    ...
  ],
  "trapActions": [
    { "pattern": "nsaid|ibuprofen", "penalty": 20, "explanation": "⛔ ..." }
  ],
  "intentMap": {
    "hpc_onset": { "text": "Patient response...", "type": "history", "label": "Onset" },
    "exam_cardiovascular": { "text": "Findings...", "type": "exam", "label": "Cardiac exam" },
    "ix_ecg": { "text": "ECG report...", "type": "investigation", "label": "ECG" }
  },
  "scoringMap": {
    "mustAsk": ["hpc_onset", "exam_cardiovascular", "ix_ecg"],
    "shouldAsk": ["sr_fever", "ix_fbc"],
    "pointsBase": 5,
    "pointsMust": 15
  }
}
```

### Knowledge pearl schema
Pearls are attached to patient responses in real-time when a knowledge topic matches the case diagnosis and intent:
```json
"acute_myocarditis": {
  "summary": "Brief overview...",
  "pearls": {
    "hpc_onset": "Teaching point for this intent in this condition...",
    "exam_cardiovascular": "What to look for..."
  }
}
```

---

## Integrating /chat into the app

The worker's `/chat` endpoint replaces the local intent-matching in the HTML. To use it, modify `sendMessage()` in the app:

```javascript
// In clerkAI-v12.html — replace local processInput() call with:
const resp = await fetch(`${WORKER_URL}/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    caseId: state.currentCase.caseId,
    message: userMessage,
    askedIntents: Array.from(state.askedIntents),
    conversationHistory: state.conversationHistory.slice(-10)
  }),
  signal: AbortSignal.timeout(3000)
});
const data = await resp.json();
// data.reply, data.intentId, data.score, data.isDangerous
```

---

## Architecture

```
Student message
     │
     ▼
┌─────────────────────────────────────┐
│  Danger Check Engine                │ ← trapActions + global patterns
│  (regex-based, zero-latency)        │
└────────────────┬────────────────────┘
                 │ safe
                 ▼
┌─────────────────────────────────────┐
│  Medical NLP Intent Classifier      │ ← 50+ intent patterns
│  (keyword + phrase scoring)         │ ← ranked by confidence score
└────────────────┬────────────────────┘
                 │ intent
                 ▼
┌─────────────────────────────────────┐
│  Case Response Lookup               │ ← KV → built-in case bank
│  + Scoring Engine                   │ ← mustAsk/shouldAsk/base
└────────────────┬────────────────────┘
                 │ response
                 ▼
┌─────────────────────────────────────┐
│  Knowledge Pearl Enrichment         │ ← KNOWLEDGE_KV lookup
│  (optional teaching points)         │ ← only on first ask
└────────────────┬────────────────────┘
                 │
                 ▼
            JSON response
```

---

## Local development
```bash
wrangler dev
# Runs on http://localhost:8787
```
