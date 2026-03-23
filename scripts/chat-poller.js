#!/usr/bin/env node
/**
 * ClickUp Chat Channel Poller
 * 
 * Polls ClickUp Chat channels for new messages mentioning @Oogie.
 * ClickUp's webhook system doesn't cover Chat events, so we poll.
 * 
 * Usage: CLICKUP_API_KEY=xxx node chat-poller.js
 * 
 * Outputs any new @Oogie mentions found since last poll.
 * Saves state to avoid duplicate processing.
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE_ID = '9013713404';
const BASE_V3 = `https://api.clickup.com/api/v3/workspaces/${WORKSPACE_ID}`;
const STATE_FILE = path.join(__dirname, '..', 'logs', 'chat-poller-state.json');
const API_KEY = process.env.CLICKUP_API_KEY;

if (!API_KEY) {
  console.error('CLICKUP_API_KEY required');
  process.exit(1);
}

const headers = {
  'Authorization': API_KEY,
  'Content-Type': 'application/json'
};

async function api(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastPollMs: Date.now() - 5 * 60 * 1000, processedIds: [] };
  }
}

function saveState(state) {
  // Keep only last 500 processed IDs to prevent unbounded growth
  state.processedIds = state.processedIds.slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function getChannels() {
  const data = await api(`${BASE_V3}/chat/channels`);
  return (data.data || []).filter(ch => 
    ch.type === 'CHANNEL' && !ch.archived
  );
}

async function getMessages(channelId, limit = 20) {
  try {
    const data = await api(`${BASE_V3}/chat/channels/${channelId}/messages?limit=${limit}`);
    return data.data || data.messages || [];
  } catch (err) {
    console.error(`[chat-poller] Error fetching messages for ${channelId}: ${err.message}`);
    return [];
  }
}

function mentionsOogie(text) {
  if (!text) return false;
  return /\boogie\b/i.test(text);
}

function extractText(message) {
  // ClickUp chat messages can have complex content structures
  if (typeof message === 'string') return message;
  
  const content = message.content || [];
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'string') return block;
      if (block.text) return block.text;
      if (block.type === 'text' && block.text) return block.text;
      return '';
    }).join(' ');
  }
  
  return message.text_content || message.text || '';
}

async function main() {
  const state = loadState();
  const sinceMs = state.lastPollMs;
  const now = Date.now();
  
  console.error(`[chat-poller] Checking messages since ${new Date(sinceMs).toISOString()}`);
  
  const channels = await getChannels();
  console.error(`[chat-poller] Found ${channels.length} active channels`);
  
  const mentions = [];
  
  for (const channel of channels) {
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
    
    const messages = await getMessages(channel.id, 10);
    
    for (const msg of messages) {
      // Skip already processed
      if (state.processedIds.includes(msg.id)) continue;
      
      // Skip old messages
      const msgTime = parseInt(msg.date || msg.created_at || '0');
      if (msgTime && msgTime < sinceMs) continue;
      
      // Skip messages from Jake Shore's API token (that's us posting)
      if (msg.user?.id === 126241816) continue;
      
      const text = extractText(msg);
      
      if (mentionsOogie(text)) {
        mentions.push({
          channel_id: channel.id,
          channel_name: channel.name || '(unknown)',
          message_id: msg.id,
          user: msg.user?.username || 'Unknown',
          user_id: msg.user?.id,
          text: text,
          timestamp: msg.date || msg.created_at
        });
      }
      
      state.processedIds.push(msg.id);
    }
  }
  
  state.lastPollMs = now;
  saveState(state);
  
  if (mentions.length > 0) {
    // Output mentions as JSON for the cron to process
    console.log(JSON.stringify({ mentions, count: mentions.length }));
  } else {
    console.error('[chat-poller] No new @Oogie mentions');
  }
}

main().catch(err => {
  console.error(`[chat-poller] Fatal: ${err.message}`);
  process.exit(1);
});
