#!/usr/bin/env node
/**
 * ClickUp Event Handler v2 — Unified event receiver for Clawdbot
 *
 * Receives events from:
 *   1. CF Worker webhook (POST /clawdbot/clickup)
 *   2. WS daemon mention forwards (POST /clickup/event)
 *   3. Chat daemon mention forwards (POST /clickup/chat-mention) [NEW]
 *
 * All paths converge here → dedup → self-echo filter → wake Clawdbot
 *
 * Clawdbot response path: wake text includes the CLI command to reply
 * directly on ClickUp (task comment or chat message). No shell scripts,
 * no curl, no signet secret exec — just the CLI.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3482;
const LOG_DIR = path.join(__dirname, '..', 'logs');
const EVENT_LOG = path.join(LOG_DIR, 'events.jsonl');

// ── Our ClickUp identity (jake@burtonmethod.com) ─────────────────────
const OUR_USER_ID = '126241816';
const OUR_USER_ID_NUM = 126241816;

// ── CLI path for response instructions ────────────────────────────────
const CLI_PATH = '/Users/jackshard/projects/clickup-clawdbot/cli/clickup.js';
const API_KEY_FILE = '~/.agents/secrets/clickup-api-key.txt';
const WORKSPACE_ID = '9013713404';

// Ensure log directory
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Dedup + Debounce: one comment = one wake ─────────────────────────
const DEDUP_WINDOW_MS = 30000; // 30s window (wider since debounce handles the fast stuff)
const DEBOUNCE_MS = 3000;       // Wait 3s to collect all events about the same task
const recentEvents = new Map(); // key → timestamp (dedup)
const pendingWakes = new Map(); // taskKey → { timer, bestEvent, wakeText }

/**
 * Extract a stable task-level key from any event type.
 * All events about the same task collapse to one key.
 */
function extractTaskKey(event) {
  // Direct task_id from CF webhooks
  if (event.task_id) return `task:${event.task_id}`;

  // Chat mentions key by channel
  if (event.event === 'chat_mention') return `chat:${event.channel_id || ''}:${event.message_id || ''}`;

  // WS mention events: dig into payload for task-level IDs
  if (event.event === 'mention' && event.payload) {
    try {
      const p = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
      const wsData = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;

      // Get the object type — if it's a comment, we need the parent task
      const objectType = wsData?.event?.version_change?.object_type || '';
      const objectId = wsData?.event?.version_change?.object_id || '';
      const eventName = wsData?.event?.name || wsData?.msg || '';

      // For task-level events, use the task ID directly
      if (objectType === 'task' && objectId) return `task:${objectId}`;

      // For comment events, try to find a task reference in the payload
      // Comments don't always carry the parent task ID in WS payloads,
      // but task updates about the same comment DO have the task ID.
      // Use the event name + a time bucket to group them.
      if (objectType === 'comment' || eventName.includes('comment') || eventName.includes('Comment')) {
        // Group all comment events in the same 5s window
        const bucket = Math.floor(Date.now() / 5000);
        return `comment-group:${bucket}`;
      }

      if (objectId) return `obj:${objectId}`;
    } catch {}
  }

  // Fallback: time-bucketed key
  return `unknown:${Math.floor(Date.now() / 5000)}`;
}

/**
 * Check if this exact event was already seen (hard dedup).
 */
function isDuplicate(event) {
  const key = extractTaskKey(event) + ':' + (event.event || '');
  const now = Date.now();
  const prev = recentEvents.get(key);
  if (prev && (now - prev) < DEDUP_WINDOW_MS) {
    return true;
  }
  recentEvents.set(key, now);
  if (recentEvents.size > 300) {
    for (const [k, ts] of recentEvents) {
      if (now - ts > DEDUP_WINDOW_MS * 2) recentEvents.delete(k);
    }
  }
  return false;
}

/**
 * Score an event by how much context it carries.
 * Higher = better candidate for the wake text.
 */
function eventRichness(event) {
  let score = 0;
  if (event.task_id) score += 10;              // Has a direct task ID
  if (event.comment_text) score += 5;          // Has comment text
  if (event.mentioned_oogie) score += 3;       // Explicitly mentions us
  if (event.event === 'chat_mention') score += 8; // Chat mentions are always important
  if (event.event === 'mention') {
    // WS mentions with comment context
    try {
      const wsData = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      const eventName = wsData?.event?.name || '';
      if (eventName.includes('comment') || eventName.includes('Comment')) score += 7;
      if (wsData?.event?.version_change?.object_type === 'task') score += 4;
    } catch {}
  }
  return score;
}

/**
 * Queue a wake with debounce. Multiple events about the same task
 * within DEBOUNCE_MS get merged — only the richest event fires.
 */
