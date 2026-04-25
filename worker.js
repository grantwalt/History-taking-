/**
 * ============================================================
 * ClerkAI Clinical Reasoning Engine — Cloudflare Worker v2.0
 * ============================================================
 *
 * Architecture:
 *   User Input → Intent Normalization → Unlock Check →
 *   State Check → Response Selection → Tone Adjustment →
 *   Progression Engine → Return Response
 *
 * Storage Layout (Cloudflare KV):
 *   case:{caseId}           → Case JSON (static, from knowledge bank)
 *   session:{sessionId}     → Session state (mutable, per learner)
 *   intent:bank             → Global intent bank (shared, static)
 *   knowledge:{topic}       → Knowledge pearls (static)
 *
 * Cloudflare Bindings required (wrangler.toml):
 *   [[kv_namespaces]]
 *   binding = "CLERK_KV"
 *   id = "..."
 */

// ============================================================
// ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const router = new Router(env);

    try {
      if (url.pathname === "/session/start" && request.method === "POST") {
        return router.handleStartSession(request);
      }
      if (url.pathname === "/session/message" && request.method === "POST") {
        return router.handleMessage(request);
      }
      if (url.pathname === "/session/state" && request.method === "GET") {
        return router.handleGetState(request);
      }
      if (url.pathname === "/admin/ingest" && request.method === "POST") {
        return router.handleIngest(request);
      }
      if (url.pathname === "/health" && request.method === "GET") {
        return jsonResponse({ status: "online", engine: "ClerkAI v2.0", timestamp: Date.now() });
      }
      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal server error", detail: err.message }, 500);
    }
  },
};

// ============================================================
// ROUTER
// ============================================================

class Router {
  constructor(env) {
    this.env = env;
    this.kv = env.CLERK_KV;
  }

  async handleStartSession(request) {
    const { caseId, learnerId } = await request.json();
    if (!caseId || !learnerId) {
      return jsonResponse({ error: "caseId and learnerId are required" }, 400);
    }

    const caseData = await this.kv.get(`case:${caseId}`, "json");
    if (!caseData) return jsonResponse({ error: "Case not found" }, 404);

    const sessionId = `${learnerId}_${caseId}_${Date.now()}`;
    const initialState = buildInitialState(caseData, sessionId, learnerId);
    await this.kv.put(`session:${sessionId}`, JSON.stringify(initialState), {
      expirationTtl: 86400, // 24 hours
    });

    return jsonResponse({
      sessionId,
      patient: caseData.patient,
      presentingComplaint: caseData.presentingComplaint,
      message: `Patient ${caseData.patient.name}, ${caseData.patient.age}. ${caseData.presentingComplaint}. You may begin your consultation.`,
      timeLimit: caseData.timeLimit,
    });
  }

  async handleMessage(request) {
    const { sessionId, message } = await request.json();
    if (!sessionId || !message) {
      return jsonResponse({ error: "sessionId and message required" }, 400);
    }

    const [sessionState, intentBank] = await Promise.all([
      this.kv.get(`session:${sessionId}`, "json"),
      this.kv.get("intent:bank", "json"),
    ]);
    if (!sessionState) return jsonResponse({ error: "Session not found or expired" }, 404);

    const caseData = await this.kv.get(`case:${sessionState.caseId}`, "json");
    if (!caseData) return jsonResponse({ error: "Case data missing" }, 500);

    const engine = new ClinicalReasoningEngine(caseData, intentBank);
    const result = engine.process(message, sessionState);

    await this.kv.put(`session:${sessionId}`, JSON.stringify(result.newState), {
      expirationTtl: 86400,
    });

    return jsonResponse(result.response);
  }

  async handleGetState(request) {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return jsonResponse({ error: "sessionId required" }, 400);

    const state = await this.kv.get(`session:${sessionId}`, "json");
    if (!state) return jsonResponse({ error: "Session not found" }, 404);
    return jsonResponse(state);
  }

  async handleIngest(request) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${this.env.ADMIN_SECRET}`) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = await request.json();
    const results = { cases: [], knowledge: [], articles: [], intentBank: null };

    if (body.cases) {
      for (const c of body.cases) {
        await this.kv.put(`case:${c.caseId}`, JSON.stringify(c));
        results.cases.push(c.caseId);
      }
    }
    if (body.knowledge) {
      for (const [topic, data] of Object.entries(body.knowledge)) {
        await this.kv.put(`knowledge:${topic}`, JSON.stringify(data));
        results.knowledge.push(topic);
      }
    }
    if (body.articles) {
      for (const article of body.articles) {
        await this.kv.put(`article:${article.id}`, JSON.stringify(article));
        results.articles.push(article.id);
      }
    }
    if (body.intentBank) {
      await this.kv.put("intent:bank", JSON.stringify(body.intentBank));
      results.intentBank = "updated";
    }

    return jsonResponse({ success: true, ingested: results });
  }
}

// ============================================================
// SESSION STATE FACTORY
// ============================================================

function buildInitialState(caseData, sessionId, learnerId) {
  return {
    sessionId,
    learnerId,
    caseId: caseData.caseId,
    startTime: Date.now(),
    elapsedSeconds: 0,
    unlockedIntents: [],
    askedIntents: [],
    scoreBreakdown: { total: 0 },
  };
}

// ============================================================
// CLINICAL REASONING ENGINE (Core)
// ============================================================

class ClinicalReasoningEngine {
  constructor(caseData, intentBank) {
    this.case = caseData;
    this.intentBank = intentBank || {};
  }

  process(rawInput, state) {
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    const updatedState = { ...state, elapsedSeconds: elapsed };
    const normalizedInput = normalizeText(rawInput);

    // Simple intent matching
    const matchedIntentId = this.matchIntent(normalizedInput);
    if (!matchedIntentId) {
      return {
        response: {
          type: "nomatch",
          text: "I'm sorry, I didn't understand that. Could you rephrase?",
        },
        newState: updatedState,
      };
    }

    const intentData = this.case.intentMap[matchedIntentId];
    if (!intentData) {
      return {
        response: { type: "nomatch", text: "That question isn't applicable to this case." },
        newState: updatedState,
      };
    }

    const alreadyAsked = state.askedIntents.includes(matchedIntentId);
    const isMust = (this.case.scoringMap?.mustAsk || []).includes(matchedIntentId);
    const pointsEarned = alreadyAsked ? 0 : (isMust ? 15 : 5);

    const newState = {
      ...updatedState,
      askedIntents: [...state.askedIntents, matchedIntentId],
      scoreBreakdown: {
        ...state.scoreBreakdown,
        total: (state.scoreBreakdown.total || 0) + pointsEarned,
      },
    };

    return {
      response: {
        type: "response",
        intentId: matchedIntentId,
        text: intentData.text || intentData.responses?.[0] || "...",
        pointsEarned,
        totalScore: newState.scoreBreakdown.total,
      },
      newState,
    };
  }

  matchIntent(normalizedInput) {
    let bestMatch = null;
    let bestScore = 0;

    for (const [intentId, intentData] of Object.entries(this.case.intentMap || {})) {
      let score = 0;
      const label = intentData.label?.toLowerCase() || "";
      if (normalizedInput.includes(label)) score += 10;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = intentId;
      }
    }

    return bestScore >= 1 ? bestMatch : null;
  }
}

// ============================================================
// TEXT NORMALIZATION
// ============================================================

function normalizeText(text) {
  let normalized = text.toLowerCase().trim();
  normalized = normalized.replace(/[^\w\s/]/g, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized;
}

// ============================================================
// RESPONSE HELPERS
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
