#!/usr/bin/env node
/**
 * ClickUp WebSocket Realtime Daemon — Persistent Session
 *
 * Uses saved browser session state (cookies) to skip the login page entirely.
 * Run save-session.js once (headed) to create the session, then this daemon
 * reuses it headlessly — no CAPTCHA needed.
 *
 * Environment Variables:
 *   CLICKUP_EMAIL        - ClickUp login email (for save-session.js)
 *   CLICKUP_PASSWORD     - ClickUp login password (for save-session.js)
 *   CLICKUP_USER_ID      - Your ClickUp user ID (for @mention detection)
 *   CLICKUP_WS_LOG       - Path to raw WebSocket log file
 *   CLICKUP_WS_CALLBACK  - URL to POST when a mention is detected
 *   CLICKUP_WS_TIMEOUT   - Session timeout in ms (0 = forever)
 *   CLICKUP_WS_HEADED    - "true" for visible browser (debugging)
 *   CLICKUP_AUTH_STATE    - Path to saved auth state JSON
 */

const fs = require('fs');
const path = require('path');

const USER_ID = process.env.CLICKUP_USER_ID || '';
const LOG_FILE = process.env.CLICKUP_WS_LOG || '/tmp/clickup-ws-raw.log';
const CALLBACK_URL = process.env.CLICKUP_WS_CALLBACK || '';
const TIMEOUT = parseInt(process.env.CLICKUP_WS_TIMEOUT || '0', 10);
const HEADED = process.env.CLICKUP_WS_HEADED === 'true';
const AUTH_STATE = process.env.CLICKUP_AUTH_STATE || path.join(__dirname, '..', '.auth-state.json');
const WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID || '9013713404';

async function notifyCallback(eventType, payload) {
  if (!CALLBACK_URL) return;
  try {
    const response = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: eventType, payload, timestamp: new Date().toISOString() }),
    });
    if (!response.ok) console.error(`[ws-daemon] Callback failed: ${response.status}`);
  } catch (err) {
    console.error(`[ws-daemon] Callback error: ${err.message}`);
  }
}

// ── Reconnect config ──────────────────────────────────────────────────────────
const RECONNECT_DELAY_MS = 5000;        // Wait between reconnect attempts
const MAX_RECONNECT_FAILURES = 10;      // Give up after this many consecutive failures
const SESSION_REFRESH_INTERVAL = TIMEOUT > 0 ? TIMEOUT : 14 * 60 * 1000; // Cycle browser to keep session fresh