function queueDebouncedWake(event, inputPath) {
  const taskKey = extractTaskKey(event);
  const richness = eventRichness(event);
  const existing = pendingWakes.get(taskKey);

  if (existing) {
    // Replace if this event is richer (has more context)
    if (richness > existing.richness) {
      existing.bestEvent = event;
      existing.richness = richness;
      existing.inputPath = inputPath;
      console.log(`[debounce] Upgraded pending wake for ${taskKey} (richness ${existing.richness} → ${richness})`);
    } else {
      console.log(`[debounce] Merged into pending wake for ${taskKey} (keeping richness ${existing.richness})`);
    }
    return;
  }

  // New task key — start debounce timer
  const entry = {
    bestEvent: event,
    richness,
    inputPath,
    timer: setTimeout(async () => {
      pendingWakes.delete(taskKey);
      const e = entry.bestEvent;
      const wakeText = buildWakeText(e);
      console.log(`[debounce] Firing wake for ${taskKey} (richness ${entry.richness}, path ${entry.inputPath}): ${wakeText.substring(0, 100)}...`);
      await triggerCronWake(wakeText);
    }, DEBOUNCE_MS),
  };
  pendingWakes.set(taskKey, entry);
  console.log(`[debounce] Queued wake for ${taskKey} (richness ${richness}, fires in ${DEBOUNCE_MS}ms)`);
}

// ── Self-echo detection (comprehensive) ──────────────────────────────

/**
 * Check if an event was caused by our own API calls.
 * Returns true if we should SKIP this event (it's our own echo).
 */
function isSelfEcho(event) {
  // ── Check 1: WS payload audit context ──────────────────────────────
  // WS events carry originating_service and userid in the nested context.
  // If originating_service === "publicapi" AND userid matches ours,
  // it's our own API comment.
  if (event.event === 'mention' && event.payload) {
    try {
      const wsData = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      const ctx = wsData?.event?.version_event_data?.context;
      const originService = ctx?.originating_service;
      const auditRoute = ctx?.audit_context?.route;
      const triggerUserId = String(ctx?.audit_context?.trigger_user_id || '');
      const userId = String(ctx?.audit_context?.userid || '');

      // API-originated events from our account
      if (originService === 'publicapi' && (userId === OUR_USER_ID || triggerUserId === OUR_USER_ID)) {
        console.log(`[self-echo] WS mention from our API (origin=${originService}, user=${userId})`);
        return true;
      }
      // Wildcard route = API call
      if (auditRoute === '*' && (userId === OUR_USER_ID || triggerUserId === OUR_USER_ID)) {
        console.log(`[self-echo] WS mention from our API (route=*, user=${userId})`);
        return true;
      }
      // Even without publicapi flag: if it's our user ID posting via API route
      if (originService === 'publicapi') {
        console.log(`[self-echo] WS mention from publicapi (any user — playing safe)`);
        return true;
      }
    } catch {}
  }

  // ── Check 2: CF webhook history_items ──────────────────────────────
  if (event.raw?.history_items) {
    for (const hi of event.raw.history_items) {
      // Check comment author — if it's our user ID, it's likely us
      const authorId = String(hi.user?.id || hi.comment?.user?.id || '');
      if (authorId === OUR_USER_ID) {
        // Could be human Jake posting from ClickUp UI OR our API.
        // Check text for Oogie patterns to distinguish.
        const txt = hi.comment?.text_content || hi.comment?.comment_text || '';
        if (hasOogieSignature(txt)) {
          console.log('[self-echo] CF webhook: Oogie signature in comment from our user ID');
          return true;
        }
      }
    }
  }

  // ── Check 3: Normalized comment_text patterns ──────────────────────
  if (event.comment_text && hasOogieSignature(event.comment_text)) {
    console.log('[self-echo] Oogie signature in comment_text');
    return true;
  }

  return false;
}

/**
 * Check if text contains known Oogie/Buba response signatures.
 */
function hasOogieSignature(text) {
  if (!text) return false;
  const signatures = [
    '— Oogie', '— sonnet', '— opus',
    'ʕ•ᴥ•ʔ', 'ᕕ( ᐛ )ᕗ', '(╯°□°)╯',
    'ಠ_ಠ', '¯\\_(ツ)_/¯',
    'Test successful - Oogie',
  ];
  return signatures.some(sig => text.includes(sig));
}

