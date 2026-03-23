#!/usr/bin/env node
// clickup - ClickUp CLI for AI agents
// Single-file, zero-dependency CLI for the ClickUp API (v2 + v3 chat)

const DEFAULT_WORKSPACE_ID = '9013713404';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  white: '\x1b[37m', gray: '\x1b[90m',
  bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgYellow: '\x1b[43m', bgBlue: '\x1b[44m',
};
const paint = (color, text) => `${color}${text}${c.reset}`;
const bold = t => paint(c.bold, t);
const dim = t => paint(c.dim, t);

// ── Config & Auth ─────────────────────────────────────────────────────────────
function getToken() {
  const token = process.env.CLICKUP_API_KEY || process.env.CLICKUP_TOKEN;
  if (!token) {
    console.error(paint(c.red, '✗ No API token found. Set CLICKUP_API_KEY or CLICKUP_TOKEN env var.'));
    process.exit(1);
  }
  return token;
}

function getWorkspaceId() {
  return process.env.CLICKUP_WORKSPACE_ID || DEFAULT_WORKSPACE_ID;
}

// ── HTTP client ───────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const token = getToken();
  const version = opts.v3 ? 'v3' : 'v2';
  const base = `https://api.clickup.com/api/${version}`;
  const url = `${base}${path}`;
  const method = opts.method || 'GET';
  const headers = { 'Authorization': token, 'Content-Type': 'application/json' };
  const fetchOpts = { method, headers };
  if (opts.body) fetchOpts.body = JSON.stringify(opts.body);

  try {
    const res = await fetch(url, fetchOpts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      const msg = typeof data === 'object' ? (data.err || data.error || data.ECODE || JSON.stringify(data)) : data;
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    return data;
  } catch (err) {
    if (err.message.startsWith('HTTP ')) throw err;
    throw new Error(`Request failed: ${err.message}`);
  }
}

// ── Arg parser ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { args._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
    i++;
  }
  return args;
}

// ── Table formatting ──────────────────────────────────────────────────────────
// Strip ANSI escape codes for width calculations
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function table(rows, columns) {
  if (!rows.length) { console.log(dim('  (no results)')); return; }
  const widths = {};
  for (const col of columns) {
    widths[col.key] = col.label.length;
    for (const row of rows) {
      const val = String(col.fmt ? col.fmt(row[col.key], row) : (row[col.key] ?? ''));
      const visible = stripAnsi(val).length;
      widths[col.key] = Math.max(widths[col.key], visible);
    }
    // Cap width
    widths[col.key] = Math.min(widths[col.key], col.max || 60);
  }
  // Header
  const header = columns.map(col => paint(c.bold + c.cyan, col.label.padEnd(widths[col.key]))).join('  ');
  console.log(header);
  console.log(columns.map(col => dim('─'.repeat(widths[col.key]))).join('  '));
  // Rows
  for (const row of rows) {
    const line = columns.map(col => {
      let val = String(col.fmt ? col.fmt(row[col.key], row) : (row[col.key] ?? ''));
      const visLen = stripAnsi(val).length;
      if (visLen > widths[col.key]) {
        // Truncate by visible chars — strip, truncate, re-wrap
        const stripped = stripAnsi(val);
        val = stripped.slice(0, widths[col.key] - 1) + '…';
      }
      // Pad based on visible width
      const pad = widths[col.key] - stripAnsi(val).length;
      return val + (pad > 0 ? ' '.repeat(pad) : '');
    }).join('  ');
    console.log(line);
  }
  console.log(dim(`\n  ${rows.length} result${rows.length !== 1 ? 's' : ''}`));
}

// ── Priority & status helpers ─────────────────────────────────────────────────
const PRIORITY_MAP = { 1: paint(c.bgRed + c.white, ' URGENT '), 2: paint(c.red, 'High'), 3: paint(c.yellow, 'Normal'), 4: paint(c.blue, 'Low'), null: dim('none') };
function fmtPriority(p) {
  if (p && typeof p === 'object') return PRIORITY_MAP[p.id] || p.priority || dim('none');
  return PRIORITY_MAP[p] || dim('none');
}

