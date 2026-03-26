#!/usr/bin/env node
/**
 * ClickUp WebSocket Realtime Daemon
 *
 * Intercepts ClickUp's WebSocket stream (frontdoor-prod) via a headless browser
 * to get true realtime notifications — no polling delay.
 *
 * How it works:
 *   1. Launches headless Chromium, logs into ClickUp
 *   2. Intercepts the WebSocket connection to frontdoor-prod.pusher.com
 *   3. Monitors all frames for @mentions, task comments, chat messages
 *   4. Logs events and optionally triggers wake callbacks
 *
 * Prerequisites:
 *   - Playwright: npm install playwright
 *   - ClickUp credentials via env vars or config
 *
 * Environment Variables:
 *   CLICKUP_EMAIL        - ClickUp login email (required)
 *   CLICKUP_PASSWORD     - ClickUp login password (required)
 *   CLICKUP_USER_ID      - Your ClickUp user ID (for @mention detection)
 *   CLICKUP_WS_LOG       - Path to raw WebSocket log file (default: /tmp/clickup-ws-raw.log)
 *   CLICKUP_WS_CALLBACK  - Optional URL to POST when a mention is detected
 *   CLICKUP_WS_TIMEOUT   - Session timeout in ms (0 = run forever, default: 0)
 *   CLICKUP_WS_HEADED    - Set to "true" for visible browser (debugging)
 *
 * Usage:
 *   CLICKUP_EMAIL=you@example.com CLICKUP_PASSWORD=pass CLICKUP_USER_ID=12345 node ws-daemon.js
 */

const fs = require('fs');
const path = require('path');

// Config from env
const EMAIL = process.env.CLICKUP_EMAIL;
const PASSWORD = process.env.CLICKUP_PASSWORD;
const USER_ID = process.env.CLICKUP_USER_ID || '';
const LOG_FILE = process.env.CLICKUP_WS_LOG || '/tmp/clickup-ws-raw.log';
const CALLBACK_URL = process.env.CLICKUP_WS_CALLBACK || '';
const TIMEOUT = parseInt(process.env.CLICKUP_WS_TIMEOUT || '0', 10);
const HEADED = process.env.CLICKUP_WS_HEADED === 'true';

if (!EMAIL || !PASSWORD) {
  console.error('Error: CLICKUP_EMAIL and CLICKUP_PASSWORD are required.');
  console.error('Usage: CLICKUP_EMAIL=you@example.com CLICKUP_PASSWORD=pass node ws-daemon.js');
  process.exit(1);
}

async function notifyCallback(eventType, payload) {
  if (!CALLBACK_URL) return;
  try {
    const response = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: eventType, payload, timestamp: new Date().toISOString() }),
    });
    if (!response.ok) {
      console.error(`[ws-daemon] Callback failed: ${response.status}`);
    }
  } catch (err) {
    console.error(`[ws-daemon] Callback error: ${err.message}`);
  }
}

(async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Error: playwright is required. Install: npm install playwright');
    process.exit(1);
  }

  console.log('[ws-daemon] Starting headless browser for ClickUp WS interception...');
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  let wsConnected = false;

  page.on('websocket', ws => {
    if (ws.url().includes('frontdoor-prod')) {
      wsConnected = true;
      console.log(`[ws-daemon] Connected to ClickUp realtime stream`);
      console.log(`[ws-daemon] WebSocket URL: ${ws.url().substring(0, 80)}...`);

      ws.on('framereceived', frame => {
        let payload = frame.payload;
        if (typeof payload !== 'string') payload = payload.toString('utf8');

        // Log all frames to file
        try {
          fs.appendFileSync(LOG_FILE, payload + '\n');
        } catch (e) {
          // Log file write failure is non-fatal
        }

        // Skip heartbeats and auth frames
        if (payload.includes('heartbeat') || payload.includes('AuthReceived') || payload.includes('pusher:')) {
          return;
        }

        // Check for @mentions of our user
        if (USER_ID && payload.includes(USER_ID)) {
          console.log('\n' + '='.repeat(60));
          console.log(`[MENTION DETECTED] ${new Date().toISOString()}`);
          console.log(payload.substring(0, 500));
          console.log('='.repeat(60) + '\n');
          notifyCallback('mention', payload);
        }

        // Log interesting events
        try {
          const data = JSON.parse(payload);
          const eventName = data.event || '';
          if (eventName.includes('Comment') || eventName.includes('chat') || eventName.includes('task')) {
            console.log(`[ws-daemon] Event: ${eventName} (${payload.length} bytes)`);
          }
        } catch {
          // Not JSON, skip
        }
      });

      ws.on('close', () => {
        console.log('[ws-daemon] WebSocket closed. ClickUp may have disconnected.');
        wsConnected = false;
      });

      ws.on('socketerror', err => {
        console.error('[ws-daemon] WebSocket error:', err);
      });
    }
  });

  try {
    console.log('[ws-daemon] Navigating to ClickUp login...');
    await page.goto('https://app.clickup.com/login', { waitUntil: 'networkidle', timeout: 30000 });

    console.log('[ws-daemon] Filling credentials...');
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('[data-test="login-submit"]');

    // Wait for login to complete
    await page.waitForURL('**/home**', { timeout: 30000 }).catch(() => {
      console.log('[ws-daemon] URL did not change to /home, checking if logged in...');
    });

    // Give WebSocket time to connect
    await page.waitForTimeout(5000);

    if (wsConnected) {
      console.log('[ws-daemon] Logged in and listening to realtime stream.');
    } else {
      console.log('[ws-daemon] Logged in but WebSocket not yet connected. Waiting...');
      await page.waitForTimeout(10000);
    }

    if (TIMEOUT > 0) {
      console.log(`[ws-daemon] Will run for ${TIMEOUT / 1000}s then exit.`);
      await page.waitForTimeout(TIMEOUT);
      console.log('[ws-daemon] Timeout reached, shutting down.');
    } else {
      console.log('[ws-daemon] Running indefinitely. Ctrl+C to stop.');
      // Keep alive forever
      await new Promise(() => {});
    }
  } catch (err) {
    console.error('[ws-daemon] Error:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('[ws-daemon] Browser closed.');
  }
})();