// ── HTTP Server ──────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'clickup-event-handler',
      uptime: process.uptime(),
      our_user_id: OUR_USER_ID,
    }));
    return;
  }

  // Event receivers (all 3 paths)
  if (req.method === 'POST' && (
    req.url === '/clawdbot/clickup' ||
    req.url === '/clickup/event' ||
    req.url === '/clickup/chat-mention'
  )) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const event = JSON.parse(body);

        // Tag the input path for logging
        const inputPath = req.url === '/clickup/event' ? 'ws'
          : req.url === '/clickup/chat-mention' ? 'chat'
          : 'webhook';

        // Log the event
        const logEntry = { ...event, received_at: new Date().toISOString(), input_path: inputPath };
        fs.appendFileSync(EVENT_LOG, JSON.stringify(logEntry) + '\n');

        console.log(`[${new Date().toISOString()}] [${inputPath}] Event: ${event.event} task=${event.task_id || '—'} mention=${event.mentioned_oogie || '—'}`);

        // ── Step 1: Dedup (unified across all paths) ─────────────────
        if (isDuplicate(event)) {
          console.log(`[dedup] Skipping: ${event.event} (${inputPath})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, woke: false, reason: 'dedup' }));
          return;
        }

        // ── Step 2: Self-echo filter ─────────────────────────────────
        if (isSelfEcho(event)) {
          console.log(`[self-echo] Blocked: ${event.event} (${inputPath})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, woke: false, reason: 'self-echo' }));
          return;
        }

        // ── Step 3: Should we wake Clawdbot? ─────────────────────────
        const shouldWake = shouldTriggerWake(event);

        if (shouldWake) {
          // Debounced: queue the event, best one fires after 3s
          queueDebouncedWake(event, inputPath);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, woke: shouldWake, path: inputPath }));
      } catch (err) {
        console.error(`[error] ${err.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// ── Wake decision logic ──────────────────────────────────────────────

function shouldTriggerWake(event) {
  // Chat mentions always wake
  if (event.event === 'chat_mention') return true;

  // WS mention events (already passed self-echo filter)
  if (event.event === 'mention') return true;

  // CF webhook: @Oogie mentioned in comment
  if (event.mentioned_oogie) return true;

  // Task comment without mention — don't wake (prevents echo loops)
  if (event.event === 'taskCommentPosted') return false;
  if (event.event === 'taskUpdated' && event.comment_text) return false;

  // New task creation
  if (event.event === 'taskCreated') return true;

  // Assignment changes
  if (event.event === 'taskAssigneeUpdated') return true;

  // Status → blocked
  if (event.event === 'taskStatusUpdated') {
    const historyItems = event.raw?.history_items || [];
    for (const item of historyItems) {
      if (item.after && typeof item.after === 'string' && item.after.toLowerCase().includes('block')) {
        return true;
      }
    }
  }

  return false;
}

// ── Wake text builder (simplified — uses CLI directly) ───────────────

/**
 * Build wake text that Clawdbot can process in a single agent turn.
 * Uses the ClickUp CLI directly — no shell scripts, no curl, no signet secret exec.
 *
 * The CLI reads the API key from ~/.agents/secrets/clickup-api-key.txt automatically.
 */
function buildWakeText(event) {
  const cliEnv = `CLICKUP_API_KEY=$(cat ${API_KEY_FILE}) CLICKUP_WORKSPACE_ID=${WORKSPACE_ID}`;
  const cli = `node ${CLI_PATH}`;

  // ── Chat mention ───────────────────────────────────────────────────
  if (event.event === 'chat_mention') {
    const channelId = event.channel_id || '';
    const channelName = event.channel_name || 'a chat channel';
    const senderName = event.sender_name || 'Someone';
    const messageText = event.message_text || '';
    const messageId = event.message_id || '';

    return `[ClickUp Chat Mention] ${senderName} mentioned you in ${channelName}: "${messageText}"\n\n`
      + `To read recent messages: ${cliEnv} ${cli} chat messages "${channelId}" --limit 10\n`
      + (messageId
        ? `To reply: ${cliEnv} ${cli} chat reply "${channelId}" "${messageId}" "your response here"\n`
        : `To send: ${cliEnv} ${cli} chat send "${channelId}" "your response here"\n`)
      + `\nRespond helpfully. Keep it concise. You are @Jake Shore (jake@burtonmethod.com) in ClickUp. Sign with — Oogie`;
  }

  // ── WS mention (raw payload) ───────────────────────────────────────
  if (event.event === 'mention') {
    // Extract task/object ID from WS payload
    let objectId = '';
    let eventName = '';
    try {
      const wsData = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      objectId = wsData?.event?.version_change?.object_id || '';
      eventName = wsData?.event?.name || '';
    } catch {}

    if (objectId && (eventName.includes('Comment') || eventName.includes('comment'))) {
      return `[ClickUp Mention] You were tagged in a comment on task ${objectId}.\n\n`
        + `To read the task and comments: ${cliEnv} ${cli} task ${objectId}\n`
        + `To reply: ${cliEnv} ${cli} comment ${objectId} "your response here"\n`
        + `\nRead the comments first, understand what they're asking, then reply helpfully. `
        + `You are @Jake Shore (jake@burtonmethod.com) in ClickUp. Sign with — Oogie`;
    }

    // Generic WS mention (non-comment, e.g. task update)
    if (objectId) {
      return `[ClickUp Mention] Activity on task ${objectId} (${eventName}).\n\n`
        + `To read: ${cliEnv} ${cli} task ${objectId}\n`
        + `To comment: ${cliEnv} ${cli} comment ${objectId} "your response here"\n`
        + `\nReview and respond if needed. You are @Jake Shore in ClickUp. Sign with — Oogie`;
    }

    // Fallback: raw payload snippet
    const snippet = (event.payload || '').substring(0, 300);
    return `[ClickUp Mention] Raw WebSocket alert (could not parse task ID): ${snippet}\n`
      + `\nUse the ClickUp CLI to investigate. Sign replies with — Oogie`;
  }

  // ── CF webhook: @Oogie mentioned in task comment ───────────────────
  const userName = event.user?.username || 'Someone';
  const taskId = event.task_id || 'unknown';

  if (event.mentioned_oogie && event.comment_text) {
    return `[ClickUp @Oogie Mention] ${userName} mentioned you on task ${taskId}.\n`
      + `Comment: "${event.comment_text}"\n\n`
      + `To read full context: ${cliEnv} ${cli} task ${taskId}\n`
      + `To reply: ${cliEnv} ${cli} comment ${taskId} "your response here"\n`
      + `\nRead the task first, then reply helpfully to their question. `
      + `You are @Jake Shore (jake@burtonmethod.com) in ClickUp. Sign with — Oogie`;
  }

  // ── Task created ───────────────────────────────────────────────────
  if (event.event === 'taskCreated') {
    return `[ClickUp] New task created by ${userName} (ID: ${taskId}).\n`
      + `To read: ${cliEnv} ${cli} task ${taskId}\n`
      + `Review if needed, otherwise NO_REPLY.`;
  }

  // ── Assignment change ──────────────────────────────────────────────
  if (event.event === 'taskAssigneeUpdated') {
    return `[ClickUp] Assignment change by ${userName} on task ${taskId}.\n`
      + `To read: ${cliEnv} ${cli} task ${taskId}\n`
      + `Review if needed, otherwise NO_REPLY.`;
  }

  // ── Status → blocked ───────────────────────────────────────────────
  if (event.event === 'taskStatusUpdated') {
    return `[ClickUp] Task ${taskId} moved to blocked by ${userName}.\n`
      + `To read: ${cliEnv} ${cli} task ${taskId}\n`
      + `Check if you can help. Otherwise NO_REPLY.`;
  }

  // ── Generic fallback ───────────────────────────────────────────────
  return `[ClickUp] Event: ${event.event} on task ${taskId} by ${userName}.\n`
    + `To read: ${cliEnv} ${cli} task ${taskId}\n`
    + `Review if action needed. NO_REPLY if routine.`;
}

