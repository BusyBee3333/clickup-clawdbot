#!/usr/bin/env node
// monitor.js — ClickUp Task Health Monitor
// Zero external deps — uses built-in fetch (Node 18+)
// Usage: CLICKUP_API_KEY=xxx node monitor.js [--post] [--notify] [--json] [--channel CHANNEL_ID]

const API_KEY = process.env.CLICKUP_API_KEY;
if (!API_KEY) {
  console.error('Error: CLICKUP_API_KEY environment variable is required');
  process.exit(1);
}

const TEAM_ID = '9013713404';
const DEFAULT_CHANNEL_ID = '4-90132878675-8';
const BASE_URL = 'https://api.clickup.com/api/v2';
const BASE_URL_V3 = 'https://api.clickup.com/api/v3';

// Parse CLI args
const args = process.argv.slice(2);
const FLAG_POST = args.includes('--post');
const FLAG_NOTIFY = args.includes('--notify');
const FLAG_JSON = args.includes('--json');
const channelIdx = args.indexOf('--channel');
const CHANNEL_ID = channelIdx !== -1 && args[channelIdx + 1] ? args[channelIdx + 1] : DEFAULT_CHANNEL_ID;

// Constants for thresholds
const STALE_DAYS = 3;      // overdue by >3 days = stale
const STUCK_DAYS = 5;      // same status for >5 days = stuck
const AT_RISK_HOURS = 24;  // due within 24h and still in "to do" = at risk

