#!/usr/bin/env node
const { chromium } = require('playwright');
const path = require('path');
const STATE_PATH = path.join(__dirname, '..', '.auth-state.json');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log('[save-session] Opening ClickUp login...');
  await page.goto('https://app.clickup.com/login', { waitUntil: 'networkidle', timeout: 30000 });

  const email = process.env.CLICKUP_EMAIL;
  const password = process.env.CLICKUP_PASSWORD;
  if (email && password) {
    console.log('[save-session] Filling credentials...');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    // Click login - the invisible reCAPTCHA should auto-solve in headed mode
    console.log('[save-session] Clicking login...');
    await page.click('[data-test="login-submit"]');
  }

  // Wait for URL to leave /login (any redirect = success)
  console.log('[save-session] Waiting for redirect...');
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 60000 }).catch(() => {
    console.log('[save-session] URL:', page.url());
  });

  console.log('[save-session] Current URL:', page.url());
  
  if (!page.url().includes('/login')) {
    console.log('[save-session] Login successful! Saving state...');
    await context.storageState({ path: STATE_PATH });
    console.log(`[save-session] Saved to ${STATE_PATH}`);
  } else {
    console.error('[save-session] Login failed - still on login page');
  }

  await browser.close();
})();