// ── Trigger Clawdbot wake ────────────────────────────────────────────

async function triggerCronWake(text) {
  const extraInstructions = process.env.CLICKUP_WAKE_INSTRUCTIONS || '';
  const fullText = text + (extraInstructions ? '\n' + extraInstructions : '');
  const gatewayPort = process.env.CLAWDBOT_GATEWAY_PORT || 18789;
  const hookToken = process.env.CLAWDBOT_HOOK_TOKEN || 'qnLSLAojTmhgdA4vktyaDsoDyvL9yUT_fPVR32vSdxk';

  const body = JSON.stringify({
    message: fullText,
    name: 'ClickUp',
    wakeMode: 'now',
    deliver: false,
    timeoutSeconds: 90,
  });

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: gatewayPort,
        path: '/hooks/agent',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${hookToken}`,
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('[wake] Agent run triggered via /hooks/agent');
          } else {
            console.log(`[wake-error] Gateway responded ${res.statusCode}: ${data}`);
          }
          resolve();
        });
      },
    );
    req.on('error', (err) => {
      console.log(`[wake-error] Gateway unreachable: ${err.message}`);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

// ── Start server ─────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[clickup-event-handler] v2 — Listening on 127.0.0.1:${PORT}`);
  console.log(`[clickup-event-handler] Our user: ${OUR_USER_ID} (jake@burtonmethod.com)`);
  console.log(`[clickup-event-handler] CLI: ${CLI_PATH}`);
  console.log(`[clickup-event-handler] Event log: ${EVENT_LOG}`);
});

process.on('SIGTERM', () => { console.log('[shutdown] SIGTERM'); server.close(); process.exit(0); });
process.on('SIGINT', () => { console.log('[shutdown] SIGINT'); server.close(); process.exit(0); });
