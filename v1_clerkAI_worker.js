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
      message: `Patient ${caseData.patient.name}, ${caseData.patient.age}F. ${caseData.presentingComplaint}. You may begin your consultation.`,
      timeLimit: caseData.timeLimit,
    });
  }

  async handleMessage(request) {
    const { sessionId, message } = await request.json();
    if (!sessionId || !message) {
      return jsonResponse({ error: "sessionId and message required" }, 400);
    }

    // Load session + case data in parallel
    const [sessionState, intentBank] = await Promise.all([
      this.kv.get(`session:${sessionId}`, "json"),
      this.kv.get("intent:bank", "json"),
    ]);
    if (!sessionState) return jsonResponse({ error: "Session not found or expired" }, 404);

    const caseData = await this.kv.get(`case:${sessionState.caseId}`, "json");
    if (!caseData) return jsonResponse({ error: "Case data missing" }, 500);

    const engine = new ClinicalReasoningEngine(caseData, intentBank);
    const result = engine.process(message, sessionState);

    // Persist updated state
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

    // Ingest cases
    if (body.cases) {
      for (const c of body.cases) {
        await this.kv.put(`case:${c.caseId}`, JSON.stringify(c));
        results.cases.push(c.caseId);
      }
    }
    // Ingest knowledge topics
    if (body.knowledge) {
      for (const [topic, data] of Object.entries(body.knowledge)) {
        await this.kv.put(`knowledge:${topic}`, JSON.stringify(data));
        results.knowledge.push(topic);
      }
    }
    // Ingest articles
    if (body.articles) {
      for (const article of body.articles) {
        await this.kv.put(`article:${article.id}`, JSON.stringify(article));
        results.articles.push(article.id);
      }
    }
    // Ingest intent bank
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
    severity: caseData.state?.severity || "moderate",
    uraemiaLevel: caseData.state?.uraemiaLevel || 1,
    hyperkalaemiaFlag: caseData.state?.hyperkalaemiaFlag || false,
    oedemaGrade: caseData.state?.oedemaGrade || 1,
    bpControl: caseData.state?.bpControl || "uncontrolled",
    nauseaActive: caseData.state?.nauseaActive || false,
    consciousness: caseData.state?.conscioussness || "alert",
    unlockedIntents: [],
    askedIntents: [],
    flaggedComplications: [],
    trapTriggered: [],
    mistakes: [],
    progressionEvents: [],
    scoreBreakdown: {
      historyCoverage: 0,
      examCompleteness: 0,
      investigationQuality: 0,
      managementScore: 0,
      trapPenalties: 0,
      total: 0,
    },
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

  /**
   * Main processing pipeline:
   * Input → Normalize → Trap Check → Intent Match →
   * Unlock Check → State Check → Response Select → Tone → Return
   */
  process(rawInput, state) {
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    const updatedState = { ...state, elapsedSeconds: elapsed };

    // STEP 1: Normalize input
    const normalizedInput = normalizeText(rawInput);

    // STEP 2: Check trap actions (before intent matching — traps are priority)
    const trapResult = this.checkTraps(normalizedInput, updatedState);
    if (trapResult.triggered) {
      const newState = this.applyTrapConsequences(trapResult, updatedState);
      const progressionEvents = this.checkProgressionEvents(newState);
      return {
        response: {
          type: "trap",
          text: trapResult.explanation,
          penalty: trapResult.penalty,
          correctAction: trapResult.correctAction,
          severity: trapResult.severity,
          progressionEvents,
          score: newState.scoreBreakdown,
        },
        newState: this.mergeProgressionState(newState, progressionEvents),
      };
    }

    // STEP 3: Match intent
    const matchedIntentId = this.matchIntent(normalizedInput);

    // STEP 4: Handle system intents (score, summary, diagnosis)
    if (matchedIntentId && this.isSystemIntent(matchedIntentId)) {
      return this.handleSystemIntent(matchedIntentId, normalizedInput, updatedState);
    }

    // STEP 5: Check if intent is a management action
    if (matchedIntentId && this.isManagementIntent(matchedIntentId)) {
      return this.handleManagement(matchedIntentId, normalizedInput, updatedState);
    }

    // STEP 6: Attempt to unlock intent (investigation prerequisite check)
    if (matchedIntentId) {
      const unlockResult = this.checkUnlock(matchedIntentId, updatedState);
      if (!unlockResult.allowed) {
        return {
          response: {
            type: "blocked",
            text: unlockResult.reason,
            hint: unlockResult.hint,
          },
          newState: updatedState,
        };
      }
    }

    // STEP 7: Fetch and select response
    const intentData = matchedIntentId
      ? this.case.intentMap[matchedIntentId]
      : null;

    if (!intentData) {
      return {
        response: {
          type: "nomatch",
          text: this.buildNoMatchResponse(normalizedInput, updatedState),
        },
        newState: updatedState,
      };
    }

    // STEP 8: Select response (state-aware)
    const responseText = this.selectResponse(intentData, updatedState, matchedIntentId);

    // STEP 9: Compute score delta
    const { newState: scoredState, pointsEarned } = this.applyScoring(
      matchedIntentId,
      intentData,
      updatedState
    );

    // STEP 10: Check progression events
    const progressionEvents = this.checkProgressionEvents(scoredState);
    const finalState = this.mergeProgressionState(scoredState, progressionEvents);

    // STEP 11: Assemble response with tone + clinical pearl
    const pearl = this.fetchClinicalPearl(matchedIntentId, intentData);

    return {
      response: {
        type: "response",
        intentId: matchedIntentId,
        label: intentData.label,
        category: intentData.category,
        tone: this.selectTone(intentData, finalState),
        text: responseText,
        pointsEarned,
        totalScore: finalState.scoreBreakdown.total,
        clinicalPearl: pearl,
        progressionEvents,
        alreadyAsked: state.askedIntents.includes(matchedIntentId),
      },
      newState: finalState,
    };
  }

  // ============================================================
  // INTENT NORMALIZATION LAYER
  // ============================================================

  /**
   * Match user input against:
   * 1) Global intent bank (regex + alias)
   * 2) Case-specific intent map (exact + fuzzy)
   * Returns the best matching intentId, or null.
   */
  matchIntent(normalizedInput) {
    let bestMatch = null;
    let bestScore = 0;

    // Phase 1: Match against global intent bank
    for (const [intentId, intentDef] of Object.entries(this.intentBank)) {
      // Only match intents that exist in this case's intentMap
      if (!this.case.intentMap[intentId]) continue;

      const score = this.scoreIntentMatch(normalizedInput, intentDef);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = intentId;
      }
    }

    // Phase 2: Fallback — match against case intentMap keys directly
    if (!bestMatch) {
      for (const intentId of Object.keys(this.case.intentMap)) {
        const intentDef = this.case.intentMap[intentId];
        // Simple label/id fuzzy match
        if (
          normalizedInput.includes(intentId.replace(/_/g, " ")) ||
          (intentDef.label && normalizedInput.includes(intentDef.label.toLowerCase()))
        ) {
          bestMatch = intentId;
          break;
        }
      }
    }

    return bestScore >= 1 ? bestMatch : null;
  }

  /**
   * Score how well an input matches an intent definition.
   * Uses regex patterns (score 3) and alias substring matching (score 1).
   * Regex match on 2+ words from alias = score 2.
   */
  scoreIntentMatch(input, intentDef) {
    let score = 0;

    // Regex pattern matching (highest confidence)
    if (intentDef.patterns) {
      for (const pattern of intentDef.patterns) {
        try {
          if (new RegExp(pattern, "i").test(input)) {
            score += 3;
            break; // One regex match is sufficient for high confidence
          }
        } catch (_) {
          // Malformed regex — skip silently
        }
      }
    }

    // Alias matching (lower confidence — partial substring)
    if (intentDef.aliases && score < 3) {
      for (const alias of intentDef.aliases) {
        if (input.includes(alias.toLowerCase())) {
          score += 2;
          break;
        }
        // Partial word overlap (at least 2 significant words)
        const aliasWords = alias.toLowerCase().split(" ").filter((w) => w.length > 3);
        const matchCount = aliasWords.filter((w) => input.includes(w)).length;
        if (matchCount >= 2) {
          score += 1;
          break;
        }
      }
    }

    return score;
  }

  // ============================================================
  // TRAP ACTION ENGINE
  // ============================================================

  checkTraps(input, state) {
    const traps = this.case.trapActions || [];
    for (const trap of traps) {
      const patternRx = new RegExp(trap.pattern, "i");
      const contextRx = trap.context ? new RegExp(trap.context, "i") : null;

      if (patternRx.test(input)) {
        // If context defined, both pattern AND context must match
        if (!contextRx || contextRx.test(input)) {
          // Avoid double-penalising the same trap in same session
          if (state.trapTriggered.includes(trap.id)) {
            return {
              triggered: true,
              alreadyPenalised: true,
              explanation: `⚠️ You have already been penalised for this. ${trap.explanation}`,
              penalty: 0,
              trap,
            };
          }
          return {
            triggered: true,
            alreadyPenalised: false,
            explanation: trap.explanation,
            penalty: trap.penalty,
            correctAction: trap.correctAction || null,
            severity: trap.severity,
            complicationTrigger: trap.complicationTrigger,
            trap,
          };
        }
      }
    }
    return { triggered: false };
  }

  applyTrapConsequences(trapResult, state) {
    const newState = { ...state };
    if (!trapResult.alreadyPenalised) {
      newState.trapTriggered = [...state.trapTriggered, trapResult.trap.id];
      newState.mistakes = [...state.mistakes, trapResult.trap.id];
      newState.scoreBreakdown = {
        ...state.scoreBreakdown,
        trapPenalties: state.scoreBreakdown.trapPenalties + trapResult.penalty,
        total: Math.max(0, state.scoreBreakdown.total - trapResult.penalty),
      };

      // Trigger complication if defined
      if (trapResult.complicationTrigger) {
        const complication = (this.case.complications || []).find(
          (c) => c.trigger === trapResult.complicationTrigger
        );
        if (complication && !newState.flaggedComplications.includes(complication.id)) {
          newState.flaggedComplications = [
            ...newState.flaggedComplications,
            complication.id,
          ];
        }
      }
    }
    return newState;
  }

  // ============================================================
  // UNLOCK (PREREQUISITE) CHECK
  // ============================================================

  checkUnlock(intentId, state) {
    const unlockMap = this.case.unlockConditions || {};
    const required = unlockMap[intentId];

    if (!required || required.length === 0) {
      return { allowed: true };
    }

    const missing = required.filter((req) => !state.askedIntents.includes(req));
    if (missing.length === 0) {
      return { allowed: true };
    }

    // Provide a helpful hint about what's missing
    const missingLabels = missing
      .map((id) => {
        const intent = this.case.intentMap[id];
        return intent ? intent.label : id;
      })
      .join(", ");

    return {
      allowed: false,
      reason: `🔒 You haven't yet gathered enough information to order this investigation. Ensure you have covered: ${missingLabels}.`,
      hint: `Complete the following first: ${missingLabels}`,
    };
  }

  // ============================================================
  // STATE-AWARE RESPONSE SELECTION
  // ============================================================

  selectResponse(intentData, state, intentId) {
    // Check condition overrides first (highest priority)
    if (intentData.conditions) {
      for (const [condition, conditionResponse] of Object.entries(intentData.conditions)) {
        if (this.evaluateCondition(condition, state)) {
          return conditionResponse;
        }
      }
    }

    // Already-asked variation (prevent exact repetition)
    const responses = intentData.responses || [];
    if (state.askedIntents.includes(intentId) && responses.length > 1) {
      // Rotate through responses based on ask count
      const askCount = state.askedIntents.filter((id) => id === intentId).length;
      return responses[askCount % responses.length];
    }

    // Default: first response (deterministic for reproducibility)
    return responses[0] || intentData.text || "...";
  }

  /**
   * Evaluate a condition string like "uraemiaLevel>=3" or "askedAfter:pmh_general"
   * Supported operators: =, !=, >=, <=, >, <
   * Supported prefixes: askedAfter:, trapTriggered:
   */
  evaluateCondition(condition, state) {
    // askedAfter: — check if a prior intent was asked
    if (condition.startsWith("askedAfter:")) {
      const reqIntent = condition.replace("askedAfter:", "");
      return state.askedIntents.includes(reqIntent);
    }

    // trapTriggered: — check if a trap was triggered
    if (condition.startsWith("trapTriggered:")) {
      const trapId = condition.replace("trapTriggered:", "");
      return state.trapTriggered.includes(trapId);
    }

    // complications: — check if complication is flagged
    if (condition.startsWith("complications:")) {
      const compId = condition.replace("complications:", "");
      return state.flaggedComplications.includes(compId);
    }

    // Simple equality/comparison: field=value, field>=value, etc.
    const opMatch = condition.match(/^(\w+)(>=|<=|!=|>|<|=)(.+)$/);
    if (opMatch) {
      const [, field, op, rawValue] = opMatch;
      const stateValue = state[field];
      const numValue = parseFloat(rawValue);
      const isNumeric = !isNaN(numValue);

      switch (op) {
        case "=":
          return String(stateValue) === rawValue;
        case "!=":
          return String(stateValue) !== rawValue;
        case ">=":
          return isNumeric && parseFloat(stateValue) >= numValue;
        case "<=":
          return isNumeric && parseFloat(stateValue) <= numValue;
        case ">":
          return isNumeric && parseFloat(stateValue) > numValue;
        case "<":
          return isNumeric && parseFloat(stateValue) < numValue;
      }
    }

    return false;
  }

  // ============================================================
  // SCORING ENGINE
  // ============================================================

  applyScoring(intentId, intentData, state) {
    // No points if already asked (first ask only)
    if (state.askedIntents.includes(intentId)) {
      return {
        newState: {
          ...state,
          askedIntents: [...state.askedIntents, intentId], // track repeated asks
        },
        pointsEarned: 0,
      };
    }

    const scoringMap = this.case.scoringMap || {};
    let pointsEarned = 0;

    if (scoringMap.mustAsk?.includes(intentId)) {
      pointsEarned = scoringMap.pointsMust || 15;
    } else if (scoringMap.shouldAsk?.includes(intentId)) {
      pointsEarned = scoringMap.pointsShould || 10;
    } else if (scoringMap.optional?.includes(intentId)) {
      pointsEarned = scoringMap.pointsOptional || 5;
    } else {
      pointsEarned = scoringMap.pointsBase || 5;
    }

    // Category-specific score tracking
    const categoryKey = intentData.category;
    const newBreakdown = { ...state.scoreBreakdown };
    const categoryMap = {
      history: "historyCoverage",
      exam: "examCompleteness",
      investigation: "investigationQuality",
      management: "managementScore",
    };
    const breakdownKey = categoryMap[categoryKey];
    if (breakdownKey) {
      newBreakdown[breakdownKey] = (newBreakdown[breakdownKey] || 0) + pointsEarned;
    }
    newBreakdown.total = (newBreakdown.total || 0) + pointsEarned;

    // Unlock the intent (marks it as explored)
    const newState = {
      ...state,
      askedIntents: [...state.askedIntents, intentId],
      unlockedIntents: state.unlockedIntents.includes(intentId)
        ? state.unlockedIntents
        : [...state.unlockedIntents, intentId],
      scoreBreakdown: newBreakdown,
    };

    return { newState, pointsEarned };
  }

  // ============================================================
  // PROGRESSION + CONSEQUENCE ENGINE
  // ============================================================

  checkProgressionEvents(state) {
    const events = this.case.timeEvents || [];
    const elapsed = state.elapsedSeconds;
    const triggered = [];

    for (const evt of events) {
      // Already fired?
      if (state.progressionEvents.includes(evt.id)) continue;

      // Time condition met?
      if (elapsed < evt.time) continue;

      // Additional condition check (e.g., triggerIfMissed)
      if (evt.triggerCondition && !this.evaluateProgressionCondition(evt.triggerCondition, state)) {
        continue;
      }
      if (evt.triggerIfMissed && state.askedIntents.includes(evt.triggerIfMissed)) {
        continue; // Avoided by the learner taking the right action
      }

      triggered.push(evt);
    }

    return triggered;
  }

  mergeProgressionState(state, events) {
    if (!events || events.length === 0) return state;

    let newState = { ...state };
    for (const evt of events) {
      newState.progressionEvents = [...newState.progressionEvents, evt.id];
      // Apply state changes from event
      if (evt.stateChange) {
        newState = { ...newState, ...evt.stateChange };
      }
      // Trigger complications
      if (evt.type === "complication") {
        const comp = (this.case.complications || []).find(
          (c) => c.id === `complication_arrhythmia`
        );
        if (comp && !newState.flaggedComplications.includes(comp.id)) {
          newState.flaggedComplications = [...newState.flaggedComplications, comp.id];
          // Apply penalty
          newState.scoreBreakdown = {
            ...newState.scoreBreakdown,
            trapPenalties: (newState.scoreBreakdown.trapPenalties || 0) + (comp.penaltyPoints || 0),
            total: Math.max(0, (newState.scoreBreakdown.total || 0) - (comp.penaltyPoints || 0)),
          };
        }
      }
    }

    return newState;
  }

  evaluateProgressionCondition(condition, state) {
    // Format: "ix_lft:not_asked", "hyperkalaemia:not_managed", "time > 300"
    if (condition.includes(":not_asked")) {
      const intentId = condition.replace(":not_asked", "");
      return !state.askedIntents.includes(intentId);
    }
    if (condition.includes(":not_managed")) {
      const concept = condition.replace(":not_managed", "");
      return !state.askedIntents.some((id) => id.includes(concept));
    }
    if (condition.includes(":asked")) {
      const intentId = condition.replace(":asked", "");
      return state.askedIntents.includes(intentId);
    }
    return true;
  }

  // ============================================================
  // TONE ADJUSTMENT
  // ============================================================

  selectTone(intentData, state) {
    const patient = this.case.patient;
    const toneMap = patient?.toneModifiers || {};

    // Find overriding tone from toneModifiers
    for (const [tone, intentIds] of Object.entries(toneMap)) {
      if (intentIds.includes(intentData.id || "")) return tone;
    }

    // State-based tone escalation
    if (state.uraemiaLevel >= 3 || state.consciousness === "drowsy") {
      return "distressed";
    }
    if (state.hyperkalaemiaFlag === "critical") {
      return "panic";
    }

    // Default from intentData or patient base
    return intentData.tone || patient?.tone || "cooperative";
  }

  // ============================================================
  // SYSTEM INTENTS (score, summary, diagnosis)
  // ============================================================

  isSystemIntent(intentId) {
    return ["sys_diagnosis", "sys_summary", "sys_score"].includes(intentId);
  }

  isManagementIntent(intentId) {
    return (
      intentId.startsWith("mgmt_") ||
      (this.intentBank[intentId]?.category === "management")
    );
  }

  handleSystemIntent(intentId, input, state) {
    if (intentId === "sys_score") {
      return {
        response: {
          type: "score",
          scoreBreakdown: state.scoreBreakdown,
          askedCount: state.askedIntents.length,
          mustAskedCount: (this.case.scoringMap?.mustAsk || []).filter((id) =>
            state.askedIntents.includes(id)
          ).length,
          mustTotal: (this.case.scoringMap?.mustAsk || []).length,
          grade: this.computeGrade(state.scoreBreakdown.total),
        },
        newState: state,
      };
    }

    if (intentId === "sys_summary") {
      return {
        response: {
          type: "summary",
          text: this.buildSummary(state),
          score: state.scoreBreakdown,
        },
        newState: state,
      };
    }

    if (intentId === "sys_diagnosis") {
      return this.evaluateDiagnosis(input, state);
    }

    return { response: { type: "unknown" }, newState: state };
  }

  evaluateDiagnosis(input, state) {
    const diagnosis = this.case.diagnosis;
    const keywords = diagnosis.keywords || [];
    const normalizedInput = normalizeText(input);
    const correct = keywords.some((kw) => normalizedInput.includes(kw.toLowerCase()));

    const mustAsked = this.case.scoringMap?.mustAsk || [];
    const coverage = mustAsked.filter((id) => state.askedIntents.includes(id)).length;
    const coveragePercent = Math.round((coverage / mustAsked.length) * 100);

    const diagnosisBonus = correct ? 20 : 0;
    const newBreakdown = {
      ...state.scoreBreakdown,
      managementScore: (state.scoreBreakdown.managementScore || 0) + diagnosisBonus,
      total: (state.scoreBreakdown.total || 0) + diagnosisBonus,
    };

    const newState = { ...state, scoreBreakdown: newBreakdown };

    return {
      response: {
        type: "diagnosis",
        correct,
        primaryDiagnosis: diagnosis.primary,
        feedback: correct
          ? `✅ Correct! ${diagnosis.primary} — well reasoned. Your history coverage was ${coveragePercent}%.`
          : `❌ Not quite. You suggested something different. The diagnosis is ${diagnosis.primary}. Review the key clinical features.`,
        teachingPoints: this.case.teachingPoints || [],
        finalScore: newBreakdown.total,
        grade: this.computeGrade(newBreakdown.total),
      },
      newState,
    };
  }

  handleManagement(intentId, input, state) {
    const checklist = [
      ...(this.case.managementChecklist?.immediate || []),
      ...(this.case.managementChecklist?.shortTerm || []),
      ...(this.case.managementChecklist?.longTerm || []),
    ];

    const matchedActions = checklist.filter((action) =>
      normalizeText(action.action).split(" ").some((word) => input.includes(word))
    );

    const alreadyAsked = state.askedIntents.includes(intentId);
    let pointsEarned = 0;
    if (!alreadyAsked && matchedActions.length > 0) {
      pointsEarned = matchedActions.reduce((sum, a) => sum + a.points, 0);
    }

    const newBreakdown = {
      ...state.scoreBreakdown,
      managementScore: (state.scoreBreakdown.managementScore || 0) + pointsEarned,
      total: (state.scoreBreakdown.total || 0) + pointsEarned,
    };
    const newState = {
      ...state,
      askedIntents: alreadyAsked ? state.askedIntents : [...state.askedIntents, intentId],
      scoreBreakdown: newBreakdown,
    };

    return {
      response: {
        type: "management",
        matched: matchedActions.map((a) => a.action),
        pointsEarned,
        feedback:
          matchedActions.length > 0
            ? `✅ Management action noted: ${matchedActions.map((a) => a.action).join(", ")}`
            : "Consider your management options more carefully for this scenario.",
        score: newBreakdown,
      },
      newState,
    };
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  buildNoMatchResponse(input, state) {
    const askedCount = state.askedIntents.length;
    if (askedCount < 3) {
      return "I'm sorry, I didn't quite understand that. Could you rephrase your question? You can ask me about my symptoms, medical history, or ask to examine me.";
    }
    return "I'm not sure I understand. Could you ask differently? You might try asking about my history, performing an examination, or ordering an investigation.";
  }

  buildSummary(state) {
    const asked = state.askedIntents;
    const mustAsk = this.case.scoringMap?.mustAsk || [];
    const missed = mustAsk.filter((id) => !asked.includes(id));
    const missedLabels = missed
      .map((id) => this.case.intentMap[id]?.label || id)
      .join(", ");

    return (
      `📋 CASE SUMMARY — ${this.case.patient.name}, ${this.case.patient.age}F\n` +
      `Presenting: ${this.case.presentingComplaint}\n` +
      `Intents explored: ${asked.length}\n` +
      `Essential items missed: ${missedLabels || "None — excellent!"}\n` +
      `Complications triggered: ${state.flaggedComplications.length}\n` +
      `Traps triggered: ${state.trapTriggered.join(", ") || "None"}\n` +
      `Current score: ${state.scoreBreakdown.total}\n` +
      `Grade: ${this.computeGrade(state.scoreBreakdown.total)}`
    );
  }

  fetchClinicalPearl(intentId, intentData) {
    // Only surface pearls for investigation results or critical history items
    const knowledgePearlCategories = ["investigation", "exam"];
    if (!knowledgePearlCategories.includes(intentData.category)) return null;
    return intentData.clinicalNote || null;
  }

  computeGrade(totalScore) {
    const grades = this.case.scoringMap?.grades || {
      distinction: 160,
      pass: 120,
      borderline: 100,
    };
    if (totalScore >= grades.distinction) return "Distinction";
    if (totalScore >= grades.pass) return "Pass";
    if (totalScore >= grades.borderline) return "Borderline";
    return "Fail";
  }
}

