#!/usr/bin/env node
/**
 * chat-daemon.js — ClickUp Chat mention daemon
 *
 * Polls all active ClickUp Chat channels every 15 seconds (configurable) and
 * fires a callback whenever your agent is mentioned. Ships a default Telegram
 * alert handler — swap it out or extend for other notification backends.
 *
 * Configuration via environment variables:
 *
 *   CLICKUP_API_KEY          ClickUp API token (or see CLICKUP_API_KEY_FILE)
 *   CLICKUP_API_KEY_FILE     Path to file containing API token
 *                            (default: ~/.agents/secrets/clickup-api-key.txt)
 *   CLICKUP_WORKSPACE_ID     Workspace (team) ID  [required]
 *   CLICKUP_AGENT_USER_ID    Your agent's ClickUp user ID (messages from this
 *                            ID are skipped)
 *   CLICKUP_AGENT_NAME       Display name to detect in mentions (default: "rose")
 *   CLICKUP_POLL_MS          Poll interval in milliseconds (default: 15000)
 *   CLICKUP_STATE_FILE       Path to state file
 *                            (default: ~/.agents/logs/chat-daemon-state.json)
 *
 *   Telegram notification (optional — omit both to disable):
 *   TELEGRAM_BOT_TOKEN       Telegram bot token
 *   TELEGRAM_CHAT_ID         Telegram chat/group ID to send alerts to
 *
 *   Auto-reply in ClickUp Chat (optional):
 *   CLICKUP_AUTO_REPLY       Set to "1" to send an auto-reply when mentioned
 *   CLICKUP_AUTO_REPLY_TEXT  Auto-reply message text (default: "Got it — I see
 *                            your message. On it.")
 *   CLICKUP_CLI_PATH         Path to the clickup CLI binary used for auto-reply
 *                            (default: clickup)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');


// ── Auth & Config ──────────────────────────────────────────────────────────────

function resolveApiKey() {
  const env = process.env.CLICKUP_API_KEY || process.env.CLICKUP_TOKEN;
  if (env) return env;
  try {
    const keyFile = process.env.CLICKUP_API_KEY_FILE ||
      path.join(os.homedir(), '.agents', 'secrets', 'clickup-api-key.txt');
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    if (key) return key;
  } catch { /* fall through */ }
  console.error('[chat-daemon] No API key found. Set CLICKUP_API_KEY or CLICKUP_API_KEY_FILE.');
  process.exit(1);
}

const API_KEY = resolveApiKey();

const WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID || (() => {
  console.error('[chat-daemon] CLICKUP_WORKSPACE_ID is required');
  process.exit(1);
})();

const AGENT_USER_ID = (process.env.CLICKUP_AGENT_USER_ID || '').trim();
const AGENT_NAME    = (process.env.CLICKUP_AGENT_NAME || 'rose').toLowerCase();
const POLL_MS       = parseInt(process.env.CLICKUP_POLL_MS || '15000', 10);
const STATE_FILE    = process.env.CLICKUP_STATE_FILE ||
  path.join(os.homedir(), '.agents', 'logs', 'chat-daemon-state.json');

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';

const AUTO_REPLY      = process.env.CLICKUP_AUTO_REPLY === '1';
const AUTO_REPLY_TEXT = process.env.CLICKUP_AUTO_REPLY_TEXT || 'Got it — I see your message. On it.';
const CLI_PATH        = process.env.CLICKUP_CLI_PATH || 'clickup';

const BASE_V2 = 'https://api.clickup.com/api/v2';
const BASE_V3 = `https://api.clickup.com/api/v3/workspaces/${WORKSPACE_ID}`;

const HEADERS = { 'Authorization': API_KEY, 'Content-Type': 'application/json' };


// ── State ──────────────────────────────────────────────────────────────────────

let state = {};
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch { /* start fresh */ }

function saveState() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}


// ── HTTP ───────────────────────────────────────────────────────────────────────

async function apiGet(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}


// ── Mention detection ──────────────────────────────────────────────────────────

