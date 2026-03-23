/**
 * ClickUp Webhook Receiver — Cloudflare Worker
 *
 * Routes:
 *   POST /clickup/webhook  — main webhook receiver (HMAC-validated)
 *   GET  /clickup/health   — health check
 *   POST /clickup/test     — echo endpoint for development
 *
 * ClickUp signs payloads with HMAC-SHA256 (X-Signature header).
 * Validated events are normalized and forwarded to the Clawdbot gateway.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── Route dispatch ────────────────────────────────────────────────
    if (method === "GET" && path === "/clickup/health") {
      return jsonResponse({ status: "ok", worker: "clickup-webhook", ts: now() });
    }

    if (method === "POST" && path === "/clickup/test") {
      return handleTest(request);
    }

    if (method === "POST" && path === "/clickup/webhook") {
      return handleWebhook(request, env, ctx);
    }

    return jsonResponse({ error: "not found" }, 404);
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /clickup/test — echo the payload back (dev only).
 */
async function handleTest(request) {
  const body = await request.json().catch(() => null);
  return jsonResponse({ echo: true, received: body, ts: now() });
}

/**
 * POST /clickup/webhook — main webhook receiver.
 *
 * 1. Read raw body & validate HMAC-SHA256 signature
 * 2. Parse payload, normalize event
 * 3. Fire-and-forget forward to Clawdbot gateway (via waitUntil)
 * 4. Return 200 immediately so ClickUp doesn't retry
 */
async function handleWebhook(request, env, ctx) {
  // -- Read raw body once (needed for both signature check and parsing) --
  const rawBody = await request.text();

  // -- Signature validation --
  const signature = request.headers.get("X-Signature");
  if (!signature) {
    return jsonResponse({ error: "missing signature" }, 401);
  }

  const secret = env.WEBHOOK_SECRET;
  if (!secret) {
    console.error("WEBHOOK_SECRET not configured");
    return jsonResponse({ error: "server misconfigured" }, 500);
  }

  const valid = await verifyHmac(secret, rawBody, signature);
  if (!valid) {
    console.warn("Invalid webhook signature", { signature });
    return jsonResponse({ error: "invalid signature" }, 401);
  }

  // -- Parse payload --
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "invalid JSON" }, 400);
  }

  // -- Normalize --
  const normalized = normalizeEvent(payload);

  console.log(`[clickup-webhook] ${normalized.event} task=${normalized.task_id} mentioned_oogie=${normalized.mentioned_oogie}`);

  // -- Forward to Clawdbot gateway (non-blocking) --
  const gatewayUrl = env.CLAWDBOT_GATEWAY_URL || "https://hooks.mcpengage.com/clawdbot/clickup";
  ctx.waitUntil(forwardEvent(gatewayUrl, normalized));

  // -- Respond immediately --
  return jsonResponse({ ok: true, event: normalized.event, task_id: normalized.task_id });
}

// ═══════════════════════════════════════════════════════════════════════
// HMAC-SHA256 Signature Verification
// ═══════════════════════════════════════════════════════════════════════

/**
 * Verify ClickUp's HMAC-SHA256 signature.
 * ClickUp computes: HMAC-SHA256(secret, rawBody) and sends the hex digest
 * in the X-Signature header.
 */
async function verifyHmac(secret, rawBody, expectedSignature) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computed = bufToHex(sig);
  return timingSafeEqual(computed, expectedSignature);
}

/** ArrayBuffer → lowercase hex string */
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (prevents timing attacks) */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ═══════════════════════════════════════════════════════════════════════
// Event Normalization
// ═══════════════════════════════════════════════════════════════════════

/**
 * Transform raw ClickUp webhook payload into a normalized event
 * that Clawdbot's gateway understands.
 */
function normalizeEvent(payload) {
  const event = payload.event || "unknown";
  const taskId = payload.task_id || null;
  const webhookId = payload.webhook_id || null;
  const historyItems = payload.history_items || [];

  // Extract comment text and user info from history items
  let commentText = null;
  let mentionedOogie = false;
  let user = null;

  for (const item of historyItems) {
    // Comment events carry the comment in `comment`
    if (item.comment) {
      commentText = extractCommentText(item.comment);
      mentionedOogie = checkOogieMention(commentText);
    }

    // User who triggered the event
    if (item.user && !user) {
      user = {
        id: item.user.id,
        username: item.user.username || item.user.email || "unknown",
      };
    }
  }

  return {
    source: "clickup",
    event,
    workspace_id: "9013713404",
    task_id: taskId,
    webhook_id: webhookId,
    comment_text: commentText,
    mentioned_oogie: mentionedOogie,
    user,
    raw: payload,
    timestamp: now(),
  };
}

/**
 * Extract plain text from a ClickUp comment object.
 * Comments have a nested structure: { comment: [{ text: "..." }, ...] }
 */
function extractCommentText(comment) {
  if (typeof comment === "string") return comment;

  // ClickUp comment_text field (array of text segments)
  if (Array.isArray(comment)) {
    return comment.map((seg) => seg.text || "").join("");
  }

  // Nested comment object with comment_text array
  if (comment.comment_text) {
    return extractCommentText(comment.comment_text);
  }

  // Fallback: try text_content
  if (comment.text_content) return comment.text_content;

  return JSON.stringify(comment);
}

/**
 * Check if the comment text mentions @Oogie (case-insensitive).
 * Handles: @Oogie, @oogie, mentions of "Oogie" in any case.
 */
function checkOogieMention(text) {
  if (!text) return false;
  return /\boogie\b/i.test(text);
}

// ═══════════════════════════════════════════════════════════════════════
// Event Forwarding
// ═══════════════════════════════════════════════════════════════════════

/**
 * Forward the normalized event to the Clawdbot gateway.
 * Runs inside ctx.waitUntil() so it doesn't block the response.
 */
async function forwardEvent(gatewayUrl, event) {
  try {
    const resp = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    console.log(`[forward] ${resp.status} → ${gatewayUrl}`);
  } catch (err) {
    // Log but don't throw — this is fire-and-forget
    console.error(`[forward] failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function now() {
  return new Date().toISOString();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
