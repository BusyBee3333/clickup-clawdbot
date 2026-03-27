#!/usr/bin/env node
/**
 * ClickUp Event Handler — Local HTTP server that receives forwarded
 * webhook events from the CF Worker and triggers Clawdbot cron wakes.
 *
 * This runs as a launchd service on the Mac Mini.
 * Listens on port 3472.
 *
 * Flow:
 *   CF Worker → POST hooks.mcpengage.com/clawdbot/clickup → this server
 *   → cron wake → Clawdbot session processes the event
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3482;
const LOG_DIR = path.join(__dirname, '..', 'logs');
const EVENT_LOG = path.join(LOG_DIR, 'events.jsonl');

// Ensure log directory
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Dedup: same task+event within window → skip ───────────────────────
const DEDUP_WINDOW_MS = 15000; // 15 seconds
const recentEvents = new Map(); // key → timestamp

function dedupKey(event) {
  // For webhook mention events (from WS daemon), use payload hash
  if (event.event === 'mention') {
    // WS events don't have task_id — extract from payload
    const p = event.payload || '';
    const objectIdMatch = p.match(/"object_id":"([^"]+)"/);
    return `mention:${objectIdMatch ? objectIdMatch[1] : p.substring(0, 100)}`;
  }
  return `${event.event}:${event.task_id}:${event.comment_text?.substring(0, 50) || ''}`;
}

function isDuplicate(event) {
  const key = dedupKey(event);
  const now = Date.now();
  const prev = recentEvents.get(key);
  if (prev && (now - prev) < DEDUP_WINDOW_MS) {
    return true;
  }
  recentEvents.set(key, now);
  // Clean old entries every 100 events
  if (recentEvents.size > 200) {
    for (const [k, ts] of recentEvents) {
      if (now - ts > DEDUP_WINDOW_MS * 2) recentEvents.delete(k);
    }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'clickup-event-handler', uptime: process.uptime() }));
    return;
  }

  // Main event receiver
  if (req.method === 'POST' && (req.url === '/clawdbot/clickup' || req.url === '/clickup/event')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const event = JSON.parse(body);
        
        // Log the event
        const logEntry = { ...event, received_at: new Date().toISOString() };
        fs.appendFileSync(EVENT_LOG, JSON.stringify(logEntry) + '\n');
        
        console.log(`[${new Date().toISOString()}] Event: ${event.event} task=${event.task_id} oogie=${event.mentioned_oogie}`);

        // Dedup: skip if we've seen this exact event recently
        if (isDuplicate(event)) {
          console.log(`[dedup] Skipping duplicate: ${event.event} task=${event.task_id}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, woke: false, reason: 'dedup' }));
          return;
        }

        // Decide whether to wake Clawdbot
        const shouldWake = shouldTriggerWake(event);
        
        if (shouldWake) {
          const wakeText = buildWakeText(event);
          console.log(`[wake] Triggering: ${wakeText.substring(0, 100)}...`);
          await triggerCronWake(wakeText);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, woke: shouldWake }));
      } catch (err) {
        console.error(`[error] ${err.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

/**
 * Determine if an event should wake Clawdbot.
 * We don't want to wake on every single event — only meaningful ones.
 */
function shouldTriggerWake(event) {
  // ── Self-echo prevention ─────────────────────────────────────────
  // When Oogie posts a comment via the ClickUp API, ClickUp fires a
  // webhook for that comment. We must NOT wake on our own comments or
  // we get an infinite loop.
  //
  // Detection methods (any one is sufficient):
  // 1. originating_service === "publicapi" (API-posted comments)
  // 2. audit_context.route === "*" (API route wildcard)
  // 3. Comment text contains known Oogie signatures
  const rawPayload = event.raw || {};
  const historyItems = rawPayload.history_items || [];
  
  for (const item of historyItems) {
    // Check originating_service from the context
    const ctx = item?.comment?._version_vector ? null : null; // not here
    const auditCtx = rawPayload?.history_items?.[0]?.data || {};
    
    // For CF webhook events: check the raw audit context
    // The route field is "*" for API-posted comments
    if (event.raw?.history_items) {
      for (const hi of event.raw.history_items) {
        if (hi.source === null && hi.user?.id === 126241816) {
          // This is our own API user posting — but we need to distinguish
          // human-posted (via ClickUp UI) vs API-posted comments.
          // Unfortunately they both come from the same user ID.
        }
      }
    }
  }

  // Method 1: Check for WebSocket "mention" events with publicapi origin
  if (event.event === 'mention' && event.payload) {
    try {
      const wsData = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      const originService = wsData?.event?.version_event_data?.context?.originating_service;
      const route = wsData?.event?.version_event_data?.context?.audit_context?.route;
      if (originService === 'publicapi' || route === '*') {
        console.log(`[filter] Skipping self-echo (WS mention, origin=${originService}, route=${route})`);
        return false;
      }
    } catch {}
  }

  // Method 2: Check CF webhook events for publicapi origin
  if (event.raw?.history_items) {
    for (const hi of event.raw.history_items) {
      // The source field is null for both UI and API posts, but we can
      // check the comment text for Oogie patterns
      if (hi.comment?.text_content) {
        const txt = hi.comment.text_content;
        // Known Oogie signatures and patterns
        if (txt.includes('— Oogie') || txt.includes('ʕ•ᴥ•ʔ') || 
            txt.includes('ᕕ( ᐛ )ᕗ') || txt.includes('— sonnet') ||
            txt.includes('— opus')) {
          console.log('[filter] Skipping self-echo (Oogie signature in comment text)');
          return false;
        }
      }
    }
  }
  
  // Method 3: Simple text check on normalized comment_text
  if (event.comment_text) {
    const ct = event.comment_text;
    if (ct.includes('— Oogie') || ct.includes('ʕ•ᴥ•ʔ') || 
        ct.includes('ᕕ( ᐛ )ᕗ') || ct.includes('— sonnet') || 
        ct.includes('— opus') || ct.includes('Test successful - Oogie')) {
      console.log('[filter] Skipping self-echo (Oogie pattern in comment_text)');
      return false;
    }
  }

  // Always wake if someone mentioned @Oogie
  if (event.mentioned_oogie || event.event === "mention") return true;
  
  // Only wake on comments if Oogie was mentioned (handled above)
  // Do NOT wake on every comment — causes self-echo loops
  if (event.event === 'taskCommentPosted') return false;
  if (event.event === 'taskUpdated' && event.comment_text) return false;
  
  // Wake on new task creation (for awareness)
  if (event.event === 'taskCreated') return true;
  
  // Wake on task assignment changes (someone assigned to Oogie or new assignments)
  if (event.event === 'taskAssigneeUpdated') return true;
  
  // Wake on status changes to blocked (might need help)
  if (event.event === 'taskStatusUpdated') {
    const raw = event.raw || {};
    const historyItems = raw.history_items || [];
    for (const item of historyItems) {
      if (item.after && typeof item.after === 'string' && item.after.toLowerCase().includes('block')) {
        return true;
      }
    }
  }
  
  // Don't wake on routine updates (due date tweaks, priority changes, etc.)
  return false;
}