function mentionsAgent(content, userId) {
  if (AGENT_USER_ID && userId === AGENT_USER_ID) return false; // skip own messages
  if (!content) return false;
  const lower = content.toLowerCase();
  const escaped = AGENT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    lower.includes(`#user_mention#${AGENT_USER_ID}`) ||
    new RegExp(`\\b${escaped}\\b`, 'i').test(content)
  );
}

function cleanContent(content) {
  if (!content) return '';
  return content
    .replace(/\[@([^\]]+)\]\(#user_mention#\d+\)/g, '@$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .substring(0, 400);
}


// ── Member name cache ──────────────────────────────────────────────────────────

const memberNames = {};

async function getMemberName(userId) {
  if (memberNames[userId]) return memberNames[userId];
  try {
    const data = await apiGet(`${BASE_V2}/team/${WORKSPACE_ID}`);
    for (const m of data.team?.members || []) {
      memberNames[m.user.id] = m.user.username || m.user.email || String(m.user.id);
    }
  } catch { /* ignore */ }
  return memberNames[userId] || `user_${userId}`;
}


// ── Notifications ──────────────────────────────────────────────────────────────

async function sendTelegram(channelName, senderName, content) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const msg = `📋 ClickUp Chat — @${AGENT_NAME} mentioned by ${senderName} in #${channelName}:\n\n${cleanContent(content)}`;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg }),
    });
    console.log(`[alert] Telegram sent for mention in #${channelName}`);
  } catch (e) {
    console.error(`[alert] Telegram failed: ${e.message}`);
  }
}

async function autoReply(channelId, msgId, senderName) {
  if (!AUTO_REPLY || !channelId || !msgId) return;
  try {
    const { execSync } = require('child_process');
    execSync(
      `CLICKUP_API_KEY="${API_KEY}" CLICKUP_WORKSPACE_ID="${WORKSPACE_ID}" ${CLI_PATH} chat reply "${channelId}" "${msgId}" "${AUTO_REPLY_TEXT}"`,
      { timeout: 15000 }
    );
    console.log(`[reply] Responded in ClickUp to ${senderName}`);
  } catch (e) {
    console.error(`[reply] Auto-reply failed: ${e.message}`);
  }
}


// ── Poll loop ──────────────────────────────────────────────────────────────────

async function poll() {
  try {
    const channelsResp = await apiGet(`${BASE_V3}/chat/channels`);
    const channels = channelsResp.data || [];

    for (const ch of channels) {
      if (ch.archived) continue;
      const chId   = ch.id;
      const chName = ch.name || '(DM)';

      try {
        const msgsResp = await apiGet(`${BASE_V3}/chat/channels/${chId}/messages?limit=10`);
        const messages = msgsResp.data || [];

        const lastSeen = state[chId] || '0';
        let newest = lastSeen;

        for (const msg of messages) {
          const msgDate = String(msg.date || '0');
          if (msgDate <= lastSeen) continue;
          if (msgDate > newest) newest = msgDate;

          const content = msg.content || '';
          const userId  = String(msg.user_id || '');

          if (mentionsAgent(content, userId)) {
            const sender = await getMemberName(userId);
            console.log(`[mention] #${chName} from ${sender}: ${content.substring(0, 80)}`);
            await sendTelegram(chName, sender, content);
            await autoReply(chId, String(msg.id || ''), sender);
          }
        }

        if (newest > lastSeen) state[chId] = newest;
      } catch { /* DMs and some channels may be inaccessible — skip silently */ }
    }

    saveState();
  } catch (e) {
    console.error(`[error] ${e.message}`);
  }
}


// ── Entry point ────────────────────────────────────────────────────────────────

console.log(`[start] ClickUp Chat Daemon`);
console.log(`[start] Workspace: ${WORKSPACE_ID} | Agent: ${AGENT_NAME} | Poll: ${POLL_MS / 1000}s`);
if (TG_TOKEN) console.log(`[start] Telegram alerts enabled (chat ${TG_CHAT_ID})`);
if (AUTO_REPLY) console.log(`[start] Auto-reply enabled`);

poll();
setInterval(poll, POLL_MS);
