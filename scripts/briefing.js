#!/usr/bin/env node
// briefing.js — ClickUp Morning Briefing Generator
// Zero external deps — uses built-in fetch (Node 18+)
// Usage: CLICKUP_API_KEY=xxx node briefing.js [--post] [--json] [--channel CHANNEL_ID]

const API_KEY = process.env.CLICKUP_API_KEY;
if (!API_KEY) {
  console.error('Error: CLICKUP_API_KEY environment variable is required');
  process.exit(1);
}

const TEAM_ID = '9013713404';
const SPACE_IDS = ['90132878675', '90132878801', '901311854521', '90136872281'];
const DEFAULT_CHANNEL_ID = '4-90132878675-8';
const BASE_URL = 'https://api.clickup.com/api/v2';
const BASE_URL_V3 = 'https://api.clickup.com/api/v3';

// Parse CLI args
const args = process.argv.slice(2);
const FLAG_POST = args.includes('--post');
const FLAG_JSON = args.includes('--json');
const channelIdx = args.indexOf('--channel');
const CHANNEL_ID = channelIdx !== -1 && args[channelIdx + 1] ? args[channelIdx + 1] : DEFAULT_CHANNEL_ID;

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

async function fetchRecentlyClosed() {
  const now = Date.now();
  const yesterday = now - 24 * 60 * 60 * 1000;
  // Fetch closed tasks using date_closed filter
  const url = `${BASE_URL}/team/${TEAM_ID}/task?statuses[]=closed&statuses[]=complete&statuses[]=done&statuses[]=completed&include_closed=true&subtasks=true&order_by=updated&reverse=true&date_done_gt=${yesterday}&page=0`;
  try {
    const data = await apiFetch(url);
    return (data.tasks || []).filter(t => {
      const closed = parseInt(t.date_closed || '0', 10);
      return closed >= yesterday;
    });
  } catch {
    return [];
  }
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

function statusContains(task, keyword) {
  const s = (task.status?.status || '').toLowerCase();
  return s.includes(keyword);
}

function categorizeTasks(openTasks, closedTasks) {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  const overdue = [];
  const dueToday = [];
  const inProgress = [];
  const blocked = [];
  const unassigned = [];

  for (const task of openTasks) {
    const due = task.due_date ? parseInt(task.due_date, 10) : null;

    // Overdue: has due date in the past
    if (due && due < todayStart) {
      overdue.push(task);
    }

    // Due today
    if (due && due >= todayStart && due < todayEnd) {
      dueToday.push(task);
    }

    // In progress
    if (statusContains(task, 'progress')) {
      inProgress.push(task);
    }

    // Blocked
    if (statusContains(task, 'block')) {
      blocked.push(task);
    }

    // Unassigned
    if (!task.assignees || task.assignees.length === 0) {
      unassigned.push(task);
    }
  }

  return { overdue, dueToday, inProgress, blocked, unassigned, recentlyClosed: closedTasks };
}

function buildBriefing(categories) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const todayStart = startOfDay(now);
  const lines = [];

  lines.push(`Good morning team ʕ•ᴥ•ʔ`);
  lines.push('');
  lines.push(`📊 Daily Briefing — ${dateStr}`);
  lines.push('');

  // Overdue
  if (categories.overdue.length > 0) {
    lines.push(`🔴 OVERDUE (${categories.overdue.length} task${categories.overdue.length !== 1 ? 's' : ''})`);
    for (const t of categories.overdue.slice(0, 15)) {
      const due = parseInt(t.due_date, 10);
      const daysOver = daysBetween(due, todayStart);
      const assignee = getAssignees(t) || 'unassigned';
      lines.push(`• ${t.name} — assigned to ${assignee}, due ${formatDate(t.due_date)} (${daysOver} day${daysOver !== 1 ? 's' : ''} overdue)`);
    }
    if (categories.overdue.length > 15) lines.push(`  ... and ${categories.overdue.length - 15} more`);
    lines.push('');
  }

  // Due today
  if (categories.dueToday.length > 0) {
    lines.push(`📅 DUE TODAY (${categories.dueToday.length} task${categories.dueToday.length !== 1 ? 's' : ''})`);
    for (const t of categories.dueToday.slice(0, 15)) {
      const assignee = getAssignees(t) || 'unassigned';
      lines.push(`• ${t.name} — assigned to ${assignee}`);
    }
    if (categories.dueToday.length > 15) lines.push(`  ... and ${categories.dueToday.length - 15} more`);
    lines.push('');
  }

  // In progress
  if (categories.inProgress.length > 0) {
    lines.push(`🔵 IN PROGRESS (${categories.inProgress.length} task${categories.inProgress.length !== 1 ? 's' : ''})`);
    for (const t of categories.inProgress.slice(0, 15)) {
      const assignee = getAssignees(t) || 'unassigned';
      lines.push(`• ${t.name} — ${assignee}`);
    }
    if (categories.inProgress.length > 15) lines.push(`  ... and ${categories.inProgress.length - 15} more`);
    lines.push('');
  }

  // Needs attention
  const attentionItems = [];
  if (categories.unassigned.length > 0) {
    attentionItems.push(`${categories.unassigned.length} task${categories.unassigned.length !== 1 ? 's have' : ' has'} no assignee`);
  }
  if (categories.blocked.length > 0) {
    attentionItems.push(`${categories.blocked.length} task${categories.blocked.length !== 1 ? 's are' : ' is'} blocked`);
  }
  if (attentionItems.length > 0) {
    lines.push('⚠️ NEEDS ATTENTION');
    for (const item of attentionItems) {
      lines.push(`• ${item}`);
    }
    lines.push('');
  }

  // Completed yesterday
  lines.push(`✅ COMPLETED YESTERDAY: ${categories.recentlyClosed.length} task${categories.recentlyClosed.length !== 1 ? 's' : ''}`);
  if (categories.recentlyClosed.length > 0) {
    for (const t of categories.recentlyClosed.slice(0, 10)) {
      lines.push(`• ${t.name}`);
    }
    if (categories.recentlyClosed.length > 10) lines.push(`  ... and ${categories.recentlyClosed.length - 10} more`);
  }
  lines.push('');
  lines.push('Have a productive day! 🚀');

  return lines.join('\n');
}