// ============================================================
// TEXT NORMALIZATION UTILITIES
// ============================================================

/**
 * Normalizes user input for consistent matching:
 * - Lowercases
 * - Strips extra whitespace
 * - Removes punctuation
 * - Expands common abbreviations
 */
function normalizeText(text) {
  const abbreviations = {
    "bp": "blood pressure",
    "htn": "hypertension",
    "dm": "diabetes",
    "ckd": "chronic kidney disease",
    "aki": "acute kidney injury",
    "hx": "history",
    "pmh": "past medical history",
    "fbc": "full blood count",
    "lft": "liver function tests",
    "uss": "ultrasound",
    "ecg": "electrocardiogram",
    "cxr": "chest x-ray",
    "rbs": "blood glucose",
    "rx": "treatment",
    "dx": "diagnosis",
    "meds": "medications",
    "sx": "symptoms",
    "hpc": "history presenting complaint",
    "ix": "investigations",
    "mx": "management",
    "o/e": "on examination",
    "s/e": "side effects",
    "acr": "albumin creatinine ratio",
    "egfr": "glomerular filtration rate",
  };

  let normalized = text.toLowerCase().trim();

  // Remove punctuation (keep alphanumeric, spaces, basic medical symbols)
  normalized = normalized.replace(/[^\w\s/]/g, " ");

  // Expand abbreviations
  for (const [abbr, expansion] of Object.entries(abbreviations)) {
    const regex = new RegExp(`\\b${abbr}\\b`, "gi");
    normalized = normalized.replace(regex, expansion);
  }

  // Collapse whitespace
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

// ============================================================
// WRANGLER.TOML REFERENCE (not code — comment only)
// ============================================================
/*
name = "clerkAI-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "CLERK_KV"
id = "<YOUR_KV_NAMESPACE_ID>"

[vars]
ADMIN_SECRET = "<your-secret-here>"

[limits]
cpu_ms = 50
*/

// ============================================================
// ADMIN INGEST SCRIPT (Node.js CLI — run locally)
// Usage: node ingest.js knowledge-bank-example.json
// ============================================================
/*
const fs = require("fs");
const fetch = require("node-fetch");

const WORKER_URL = "https://your-worker.workers.dev";
const ADMIN_SECRET = process.env.ADMIN_SECRET;

async function ingest(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const res = await fetch(`${WORKER_URL}/admin/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_SECRET}`,
    },
    body: JSON.stringify(data),
  });
  const result = await res.json();
  console.log("Ingest result:", JSON.stringify(result, null, 2));
}

ingest(process.argv[2]);
*/