/**
 * Build the wake text that Clawdbot will process as a system event.
 */
function buildWakeText(event) {
  // WebSocket mention events get fast-tracked with raw payload context
  if (event.event === "mention") {
    const rawSnippet = event.payload ? event.payload.substring(0, 500) : '';
    return 'ClickUp Realtime WebSocket Alert: You were just tagged in ClickUp! '
      + 'The raw WebSocket payload is: ' + rawSnippet
      + '. Please use your ClickUp skill to read the latest comments and reply natively.';
  }

  const userName = event.user?.username || 'Someone';
  const taskId = event.task_id || 'unknown';
  
  if (event.mentioned_oogie && event.comment_text) {
    return `ClickUp @Oogie mention: ${userName} mentioned you in a comment on task ${taskId}. Comment: "${event.comment_text}". To read the task and comments, write a shell script to /tmp/cu_read.sh that uses curl with the API key from the CLICKUP_BURTONMETHOD_KEY env var, then run it with: signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash /tmp/cu_read.sh. To post a reply, write a script to /tmp/cu_reply.sh that posts via curl, then run it the same way. The ClickUp API base is https://api.clickup.com/api/v2. Respond helpfully — answer their question, offer help, or acknowledge. Keep your reply concise. Sign with — Oogie.`;
  }
  
  if (event.event === 'taskCommentPosted') {
    return `ClickUp comment on task ${taskId}: ${userName} said "${event.comment_text || '(no text)'}". If a response would be helpful, write a shell script to post a reply via ClickUp API and run with signet secret exec. Otherwise NO_REPLY.`;
  }
  
  if (event.event === 'taskCreated') {
    return `ClickUp new task created by ${userName} (ID: ${taskId}). Review if needed, otherwise NO_REPLY.`;
  }
  
  if (event.event === 'taskAssigneeUpdated') {
    return `ClickUp assignment change by ${userName} on task ${taskId}. Review if needed, otherwise NO_REPLY.`;
  }

  if (event.event === 'taskStatusUpdated') {
    return `ClickUp status change by ${userName} on task ${taskId} to a blocked state. Check if you can help. Otherwise NO_REPLY.`;
  }
  
  return `ClickUp event: ${event.event} on task ${taskId} by ${userName}. Review if action needed. NO_REPLY if routine.`;
}

/**
 * Trigger a Clawdbot agent run via the Gateway /hooks/agent endpoint.
 * This spawns an isolated agent turn that can read the ClickUp task,
 * process the mention, and post a comment back — all in one shot.
 */
async function triggerCronWake(text) {
  const http = require('http');
  const extraInstructions = process.env.CLICKUP_WAKE_INSTRUCTIONS || '';
  const fullText = text + (extraInstructions ? ' ' + extraInstructions : '');
  const gatewayPort = process.env.CLAWDBOT_GATEWAY_PORT || 18789;
  const hookToken = process.env.CLAWDBOT_HOOK_TOKEN || 'qnLSLAojTmhgdA4vktyaDsoDyvL9yUT_fPVR32vSdxk';

  const body = JSON.stringify({
    message: fullText,
    name: 'ClickUp',
    wakeMode: 'now',
    deliver: false,
    timeoutSeconds: 60,
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[clickup-event-handler] Listening on 127.0.0.1:${PORT}`);
  console.log(`[clickup-event-handler] Event log: ${EVENT_LOG}`);
});

// Graceful shutdown (PM2 sends SIGTERM on restart/cron_restart)
process.on('SIGTERM', () => { console.log('[shutdown] SIGTERM'); server.close(); process.exit(0); });
process.on('SIGINT', () => { console.log('[shutdown] SIGINT'); server.close(); process.exit(0); });
