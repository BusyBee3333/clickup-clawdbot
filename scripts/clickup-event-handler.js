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
  // Always wake if someone mentioned @Oogie
  if (event.mentioned_oogie || event.event === "mention") return true;
  
  // Wake on new comments (someone might need a response)
  if (event.event === 'taskCommentPosted') return true;
  
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
    return `ClickUp @Oogie mention: ${userName} mentioned you in a comment on task ${taskId}. Comment: "${event.comment_text}". Read the full task context with: signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c 'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup task ${taskId}' and signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c 'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup comments ${taskId}'. Respond helpfully by posting a comment back on the task. Be useful — answer their question, offer help, or acknowledge.`;
  }
  
  if (event.event === 'taskCommentPosted') {
    return `ClickUp comment: ${userName} posted a comment on task ${taskId}: "${event.comment_text || '(no text)'}". Check if a response from Oogie would be helpful. If the comment is a question, status update request, or asks for input, respond via: signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c 'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup comment ${taskId} "your response"'. If it's just an FYI or acknowledgment, NO_REPLY.`;
  }
  
  if (event.event === 'taskCreated') {
    return `ClickUp new task: ${userName} created a new task (ID: ${taskId}). Check the task details and if it's missing an assignee, priority, or description, consider posting a helpful comment. Use: signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c 'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup task ${taskId}'. If it looks complete, NO_REPLY.`;
  }
  
  if (event.event === 'taskAssigneeUpdated') {
    return `ClickUp assignment change: ${userName} changed assignees on task ${taskId}. Check who was assigned: signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c 'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup task ${taskId}'. If someone new was assigned, post a brief encouraging comment. If routine, NO_REPLY.`;
  }

  if (event.event === 'taskStatusUpdated') {
    return `ClickUp status change: ${userName} updated the status of task ${taskId}. A task was moved to a blocked state. Check if you can help unblock it: signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c 'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup task ${taskId}'. If you can offer help, post a comment. Otherwise NO_REPLY.`;
  }
  
  return `ClickUp event: ${event.event} on task ${taskId} by ${userName}. Review if action needed. NO_REPLY if routine.`;
}

/**
 * Trigger a Clawdbot cron wake event via the Gateway tools/invoke API.
 * Uses POST /tools/invoke on the gateway (port 18789, no auth needed on loopback).
 * Falls back to file-based wake if the gateway is unreachable.
 */
async function triggerCronWake(text) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    
    // Configurable openclaw CLI path, target, and instruction suffix
    const openclawBin = process.env.CLICKUP_OPENCLAW_BIN || 'openclaw';
    const target = process.env.CLICKUP_AGENT_TARGET || 'main';
    const extraInstructions = process.env.CLICKUP_WAKE_INSTRUCTIONS || '';
    
    const fullText = text + (extraInstructions ? ' ' + extraInstructions : '');
    
    // Use execFile (no shell) to avoid injection from ClickUp comment content
    const args = ['agent', '--target', target, '--message', fullText];
    const child = execFile(openclawBin, args, { timeout: 15000 }, (error) => {
      if (error) console.log('[wake-error]', error.message);
      resolve();
    });
    child.unref(); // fire-and-forget
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[clickup-event-handler] Listening on 127.0.0.1:${PORT}`);
  console.log(`[clickup-event-handler] Event log: ${EVENT_LOG}`);
});

// Graceful shutdown (PM2 sends SIGTERM on restart/cron_restart)
process.on('SIGTERM', () => { console.log('[shutdown] SIGTERM'); server.close(); process.exit(0); });
process.on('SIGINT', () => { console.log('[shutdown] SIGINT'); server.close(); process.exit(0); });