(async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Error: playwright required. npm install playwright');
    process.exit(1);
  }

  // Check for saved auth state
  if (!fs.existsSync(AUTH_STATE)) {
    console.error(`[ws-daemon] No auth state at ${AUTH_STATE}`);
    console.error('[ws-daemon] Run save-session.js first to create it.');
    process.exit(1);
  }

  let consecutiveFailures = 0;

  // ── Main loop: connect → listen → reconnect ──────────────────────────────
  while (consecutiveFailures < MAX_RECONNECT_FAILURES) {
    let browser = null;
    let context = null;
    let page = null;
    let wsConnected = false;

    try {
      const cycleStart = Date.now();
      console.log(`[ws-daemon] Starting browser (cycle ${consecutiveFailures > 0 ? 'retry #' + consecutiveFailures : 'fresh'})...`);

      browser = await chromium.launch({
        headless: !HEADED,
        args: ['--disable-blink-features=AutomationControlled']
      });

      context = await browser.newContext({
        storageState: AUTH_STATE,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });

      page = await context.newPage();

      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      // WebSocket event wiring
      page.on('websocket', ws => {
        if (ws.url().includes('frontdoor-prod') || ws.url().includes('clickup.com/ws')) {
          wsConnected = true;
          console.log(`[ws-daemon] Connected to ClickUp realtime stream`);
          console.log(`[ws-daemon] WebSocket URL: ${ws.url().substring(0, 80)}...`);

          ws.on('framereceived', frame => {
            let payload = frame.payload;
            if (typeof payload !== 'string') payload = payload.toString('utf8');
            try { fs.appendFileSync(LOG_FILE, payload + '\n'); } catch {}
            if (payload.includes('heartbeat') || payload.includes('AuthReceived') || payload.includes('pusher:')) return;
            if (USER_ID && payload.includes(USER_ID)) {
              console.log('\n' + '='.repeat(60));
              console.log(`[MENTION DETECTED] ${new Date().toISOString()}`);
              console.log(payload.substring(0, 500));
              console.log('='.repeat(60) + '\n');
              notifyCallback('mention', payload);
            }
            try {
              const data = JSON.parse(payload);
              const eventName = data.event || '';
              if (eventName.includes('Comment') || eventName.includes('chat') || eventName.includes('task')) {
                console.log(`[ws-daemon] Event: ${eventName} (${payload.length} bytes)`);
              }
            } catch {}
          });

          ws.on('close', () => { console.log('[ws-daemon] WebSocket closed by server.'); wsConnected = false; });
          ws.on('socketerror', err => { console.error('[ws-daemon] WebSocket error:', err); wsConnected = false; });
        }
      });

      // Navigate to workspace
      const wsUrl = `https://app.clickup.com/${WORKSPACE_ID}/home`;
      console.log(`[ws-daemon] Navigating to ${wsUrl}...`);
      await page.goto(wsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Check for login redirect (session expired)
      await page.waitForTimeout(5000);
      const currentUrl = page.url();
      console.log('[ws-daemon] Current URL:', currentUrl);

      if (currentUrl.includes('/login')) {
        console.error('[ws-daemon] Session expired — redirected to login.');
        console.error('[ws-daemon] Run save-session.js again to refresh the session.');
        process.exitCode = 1;
        await browser.close();
        return; // Fatal — can't auto-recover from expired session
      }

      // Wait for WebSocket
      await page.waitForTimeout(10000);

      if (!wsConnected) {
        console.log('[ws-daemon] WebSocket not yet connected. Waiting longer...');
        await page.waitForTimeout(15000);
      }

      if (wsConnected) {
        console.log('[ws-daemon] Authenticated and listening to realtime stream.');
        await context.storageState({ path: AUTH_STATE });
        console.log('[ws-daemon] Session state refreshed.');
        consecutiveFailures = 0; // Reset failure counter on success

        // Listen until session refresh interval, then cycle
        console.log(`[ws-daemon] Listening for ${SESSION_REFRESH_INTERVAL / 1000}s before session refresh...`);
        await page.waitForTimeout(SESSION_REFRESH_INTERVAL);

        // Save fresh state before cycling
        try {
          await context.storageState({ path: AUTH_STATE });
          console.log('[ws-daemon] Session state saved before reconnect cycle.');
        } catch (saveErr) {
          console.error(`[ws-daemon] Failed to save state: ${saveErr.message}`);
        }
      } else {
        console.error('[ws-daemon] WebSocket failed to connect this cycle.');
        consecutiveFailures++;
      }
    } catch (err) {
      console.error(`[ws-daemon] Error in cycle: ${err.message}`);
      consecutiveFailures++;
    } finally {
      // Clean up browser for this cycle
      try {
        if (browser) await browser.close();
        console.log('[ws-daemon] Browser closed for this cycle.');
      } catch {}
    }

    // Delay before reconnect
    if (consecutiveFailures < MAX_RECONNECT_FAILURES) {
      const delay = RECONNECT_DELAY_MS * Math.min(consecutiveFailures + 1, 6); // Back off up to 30s
      console.log(`[ws-daemon] Reconnecting in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.error(`[ws-daemon] FATAL: ${MAX_RECONNECT_FAILURES} consecutive failures. Exiting.`);
  process.exitCode = 1;
})();