function fmtStatus(s) {
  if (!s) return dim('none');
  const name = typeof s === 'object' ? s.status : s;
  const color = typeof s === 'object' && s.color ? `\x1b[38;2;${parseInt(s.color.slice(1,3),16)};${parseInt(s.color.slice(3,5),16)};${parseInt(s.color.slice(5,7),16)}m` : c.white;
  return `${color}${name}${c.reset}`;
}

function fmtDate(ts) {
  if (!ts) return dim('—');
  return new Date(Number(ts)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtAssignees(arr) {
  if (!arr || !arr.length) return dim('unassigned');
  return arr.map(a => a.username || a.initials || a.id).join(', ');
}

// ── Commands ──────────────────────────────────────────────────────────────────

// SPACES
async function cmdSpaces(args) {
  if (args.flags.help) return showHelp('spaces', 'List all spaces in the workspace', 'clickup spaces [--json]');
  const data = await api(`/team/${getWorkspaceId()}/space?archived=false`);
  const spaces = data.spaces || [];
  if (args.flags.json) return console.log(JSON.stringify(spaces, null, 2));
  console.log(bold('\n📂 Spaces\n'));
  table(spaces, [
    { key: 'id', label: 'ID', max: 16 },
    { key: 'name', label: 'Name', max: 30 },
    { key: 'statuses', label: 'Statuses', fmt: (v) => (v || []).map(s => s.status).join(', '), max: 50 },
  ]);
}

// LISTS
async function cmdLists(args) {
  if (args.flags.help) return showHelp('lists', 'List all lists (optionally filtered by space)', 'clickup lists [--space ID] [--json]');
  const spaceIds = args.flags.space ? [args.flags.space] : null;
  let allLists = [];
  const spaces = spaceIds || (await api(`/team/${getWorkspaceId()}/space?archived=false`)).spaces.map(s => s.id);
  for (const sid of spaces) {
    const folders = (await api(`/space/${sid}/folder?archived=false`)).folders || [];
    for (const folder of folders) {
      const lists = (await api(`/folder/${folder.id}/list?archived=false`)).lists || [];
      allLists.push(...lists.map(l => ({ ...l, folder_name: folder.name, space_id: sid })));
    }
    // Folderless lists
    const folderless = (await api(`/space/${sid}/list?archived=false`)).lists || [];
    allLists.push(...folderless.map(l => ({ ...l, folder_name: '(none)', space_id: sid })));
  }
  if (args.flags.json) return console.log(JSON.stringify(allLists, null, 2));
  console.log(bold('\n📋 Lists\n'));
  table(allLists, [
    { key: 'id', label: 'ID', max: 16 },
    { key: 'name', label: 'Name', max: 30 },
    { key: 'folder_name', label: 'Folder', max: 20 },
    { key: 'task_count', label: 'Tasks', max: 6, fmt: v => v != null ? String(v) : dim('?') },
    { key: 'space_id', label: 'Space', max: 16 },
  ]);
}

// TASKS
async function cmdTasks(args) {
  if (args.flags.help) return showHelp('tasks', 'List tasks', 'clickup tasks [--list ID] [--space ID] [--status STATUS] [--assignee NAME] [--limit N] [--json]');
  const limit = parseInt(args.flags.limit) || 50;

  if (args.flags.list) {
    // Get tasks from specific list
    let url = `/list/${args.flags.list}/task?page=0&include_closed=true&subtasks=true`;
    if (args.flags.status) url += `&statuses[]=${encodeURIComponent(args.flags.status)}`;
    if (args.flags.assignee) url += `&assignees[]=${args.flags.assignee}`;
    const data = await api(url);
    let tasks = data.tasks || [];
    tasks = tasks.slice(0, limit);
    if (args.flags.json) return console.log(JSON.stringify(tasks, null, 2));
    printTasks(tasks);
  } else if (args.flags.space) {
    // Get tasks from all lists in space
    const folders = (await api(`/space/${args.flags.space}/folder?archived=false`)).folders || [];
    let allTasks = [];
    for (const folder of folders) {
      const lists = (await api(`/folder/${folder.id}/list?archived=false`)).lists || [];
      for (const list of lists) {
        let url = `/list/${list.id}/task?page=0&include_closed=true&subtasks=true`;
        if (args.flags.status) url += `&statuses[]=${encodeURIComponent(args.flags.status)}`;
        const data = await api(url);
        allTasks.push(...(data.tasks || []));
        if (allTasks.length >= limit) break;
      }
      if (allTasks.length >= limit) break;
    }
    // Folderless
    if (allTasks.length < limit) {
      const folderless = (await api(`/space/${args.flags.space}/list?archived=false`)).lists || [];
      for (const list of folderless) {
        let url = `/list/${list.id}/task?page=0&include_closed=true&subtasks=true`;
        if (args.flags.status) url += `&statuses[]=${encodeURIComponent(args.flags.status)}`;
        const data = await api(url);
        allTasks.push(...(data.tasks || []));
        if (allTasks.length >= limit) break;
      }
    }
    allTasks = allTasks.slice(0, limit);
    if (args.flags.json) return console.log(JSON.stringify(allTasks, null, 2));
    printTasks(allTasks);
  } else {
    // Search across entire workspace via team tasks endpoint
    let url = `/team/${getWorkspaceId()}/task?page=0&include_closed=true&subtasks=true&order_by=updated&reverse=true`;
    if (args.flags.status) url += `&statuses[]=${encodeURIComponent(args.flags.status)}`;
    if (args.flags.assignee) url += `&assignees[]=${args.flags.assignee}`;
    const data = await api(url);
    let tasks = (data.tasks || []).slice(0, limit);
    if (args.flags.json) return console.log(JSON.stringify(tasks, null, 2));
    printTasks(tasks);
  }
}

function printTasks(tasks) {
  console.log(bold('\n📌 Tasks\n'));
  table(tasks, [
    { key: 'id', label: 'ID', max: 12 },
    { key: 'name', label: 'Name', max: 40 },
    { key: 'status', label: 'Status', fmt: (v) => fmtStatus(v), max: 16 },
    { key: 'priority', label: 'Priority', fmt: (v) => fmtPriority(v), max: 10 },
    { key: 'assignees', label: 'Assignees', fmt: (v) => fmtAssignees(v), max: 24 },
    { key: 'due_date', label: 'Due', fmt: (v) => fmtDate(v), max: 14 },
  ]);
}

// TASK (single detail)
async function cmdTask(args) {
  if (args.flags.help || !args._[0]) return showHelp('task', 'Get full task detail', 'clickup task <task-id> [--json]');
  const taskId = args._[0];
  const [task, commentsData] = await Promise.all([
    api(`/task/${taskId}?include_subtasks=true&include_markdown_description=true`),
    api(`/task/${taskId}/comment`).catch(() => ({ comments: [] })),
  ]);
  if (args.flags.json) return console.log(JSON.stringify({ ...task, _comments: commentsData.comments }, null, 2));

  console.log(bold(`\n📌 Task: ${task.name}\n`));
  console.log(`  ${dim('ID:')}          ${task.id}`);
  console.log(`  ${dim('Status:')}      ${fmtStatus(task.status)}`);
  console.log(`  ${dim('Priority:')}    ${fmtPriority(task.priority)}`);
  console.log(`  ${dim('Assignees:')}   ${fmtAssignees(task.assignees)}`);
  console.log(`  ${dim('Creator:')}     ${task.creator?.username || task.creator?.email || dim('—')}`);
  console.log(`  ${dim('Created:')}     ${fmtDate(task.date_created)}`);
  console.log(`  ${dim('Updated:')}     ${fmtDate(task.date_updated)}`);
  console.log(`  ${dim('Due:')}         ${fmtDate(task.due_date)}`);
  console.log(`  ${dim('List:')}        ${task.list?.name || dim('—')} ${dim(`(${task.list?.id || '—'})`)}`);
  console.log(`  ${dim('Space:')}       ${task.space?.id || dim('—')}`);
  console.log(`  ${dim('URL:')}         ${task.url || dim('—')}`);
  console.log(`  ${dim('Tags:')}        ${(task.tags || []).map(t => paint(c.cyan, t.name)).join(', ') || dim('none')}`);
  console.log(`  ${dim('Time Est:')}    ${task.time_estimate ? `${Math.round(task.time_estimate / 3600000)}h` : dim('—')}`);
  console.log(`  ${dim('Time Spent:')}  ${task.time_spent ? `${Math.round(task.time_spent / 3600000)}h` : dim('—')}`);

  // Description
  if (task.markdown_description || task.description || task.text_content) {
    console.log(`\n${bold('Description:')}`);
    console.log(dim('─'.repeat(60)));
    console.log(task.markdown_description || task.text_content || task.description || '');
    console.log(dim('─'.repeat(60)));
  }

  // Custom fields
  if (task.custom_fields?.length) {
    console.log(`\n${bold('Custom Fields:')}`);
    for (const cf of task.custom_fields) {
      const val = cf.value != null ? (typeof cf.value === 'object' ? JSON.stringify(cf.value) : String(cf.value)) : dim('empty');
      console.log(`  ${dim(cf.name + ':')}  ${val}`);
    }
  }

  // Subtasks
  if (task.subtasks?.length) {
    console.log(`\n${bold('Subtasks:')}`);
    for (const st of task.subtasks) {
      console.log(`  ${dim('•')} [${st.id}] ${st.name}  ${fmtStatus(st.status)}`);
    }
  }

  // Comments
  const comments = commentsData.comments || [];
  if (comments.length) {
    console.log(`\n${bold(`Comments (${comments.length}):`)}`);
    for (const cm of comments.slice(0, 20)) {
      const user = cm.user?.username || cm.user?.email || 'Unknown';
      const date = fmtDate(cm.date);
      const text = (cm.comment_text || '').slice(0, 200);
      console.log(`  ${paint(c.cyan, user)} ${dim(date)}`);
      console.log(`  ${text}${(cm.comment_text || '').length > 200 ? dim('…') : ''}\n`);
    }
  }
}

// CREATE TASK
async function cmdCreate(args) {
  if (args.flags.help || !args._[0] || !args.flags.name) return showHelp('create', 'Create a new task', 'clickup create <list-id> --name "Task name" [--desc "..."] [--assignee ID] [--priority 1-4] [--status "..."] [--due DATE] [--json]');
  const listId = args._[0];
  const body = { name: args.flags.name };
  if (args.flags.desc) body.markdown_description = args.flags.desc;
  if (args.flags.description) body.markdown_description = args.flags.description;
  if (args.flags.assignee) body.assignees = [parseInt(args.flags.assignee)];
  if (args.flags.priority) body.priority = parseInt(args.flags.priority);
  if (args.flags.status) body.status = args.flags.status;
  if (args.flags.due) {
    const d = new Date(args.flags.due);
    if (!isNaN(d)) body.due_date = d.getTime();
  }
  const task = await api(`/list/${listId}/task`, { method: 'POST', body });
  if (args.flags.json) return console.log(JSON.stringify(task, null, 2));
  console.log(paint(c.green, `\n✓ Task created: ${task.name}`));
  console.log(`  ${dim('ID:')}   ${task.id}`);
  console.log(`  ${dim('URL:')}  ${task.url}`);
}

// UPDATE TASK
async function cmdUpdate(args) {
  if (args.flags.help || !args._[0]) return showHelp('update', 'Update a task', 'clickup update <task-id> [--name "..."] [--desc "..."] [--status "..."] [--assignee ID] [--priority 1-4] [--due DATE] [--json]');
  const taskId = args._[0];
  const body = {};
  if (args.flags.name) body.name = args.flags.name;
  if (args.flags.desc) body.markdown_description = args.flags.desc;
  if (args.flags.description) body.markdown_description = args.flags.description;
  if (args.flags.status) body.status = args.flags.status;
  if (args.flags.priority) body.priority = parseInt(args.flags.priority);
  if (args.flags.due) {
    const d = new Date(args.flags.due);
    if (!isNaN(d)) body.due_date = d.getTime();
  }
  // Assignee handling: add
  if (args.flags.assignee) {
    body.assignees = { add: [parseInt(args.flags.assignee)] };
  }
  if (Object.keys(body).length === 0) {
    console.error(paint(c.yellow, '⚠ No update fields provided. Use --name, --desc, --status, --priority, --due, or --assignee.'));
    return;
  }
  const task = await api(`/task/${taskId}`, { method: 'PUT', body });
  if (args.flags.json) return console.log(JSON.stringify(task, null, 2));
  console.log(paint(c.green, `\n✓ Task updated: ${task.name}`));
  console.log(`  ${dim('ID:')}     ${task.id}`);
  console.log(`  ${dim('Status:')} ${fmtStatus(task.status)}`);
}

// COMMENT (post)
async function cmdComment(args) {
  if (args.flags.help || args._.length < 2) return showHelp('comment', 'Post a comment on a task', 'clickup comment <task-id> "message" [--json]');
  const taskId = args._[0];
  const message = args._.slice(1).join(' ');
  const body = { comment_text: message };
  const result = await api(`/task/${taskId}/comment`, { method: 'POST', body });
  if (args.flags.json) return console.log(JSON.stringify(result, null, 2));
  console.log(paint(c.green, `\n✓ Comment posted on task ${taskId}`));
}

// COMMENTS (list)
async function cmdComments(args) {
  if (args.flags.help || !args._[0]) return showHelp('comments', 'List comments on a task', 'clickup comments <task-id> [--json]');
  const taskId = args._[0];
  const data = await api(`/task/${taskId}/comment`);
  const comments = data.comments || [];
  if (args.flags.json) return console.log(JSON.stringify(comments, null, 2));
  console.log(bold(`\n💬 Comments on ${taskId}\n`));
  if (!comments.length) return console.log(dim('  (no comments)'));
  for (const cm of comments) {
    const user = cm.user?.username || cm.user?.email || 'Unknown';
    const date = fmtDate(cm.date);
    const text = cm.comment_text || '';
    console.log(`  ${paint(c.cyan, user)} ${dim(date)}`);
    console.log(`  ${text}\n`);
  }
  console.log(dim(`  ${comments.length} comment${comments.length !== 1 ? 's' : ''}`));
}

// CHAT CHANNELS
async function cmdChatChannels(args) {
  if (args.flags.help) return showHelp('chat channels', 'List all chat channels', 'clickup chat channels [--json]');
  const data = await api(`/workspaces/${getWorkspaceId()}/chat/channels`, { v3: true });
  const channels = data.data || data.channels || [];
  if (args.flags.json) return console.log(JSON.stringify(channels, null, 2));
  console.log(bold('\n💬 Chat Channels\n'));
  if (Array.isArray(channels) && channels.length) {
    table(channels, [
      { key: 'id', label: 'ID', max: 22 },
      { key: 'name', label: 'Name', max: 24, fmt: v => v || dim('(DM)') },
      { key: 'type', label: 'Type', max: 10 },
      { key: 'visibility', label: 'Visibility', max: 10 },
      { key: 'archived', label: 'Archived', max: 8, fmt: v => v ? paint(c.yellow, 'yes') : dim('no') },
    ]);
  } else {
    console.log(dim('  (no channels)'));
  }
}

// CHAT SEND
async function cmdChatSend(args) {
  if (args.flags.help || args._.length < 2) return showHelp('chat send', 'Send a chat message', 'clickup chat send <channel-id> "message" [--json]');
  const channelId = args._[0];
  const message = args._.slice(1).join(' ');
  const body = { content: message };
  const result = await api(`/workspaces/${getWorkspaceId()}/chat/channels/${channelId}/messages`, { method: 'POST', body, v3: true });
  if (args.flags.json) return console.log(JSON.stringify(result, null, 2));
  console.log(paint(c.green, `\n✓ Message sent to channel ${channelId}`));
}

// CHAT MESSAGES
async function cmdChatMessages(args) {
  if (args.flags.help || !args._[0]) return showHelp('chat messages', 'Read chat messages', 'clickup chat messages <channel-id> [--limit N] [--json]');
  const channelId = args._[0];
  const limit = parseInt(args.flags.limit) || 25;
  const data = await api(`/workspaces/${getWorkspaceId()}/chat/channels/${channelId}/messages?limit=${limit}`, { v3: true });
  const messages = data.data || data.messages || [];
  if (args.flags.json) return console.log(JSON.stringify(messages, null, 2));
  console.log(bold(`\n💬 Messages in channel ${channelId}\n`));
  if (Array.isArray(messages) && messages.length) {
    for (const m of messages) {
      const user = m.user?.username || m.user?.email || m.author?.username || 'Unknown';
      const date = m.date_created ? fmtDate(m.date_created) : '';
      const text = m.content || m.text || '';
      console.log(`  ${paint(c.cyan, user)} ${dim(date)} ${dim(`[${m.id || ''}]`)}`);
      console.log(`  ${text}\n`);
    }
  } else {
    console.log(dim('  Response:'), typeof messages === 'object' ? JSON.stringify(messages, null, 2) : messages);
  }
}

// CHAT REPLY
async function cmdChatReply(args) {
  if (args.flags.help || args._.length < 3) return showHelp('chat reply', 'Reply to a chat message', 'clickup chat reply <channel-id> <message-id> "message" [--json]');
  const channelId = args._[0];
  const messageId = args._[1];
  const message = args._.slice(2).join(' ');
  const body = { content: message, parent: messageId };
  const result = await api(`/workspaces/${getWorkspaceId()}/chat/channels/${channelId}/messages`, { method: 'POST', body, v3: true });
  if (args.flags.json) return console.log(JSON.stringify(result, null, 2));
  console.log(paint(c.green, `\n✓ Reply sent to message ${messageId} in channel ${channelId}`));
}

// MEMBERS
async function cmdMembers(args) {
  if (args.flags.help) return showHelp('members', 'List workspace members', 'clickup members [--json]');
  const data = await api(`/team/${getWorkspaceId()}`);
  const members = data.team?.members || [];
  if (args.flags.json) return console.log(JSON.stringify(members, null, 2));
  console.log(bold('\n👥 Members\n'));
  table(members.map(m => ({ ...m.user, role_value: m.user?.role })), [
    { key: 'id', label: 'ID', max: 12 },
    { key: 'username', label: 'Username', max: 20 },
    { key: 'email', label: 'Email', max: 30 },
    { key: 'role_value', label: 'Role', max: 10, fmt: (v) => { const map = { 1: paint(c.yellow, 'Owner'), 2: paint(c.cyan, 'Admin'), 3: 'Member', 4: 'Guest' }; return map[v] || String(v); }},
  ]);
}

// WEBHOOKS (list)
async function cmdWebhooks(args) {
  if (args.flags.help) return showHelp('webhooks', 'List webhooks', 'clickup webhooks [--json]');
  const data = await api(`/team/${getWorkspaceId()}/webhook`);
  const webhooks = data.webhooks || [];
  if (args.flags.json) return console.log(JSON.stringify(webhooks, null, 2));
  console.log(bold('\n🔗 Webhooks\n'));
  if (!webhooks.length) return console.log(dim('  (no webhooks)'));
  table(webhooks, [
    { key: 'id', label: 'ID', max: 40 },
    { key: 'endpoint', label: 'Endpoint', max: 50 },
    { key: 'status', label: 'Status', max: 10 },
    { key: 'events', label: 'Events', fmt: (v) => (v || []).join(', '), max: 40 },
  ]);
}

// WEBHOOK CREATE
async function cmdWebhookCreate(args) {
  if (args.flags.help || !args._[0]) return showHelp('webhook create', 'Create a webhook', 'clickup webhook create <endpoint> [--events event1,event2] [--json]');
  const endpoint = args._[0];
  const events = args.flags.events ? args.flags.events.split(',').map(e => e.trim()) : ['*'];
  const body = { endpoint, events };
  const result = await api(`/team/${getWorkspaceId()}/webhook`, { method: 'POST', body });
  if (args.flags.json) return console.log(JSON.stringify(result, null, 2));
  console.log(paint(c.green, `\n✓ Webhook created`));
  console.log(`  ${dim('ID:')}       ${result.webhook?.id || result.id}`);
  console.log(`  ${dim('Endpoint:')} ${endpoint}`);
  console.log(`  ${dim('Events:')}   ${events.join(', ')}`);
}

// WEBHOOK DELETE
async function cmdWebhookDelete(args) {
  if (args.flags.help || !args._[0]) return showHelp('webhook delete', 'Delete a webhook', 'clickup webhook delete <webhook-id> [--json]');
  const webhookId = args._[0];
  const result = await api(`/webhook/${webhookId}`, { method: 'DELETE' });
  if (args.flags.json) return console.log(JSON.stringify(result, null, 2));
  console.log(paint(c.green, `\n✓ Webhook ${webhookId} deleted`));
}

// SEARCH
async function cmdSearch(args) {
  if (args.flags.help || !args._[0]) return showHelp('search', 'Search tasks across workspace', 'clickup search "query" [--json]');
  const query = args._.join(' ');
  // Use the filtered team tasks endpoint approach — search by name matching
  // ClickUp doesn't have a dedicated search-by-text endpoint in v2 for personal tokens,
  // so we use the team tasks endpoint which returns recent tasks, and we can filter client-side
  // OR we try the search endpoint first
  let tasks = [];
  try {
    // Try the workspace search endpoint
    const data = await api(`/team/${getWorkspaceId()}/task?page=0&include_closed=true&subtasks=true&order_by=updated&reverse=true`);
    tasks = (data.tasks || []).filter(t =>
      (t.name || '').toLowerCase().includes(query.toLowerCase()) ||
      (t.description || '').toLowerCase().includes(query.toLowerCase()) ||
      (t.text_content || '').toLowerCase().includes(query.toLowerCase())
    );
  } catch {
    // Fallback
    console.error(paint(c.yellow, '⚠ Search not available, listing recent tasks instead'));
  }
  if (args.flags.json) return console.log(JSON.stringify(tasks, null, 2));
  console.log(bold(`\n🔍 Search: "${query}"\n`));
  printTasks(tasks);
}

// ── Help ──────────────────────────────────────────────────────────────────────
function showHelp(cmd, desc, usage) {
  console.log(`\n${bold(cmd)} — ${desc}`);
  console.log(`\n  ${dim('Usage:')} ${usage}\n`);
}

function showMainHelp() {
  console.log(`
${bold('clickup')} — ClickUp CLI for AI agents

${bold('Usage:')} clickup <command> [options]

${bold('Commands:')}
  ${paint(c.cyan, 'spaces')}                          List all spaces
  ${paint(c.cyan, 'lists')} [--space ID]               List all lists
  ${paint(c.cyan, 'tasks')} [--list ID] [--space ID]   List tasks
  ${paint(c.cyan, 'task')} <task-id>                   Get full task detail
  ${paint(c.cyan, 'create')} <list-id> --name "..."    Create a task
  ${paint(c.cyan, 'update')} <task-id> [--name ...]    Update a task
  ${paint(c.cyan, 'comment')} <task-id> "message"      Post a comment
  ${paint(c.cyan, 'comments')} <task-id>               List comments
  ${paint(c.cyan, 'chat channels')}                    List chat channels
  ${paint(c.cyan, 'chat send')} <ch-id> "msg"          Send chat message
  ${paint(c.cyan, 'chat messages')} <ch-id>            Read chat messages
  ${paint(c.cyan, 'chat reply')} <ch> <msg-id> "msg"   Reply to message
  ${paint(c.cyan, 'members')}                          List workspace members
  ${paint(c.cyan, 'webhooks')}                         List webhooks
  ${paint(c.cyan, 'webhook create')} <url> [--events]  Create webhook
  ${paint(c.cyan, 'webhook delete')} <id>              Delete webhook
  ${paint(c.cyan, 'search')} "query"                   Search tasks

${bold('Global Flags:')}
  ${dim('--json')}    Output raw JSON
  ${dim('--help')}    Show help for a command

${bold('Environment:')}
  CLICKUP_API_KEY or CLICKUP_TOKEN    API token (required)
  CLICKUP_WORKSPACE_ID               Workspace ID (default: ${DEFAULT_WORKSPACE_ID})
`);
}

// ── Router ────────────────────────────────────────────────────────────────────
async function main() {
  const rawArgs = process.argv.slice(2);
  if (!rawArgs.length || rawArgs[0] === '--help' || rawArgs[0] === 'help' || rawArgs[0] === '-h') {
    return showMainHelp();
  }

  const command = rawArgs[0];

  // Handle compound commands (chat, webhook)
  if (command === 'chat') {
    const subcommand = rawArgs[1];
    const args = parseArgs(rawArgs.slice(2));
    switch (subcommand) {
      case 'channels': return await cmdChatChannels(args);
      case 'send': return await cmdChatSend(args);
      case 'messages': return await cmdChatMessages(args);
      case 'reply': return await cmdChatReply(args);
      default:
        console.error(paint(c.red, `✗ Unknown chat subcommand: ${subcommand}`));
        console.log(dim('  Available: channels, send, messages, reply'));
        process.exit(1);
    }
  }

  if (command === 'webhook') {
    const subcommand = rawArgs[1];
    const args = parseArgs(rawArgs.slice(2));
    switch (subcommand) {
      case 'create': return await cmdWebhookCreate(args);
      case 'delete': return await cmdWebhookDelete(args);
      default:
        console.error(paint(c.red, `✗ Unknown webhook subcommand: ${subcommand}`));
        console.log(dim('  Available: create, delete'));
        process.exit(1);
    }
  }

  const args = parseArgs(rawArgs.slice(1));

  switch (command) {
    case 'spaces': return await cmdSpaces(args);
    case 'lists': return await cmdLists(args);
    case 'tasks': return await cmdTasks(args);
    case 'task': return await cmdTask(args);
    case 'create': return await cmdCreate(args);
    case 'update': return await cmdUpdate(args);
    case 'comment': return await cmdComment(args);
    case 'comments': return await cmdComments(args);
    case 'members': return await cmdMembers(args);
    case 'webhooks': return await cmdWebhooks(args);
    case 'search': return await cmdSearch(args);
    default:
      console.error(paint(c.red, `✗ Unknown command: ${command}`));
      console.log(dim('  Run "clickup --help" for usage.'));
      process.exit(1);
  }
}

main().catch(err => {
  console.error(paint(c.red, `✗ ${err.message}`));
  process.exit(1);
});