async function postToChat(message, channelId) {
  const url = `${BASE_URL_V3}/workspaces/${TEAM_ID}/chat/channels/${channelId}/messages`;
  const body = { content: [{ text: message, type: 'text' }] };
  return apiFetch(url, { method: 'POST', body: JSON.stringify(body) });
}

async function main() {
  try {
    console.error('Fetching open tasks...');
    const [openTasks, closedTasks] = await Promise.all([
      fetchOpenTasks(),
      fetchRecentlyClosed()
    ]);

    console.error(`Found ${openTasks.length} open tasks, ${closedTasks.length} recently closed tasks`);

    const categories = categorizeTasks(openTasks, closedTasks);

    if (FLAG_JSON) {
      const output = {
        generated: new Date().toISOString(),
        summary: {
          total_open: openTasks.length,
          overdue: categories.overdue.length,
          due_today: categories.dueToday.length,
          in_progress: categories.inProgress.length,
          blocked: categories.blocked.length,
          unassigned: categories.unassigned.length,
          recently_closed: categories.recentlyClosed.length,
        },
        overdue: categories.overdue.map(t => ({ id: t.id, name: t.name, due: t.due_date, assignees: t.assignees, status: t.status?.status })),
        due_today: categories.dueToday.map(t => ({ id: t.id, name: t.name, due: t.due_date, assignees: t.assignees, status: t.status?.status })),
        in_progress: categories.inProgress.map(t => ({ id: t.id, name: t.name, assignees: t.assignees, status: t.status?.status })),
        blocked: categories.blocked.map(t => ({ id: t.id, name: t.name, assignees: t.assignees, status: t.status?.status })),
        unassigned: categories.unassigned.map(t => ({ id: t.id, name: t.name, status: t.status?.status })),
        recently_closed: categories.recentlyClosed.map(t => ({ id: t.id, name: t.name, date_closed: t.date_closed })),
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      const briefing = buildBriefing(categories);
      console.log(briefing);

      if (FLAG_POST) {
        console.error(`\nPosting briefing to channel ${CHANNEL_ID}...`);
        try {
          await postToChat(briefing, CHANNEL_ID);
          console.error('Briefing posted successfully!');
        } catch (err) {
          console.error(`Failed to post briefing: ${err.message}`);
          process.exit(1);
        }
      }
    }
  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