// Helpers
const headers = { Authorization: API_KEY, 'Content-Type': 'application/json' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiFetch(url, options = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers });
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('retry-after') || '5', 10) * 1000;
        console.error(`Rate limited, waiting ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.error(`Attempt ${attempt} failed: ${err.message}. Retrying...`);
      await sleep(1000 * attempt);
    }
  }
}

async function fetchOpenTasks() {
  const statuses = ['to do', 'in progress', 'open', 'review', 'pending', 'planned'];
  const statusParams = statuses.map(s => `statuses[]=${encodeURIComponent(s)}`).join('&');
  const url = `${BASE_URL}/team/${TEAM_ID}/task?${statusParams}&include_closed=false&subtasks=true&page=0`;
  const data = await apiFetch(url);
  return data.tasks || [];
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDate(ms) {
  if (!ms) return 'no date';
  const d = new Date(parseInt(ms, 10));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysBetween(ms1, ms2) {
  return Math.floor((ms2 - ms1) / (1000 * 60 * 60 * 24));
}

function getAssignees(task) {
  if (!task.assignees || task.assignees.length === 0) return null;
  return task.assignees.map(a => a.username || a.email || 'Unknown').join(', ');
}

function getStatusName(task) {
  return task.status?.status || 'unknown';
}

function isHighPriority(task) {
  const p = task.priority;
  if (!p) return false;
  const level = (p.priority || p.id || '').toString().toLowerCase();
  return level === '1' || level === '2' || level === 'urgent' || level === 'high';
}

function analyzeHealth(tasks) {
  const now = Date.now();
  const todayStart = startOfDay(now);

  const stale = [];      // overdue >3 days
  const stuck = [];      // same status >5 days
  const atRisk = [];     // due within 24h, still in "to do"
  const highNoAssign = []; // high/urgent priority, no assignee

  for (const task of tasks) {
    const due = task.due_date ? parseInt(task.due_date, 10) : null;
    const statusName = getStatusName(task).toLowerCase();
    const dateUpdated = task.date_updated ? parseInt(task.date_updated, 10) : null;
    const dateCreated = task.date_created ? parseInt(task.date_created, 10) : null;
    // status_changed: ClickUp doesn't expose this directly; use date_updated as proxy
    // For "stuck" detection, we compare date_updated vs now

    // STALE: overdue by >3 days
    if (due && due < todayStart) {
      const daysOverdue = daysBetween(due, now);
      if (daysOverdue > STALE_DAYS) {
        stale.push({ ...task, _daysOverdue: daysOverdue });
      }
    }

    // STUCK: not updated in >5 days (proxy for same status)
    if (dateUpdated) {
      const daysSinceUpdate = daysBetween(dateUpdated, now);
      if (daysSinceUpdate > STUCK_DAYS) {
        stuck.push({ ...task, _daysSinceUpdate: daysSinceUpdate, _lastUpdated: dateUpdated });
      }
    }

    // AT RISK: due within 24 hours, still in "to do" or "open"
    if (due) {
      const hoursUntilDue = (due - now) / (1000 * 60 * 60);
      if (hoursUntilDue > 0 && hoursUntilDue <= AT_RISK_HOURS && (statusName.includes('to do') || statusName === 'open')) {
        atRisk.push({ ...task, _hoursUntilDue: Math.round(hoursUntilDue) });
      }
    }

    // HIGH PRIORITY NO ASSIGNEE
    if (isHighPriority(task) && (!task.assignees || task.assignees.length === 0)) {
      highNoAssign.push(task);
    }
  }

  return { stale, stuck, atRisk, highNoAssign };
}

function buildReport(health) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lines = [];

  lines.push(`⚠️ Task Health Report — ${dateStr}`);
  lines.push('');

  // Stale
  if (health.stale.length > 0) {
    lines.push(`🚨 STALE (overdue >${STALE_DAYS} days, no recent activity) — ${health.stale.length} task${health.stale.length !== 1 ? 's' : ''}`);
    for (const t of health.stale.slice(0, 15)) {
      const assignee = getAssignees(t) || 'unassigned';
      lines.push(`• ${t.name} — ${getStatusName(t)}, ${t._daysOverdue} days overdue, assigned to ${assignee}`);
    }
    if (health.stale.length > 15) lines.push(`  ... and ${health.stale.length - 15} more`);
    lines.push('');
  } else {
    lines.push('🚨 STALE — None! 🎉');
    lines.push('');
  }

  // Stuck
  if (health.stuck.length > 0) {
    lines.push(`🔄 STUCK (no updates >${STUCK_DAYS} days) — ${health.stuck.length} task${health.stuck.length !== 1 ? 's' : ''}`);
    for (const t of health.stuck.slice(0, 15)) {
      const assignee = getAssignees(t) || 'unassigned';
      lines.push(`• ${t.name} — in "${getStatusName(t)}" for ${t._daysSinceUpdate} days, assigned to ${assignee}`);
    }
    if (health.stuck.length > 15) lines.push(`  ... and ${health.stuck.length - 15} more`);
    lines.push('');
  } else {
    lines.push('🔄 STUCK — None! 🎉');
    lines.push('');
  }

  // At Risk
  if (health.atRisk.length > 0) {
    lines.push(`🔥 AT RISK (due soon, not started) — ${health.atRisk.length} task${health.atRisk.length !== 1 ? 's' : ''}`);
    for (const t of health.atRisk.slice(0, 15)) {
      lines.push(`• ${t.name} — due ${formatDate(t.due_date)}, still in ${getStatusName(t)} (~${t._hoursUntilDue}h left)`);
    }
    if (health.atRisk.length > 15) lines.push(`  ... and ${health.atRisk.length - 15} more`);
    lines.push('');
  } else {
    lines.push('🔥 AT RISK — None! 🎉');
    lines.push('');
  }

  // High priority unassigned
  if (health.highNoAssign.length > 0) {
    lines.push(`🔺 HIGH/URGENT PRIORITY — NO ASSIGNEE — ${health.highNoAssign.length} task${health.highNoAssign.length !== 1 ? 's' : ''}`);
    for (const t of health.highNoAssign.slice(0, 10)) {
      const pName = t.priority?.priority || t.priority?.id || '?';
      lines.push(`• ${t.name} — priority: ${pName}, status: ${getStatusName(t)}`);
    }
    if (health.highNoAssign.length > 10) lines.push(`  ... and ${health.highNoAssign.length - 10} more`);
    lines.push('');
  }

  // Summary
  lines.push(`📊 Summary: ${health.stale.length} stale, ${health.stuck.length} stuck, ${health.atRisk.length} at risk, ${health.highNoAssign.length} high-priority unassigned`);

  return lines.join('\n');
}

async function postToChat(message, channelId) {
  const url = `${BASE_URL_V3}/workspaces/${TEAM_ID}/chat/channels/${channelId}/messages`;
  const body = { content: [{ text: message, type: 'text' }] };
  return apiFetch(url, { method: 'POST', body: JSON.stringify(body) });
}

async function postComment(taskId, text) {
  const url = `${BASE_URL}/task/${taskId}/comment`;
  const body = { comment_text: text };
  return apiFetch(url, { method: 'POST', body: JSON.stringify(body) });
}

async function notifyOnTasks(health) {
  const allFlagged = [
    ...health.stale.map(t => ({ task: t, reason: `This task is ${t._daysOverdue} days overdue and appears stale. Please update its status or add a comment.` })),
    ...health.atRisk.map(t => ({ task: t, reason: `This task is due in ~${t._hoursUntilDue} hours and hasn't been started yet. It's at risk of missing its deadline.` })),
    ...health.highNoAssign.map(t => ({ task: t, reason: `This is a high/urgent priority task with no assignee. Please assign someone.` })),
  ];

  let posted = 0;
  let failed = 0;

  for (const { task, reason } of allFlagged.slice(0, 20)) { // limit to 20 to avoid rate limits
    try {
      await postComment(task.id, `⚠️ Health Monitor Alert: ${reason}`);
      posted++;
      await sleep(500); // gentle rate limiting
    } catch (err) {
      console.error(`Failed to comment on task ${task.id} (${task.name}): ${err.message}`);
      failed++;
    }
  }

  console.error(`Notifications: ${posted} posted, ${failed} failed`);
}

async function main() {
  try {
    console.error('Fetching open tasks...');
    const tasks = await fetchOpenTasks();
    console.error(`Found ${tasks.length} open tasks`);

    const health = analyzeHealth(tasks);

    if (FLAG_JSON) {
      const output = {
        generated: new Date().toISOString(),
        summary: {
          total_open: tasks.length,
          stale: health.stale.length,
          stuck: health.stuck.length,
          at_risk: health.atRisk.length,
          high_priority_unassigned: health.highNoAssign.length,
        },
        stale: health.stale.map(t => ({ id: t.id, name: t.name, status: getStatusName(t), days_overdue: t._daysOverdue, assignees: t.assignees })),
        stuck: health.stuck.map(t => ({ id: t.id, name: t.name, status: getStatusName(t), days_since_update: t._daysSinceUpdate, assignees: t.assignees })),
        at_risk: health.atRisk.map(t => ({ id: t.id, name: t.name, status: getStatusName(t), hours_until_due: t._hoursUntilDue, due_date: t.due_date })),
        high_priority_unassigned: health.highNoAssign.map(t => ({ id: t.id, name: t.name, status: getStatusName(t), priority: t.priority })),
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      const report = buildReport(health);
      console.log(report);

      if (FLAG_POST) {
        console.error(`\nPosting report to channel ${CHANNEL_ID}...`);
        try {
          await postToChat(report, CHANNEL_ID);
          console.error('Report posted successfully!');
        } catch (err) {
          console.error(`Failed to post report: ${err.message}`);
        }
      }

      if (FLAG_NOTIFY) {
        console.error('\nPosting comments on flagged tasks...');
        await notifyOnTasks(health);
      }
    }
  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
