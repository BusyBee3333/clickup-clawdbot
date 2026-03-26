# ClickUp + Clawdbot Integration

A complete integration layer between **ClickUp** and **Clawdbot** (an AI agent runtime). Enables your AI agent to read and write ClickUp tasks, monitor project health, respond to webhook events in real time, and send messages in ClickUp Chat — all from a single zero-dependency CLI.

---

## Architecture

```
ClickUp API
    │
    │  webhooks (HMAC-signed)
    ▼
Cloudflare Worker  ──────────────────────────────────────────────┐
(webhook-worker/)                                                 │
  • Validates HMAC-SHA256 signature                               │  normalized
  • Normalizes event payload                                      │  JSON event
  • Returns 200 immediately (no retries)                          │
    │                                                             │
    │  POST hooks.mcpengage.com/clickup/*  ──►  Gateway/Tunnel   │
    ▼                                                             │
clickup-event-handler.js (local Node server, port 3482) ◄────────┘
  • Logs all events to events.jsonl
  • Decides which events are worth a wake
  • Calls Clawdbot gateway /tools/invoke → wake AI session

Clawdbot AI Session
  • Receives wake text describing the event
  • Uses `clickup` CLI to fetch context (task details, comments)
  • Posts reply via `clickup comment` or `clickup chat send`

chat-poller.js  (runs on cron, every ~5 min)
  • Polls all ClickUp Chat channels ClickUp webhooks don't cover
  • Detects @Oogie mentions
  • Outputs JSON for the cron to handle

briefing.js  (runs daily)
  • Fetches overdue / due-today / in-progress tasks
  • Builds human-readable digest
  • Optionally posts to a ClickUp Chat channel

monitor.js  (runs on demand or cron)
  • Flags stale (>3d overdue), stuck (>5d no update), at-risk (<24h, not started)
  • Optionally posts comments on flagged tasks
```

### Component Map

| Component | Path | Runtime |
|---|---|---|
| CLI | `cli/clickup.js` | Node ≥ 18 (no deps) |
| Webhook Worker | `webhook-worker/` | Cloudflare Workers |
| Event Handler | `scripts/clickup-event-handler.js` | Node daemon (launchd/systemd) |
| Chat Poller | `scripts/chat-poller.js` | Node cron job (5-min) |
| Chat Daemon | `scripts/chat-daemon.js` | Node daemon (15-second realtime) |
| Full Scanner | `scripts/full-scan.py` | Python 3 cron job |
| Morning Briefing | `scripts/briefing.js` | Node cron job |
| Health Monitor | `scripts/monitor.js` | Node cron job |
| Clawdbot Skill | `skill/SKILL.md` | Clawdbot agent context |

---

## Quick Start

### Prerequisites

- Node.js ≥ 18 (for native `fetch`)
- A ClickUp account with API access
- [Clawdbot](https://github.com/clawdbot/clawdbot) agent runtime (for the event-driven features)
- Cloudflare account + `wrangler` CLI (for the webhook worker)

### 1. Install the CLI

```bash
# Clone the repo
git clone https://github.com/jakeshore/clickup-clawdbot
cd clickup-clawdbot

# Symlink the CLI onto your PATH
sudo ln -sf "$(pwd)/cli/clickup.js" /usr/local/bin/clickup
sudo chmod +x /usr/local/bin/clickup

# Set your ClickUp API token
export CLICKUP_API_KEY=pk_xxxxxxxxxxxxxxxxxxxxx
```

> Get your API token from **ClickUp → Settings → Apps → API Token**.

Test it:

```bash
clickup spaces
```

### 2. Deploy the Webhook Worker

```bash
cd webhook-worker
npm install

# Set secrets
wrangler secret put WEBHOOK_SECRET      # HMAC secret from ClickUp webhook registration
wrangler secret put CLAWDBOT_GATEWAY_URL # e.g. https://hooks.example.com/clawdbot/clickup

# Deploy
npm run deploy
```

The worker listens at `hooks.mcpengage.com/clickup/webhook` (configure the route in `wrangler.toml` for your domain).

### 3. Register the Webhook in ClickUp

```bash
clickup webhook create https://your-worker.workers.dev/clickup/webhook \
  --events taskCreated,taskStatusUpdated,taskCommentPosted,taskAssigneeUpdated,taskPriorityUpdated,taskDueDateUpdated,taskMoved,taskDeleted,taskTagUpdated
```

Copy the **webhook secret** from the response and set it as `WEBHOOK_SECRET` in the worker.

### 4. Start the Local Event Handler

```bash
# Run directly
CLICKUP_API_KEY=xxx node scripts/clickup-event-handler.js

# Or install as a launchd service (macOS) — see SETUP.md
```

The handler listens on `127.0.0.1:3482` and wakes your Clawdbot session when meaningful events arrive.

---

## CLI Reference

All commands require `CLICKUP_API_KEY` or `CLICKUP_TOKEN` to be set. All commands support `--json` for machine-readable output.

### Workspaces & Spaces

```bash
clickup spaces                    # List all spaces
clickup spaces --json             # Raw JSON output
```

### Lists

```bash
clickup lists                     # All lists across all spaces
clickup lists --space <SPACE_ID>  # Lists in a specific space
```

### Tasks

```bash
# List tasks
clickup tasks                                    # Recent tasks across workspace
clickup tasks --list <LIST_ID>                   # Tasks in a specific list
clickup tasks --space <SPACE_ID>                 # Tasks in all lists of a space
clickup tasks --status "in progress"             # Filter by status
clickup tasks --assignee "username"              # Filter by assignee
clickup tasks --limit 100                        # Limit results (default 50)

# Task detail
clickup task <TASK_ID>                           # Full task with comments, subtasks, custom fields

# Create a task
clickup create <LIST_ID> \
  --name "Fix login bug" \
  --desc "Users can't log in after the latest deploy" \
  --assignee <USER_ID> \
  --priority 2 \
  --status "to do" \
  --due "2025-08-01"

# Update a task
clickup update <TASK_ID> --status "done"
clickup update <TASK_ID> --name "New title" --priority 1
clickup update <TASK_ID> --assignee <USER_ID> --due "2025-08-15"

# Priority: 1=urgent, 2=high, 3=normal, 4=low
```

### Comments

```bash
clickup comment <TASK_ID> "Deployed the fix, verified in staging."
clickup comments <TASK_ID>           # List all comments
```

### Chat (v3 API)

```bash
clickup chat channels                                   # List all channels (get IDs here)
clickup chat messages <CHANNEL_ID>                      # Recent messages
clickup chat messages <CHANNEL_ID> --limit 50           # More messages
clickup chat send <CHANNEL_ID> "Deploy is live."        # Send a message
clickup chat reply <CHANNEL_ID> <MSG_ID> "Confirmed."   # Reply to a thread
```

### Members

```bash
clickup members                   # List workspace members with roles and IDs
```

### Search

```bash
clickup search "login bug"        # Search tasks by text (client-side filter)
clickup search "API rate limit"
```

### Webhooks

```bash
clickup webhooks                  # List registered webhooks
clickup webhook create <URL> --events taskCreated,taskCommentPosted
clickup webhook delete <WEBHOOK_ID>
```

### Global Flags

| Flag | Description |
|---|---|
| `--json` | Output raw JSON instead of formatted tables |
| `--help` | Show help for any command |

### Environment Variables

| Variable | Description |
|---|---|
| `CLICKUP_API_KEY` or `CLICKUP_TOKEN` | ClickUp API token **(required)** |
| `CLICKUP_WORKSPACE_ID` | Override default workspace ID |

---

## Scripts

### Morning Briefing (`scripts/briefing.js`)

Generates a daily digest of overdue tasks, tasks due today, in-progress work, and recent completions.

```bash
# Print to stdout
CLICKUP_API_KEY=xxx node scripts/briefing.js

# Post to a ClickUp Chat channel
CLICKUP_API_KEY=xxx node scripts/briefing.js --post --channel <CHANNEL_ID>

# JSON output for programmatic use
CLICKUP_API_KEY=xxx node scripts/briefing.js --json
```

**Output sections:**
- 🔴 **OVERDUE** — tasks with past due dates, sorted by how far overdue
- 📅 **DUE TODAY** — tasks due today with assignees
- 🔵 **IN PROGRESS** — currently active tasks
- ⚠️ **NEEDS ATTENTION** — unassigned tasks, blocked tasks
- ✅ **COMPLETED YESTERDAY** — tasks closed in the last 24h

---

### Health Monitor (`scripts/monitor.js`)

Identifies tasks that need intervention based on staleness, progress, and priority signals.

```bash
# Print health report
CLICKUP_API_KEY=xxx node scripts/monitor.js

# Post report to ClickUp Chat
CLICKUP_API_KEY=xxx node scripts/monitor.js --post --channel <CHANNEL_ID>

# Post comments on flagged tasks (use carefully)
CLICKUP_API_KEY=xxx node scripts/monitor.js --notify

# JSON output
CLICKUP_API_KEY=xxx node scripts/monitor.js --json
```

**Health checks:**
- 🚨 **STALE** — overdue by more than 3 days with no recent activity
- 🔄 **STUCK** — no status update in more than 5 days
- 🔥 **AT RISK** — due within 24 hours, still in "to do"/"open"
- 🔺 **HIGH PRIORITY UNASSIGNED** — urgent/high priority tasks with no owner

---

### Chat Poller (`scripts/chat-poller.js`)

Since ClickUp's webhook system doesn't cover Chat messages, this script polls all active channels and detects `@Oogie` (or any agent name) mentions.

```bash
CLICKUP_API_KEY=xxx node scripts/chat-poller.js
```

- Saves state to `logs/chat-poller-state.json` to avoid reprocessing
- Outputs JSON to stdout when new mentions are found: `{ mentions: [...], count: N }`
- Designed to run every 5 minutes via cron

---

### Chat Daemon (`scripts/chat-daemon.js`)

Near-realtime @mention detection daemon. Polls all accessible channels every 15 seconds (vs. the 5-minute cron approach of `chat-poller.js`).

```bash
# Minimal — just polls and logs mentions
CLICKUP_WORKSPACE_ID=xxx \
CLICKUP_AGENT_NAME=myagent \
node scripts/chat-daemon.js

# With Telegram alerts
CLICKUP_WORKSPACE_ID=xxx \
CLICKUP_AGENT_NAME=myagent \
TELEGRAM_BOT_TOKEN=xxx \
TELEGRAM_CHAT_ID=-1001234567890 \
node scripts/chat-daemon.js

# With auto-reply in ClickUp Chat
CLICKUP_WORKSPACE_ID=xxx \
CLICKUP_AGENT_NAME=myagent \
CLICKUP_AUTO_REPLY=1 \
CLICKUP_AUTO_REPLY_TEXT="Got it — working on it now." \
node scripts/chat-daemon.js
```

All configuration is via environment variables — see the [Adapting to Your Workspace](#adapting-to-your-workspace) section for the full list.

---

### Full Scan (`scripts/full-scan.py`)

Python 3 script that performs a comprehensive workspace scan: task comments, attachments, and Chat channel mentions — with deduplication so previously-seen items are never surfaced again.

```bash
# Scan specific spaces
CLICKUP_WORKSPACE_ID=xxx \
CLICKUP_SPACE_IDS=space1,space2 \
CLICKUP_CHANNEL_IDS=channel1,channel2 \
CLICKUP_USER_ID=<your-user-id> \
python3 scripts/full-scan.py

# Scan specific lists directly
CLICKUP_WORKSPACE_ID=xxx \
CLICKUP_LIST_IDS=list1,list2 \
python3 scripts/full-scan.py
```

Outputs `CLEAN` (nothing new) or a JSON array of findings to stdout. Designed to run as a cron job and pipe output to your agent runtime.

---

### Event Handler (`scripts/clickup-event-handler.js`)

Local HTTP server (port 3482) that receives forwarded events from the Cloudflare Worker and decides which ones are worth waking the AI agent.

**Wake triggers:**
- `@Oogie` mentioned in a comment
- Any new task comment posted
- New task created
- Task assignee changed
- Task moved to a "blocked" status

**Events that do NOT trigger a wake** (routine updates):
- Due date tweaks
- Priority changes without assignment
- Tag updates

---

## Webhook Worker

The Cloudflare Worker (`webhook-worker/`) is the public-facing entry point for ClickUp webhooks.

### Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/clickup/webhook` | Main webhook receiver (HMAC validated) |
| `GET` | `/clickup/health` | Health check |
| `POST` | `/clickup/test` | Echo endpoint for dev/testing |

### Security

ClickUp signs all webhook payloads with `HMAC-SHA256` using a shared secret. The worker:

1. Reads the raw request body
2. Computes `HMAC-SHA256(WEBHOOK_SECRET, rawBody)` using the Web Crypto API
3. Compares against the `X-Signature` header using **constant-time comparison** (prevents timing attacks)
4. Returns `401` if invalid — never processes unsigned payloads

### Configuration (`webhook-worker/wrangler.toml`)

```toml
name = "clickup-webhook"
main = "src/index.js"
compatibility_date = "2024-01-01"
account_id = "YOUR_CLOUDFLARE_ACCOUNT_ID"

routes = [
  { pattern = "hooks.example.com/clickup/*", zone_name = "example.com" }
]
```

### Secrets (set via `wrangler secret put`)

| Secret | Description |
|---|---|
| `WEBHOOK_SECRET` | HMAC-SHA256 shared secret from ClickUp webhook registration |
| `CLAWDBOT_GATEWAY_URL` | URL to forward normalized events to (default: `https://hooks.mcpengage.com/clawdbot/clickup`) |

### Event Normalization

Every raw ClickUp payload is normalized to a consistent shape before forwarding:

```json
{
  "source": "clickup",
  "event": "taskCommentPosted",
  "workspace_id": "9013713404",
  "task_id": "abc123",
  "webhook_id": "f8c27363-...",
  "comment_text": "Hey @Oogie can you review this?",
  "mentioned_oogie": true,
  "user": { "id": 88004124, "username": "samuel" },
  "raw": { /* original ClickUp payload */ },
  "timestamp": "2025-07-28T12:34:56.789Z"
}
```

---

## Clawdbot Skill

The `skill/` directory contains files for integrating this tool with the Clawdbot agent system.

### `skill/SKILL.md`

Loaded into the agent's context. Contains:
- Workspace reference (space IDs, member IDs, channel names)
- Full CLI usage examples
- Common task patterns (bug reports, status updates, workload analysis)
- Space-to-use heuristics based on request context
- Proactive behavior guidelines

### `skill/install.sh`

Dependency check script. Verifies:
1. `clickup` binary is present at `/usr/local/bin/clickup`
2. `CLICKUP_BURTONMETHOD_KEY` secret is stored in Signet

```bash
bash skill/install.sh
```

---

## ClickUp API — Lessons Learned

Hard-won lessons from production usage. Read these before building new integrations.

### Chat DMs have no public API

ClickUp Chat **direct messages (DMs) are not accessible via the API**. The v3 `/chat/channels` endpoint returns only public channels and private channels you're a member of. DMs are excluded entirely — you can't read or send DMs programmatically.

Workaround: use task comments or public Chat channels for agent-to-human communication.

### @mentions in comments require `type: "tag"` objects

Posting a plain text string like `"Hey @alice"` in a comment does **not** create a proper @mention notification. To tag a user so they receive a ClickUp notification, you must post a rich comment body using the `comment` array format:

```json
{
  "comment": [
    {
      "text": "Hey ",
      "type": "text"
    },
    {
      "type": "tag",
      "text": "@alice",
      "attrs": {
        "id": "<USER_ID>",
        "username": "alice",
        "email": "alice@example.com"
      }
    },
    {
      "text": " can you review this?",
      "type": "text"
    }
  ]
}
```

Using `comment_text` (the simple string field) will never notify anyone.

### Conversation view comments cannot be deleted via API

Comments posted to a **Conversation view** (the chat-like threaded view on a task) cannot be deleted via the `DELETE /api/v2/task/{id}/comment/{comment_id}` endpoint. The API returns `200` but the comment persists. This appears to be a ClickUp bug — there is no known workaround as of mid-2025.

Regular task comments (non-Conversation-view) can be deleted normally.

### `PUT /api/v2/space/{id}` nulls the space name if `name` is omitted

ClickUp's space update endpoint is not a partial-update (PATCH) — it is a full replace. If you call `PUT /api/v2/space/{id}` with a body that doesn't include the `name` field, the space name will be set to `null` and disappear from the UI.

**Always include `"name"` in your body when updating a space**, even if you're only changing another field:

```js
// ✅ Safe — includes name
await api(`/space/${spaceId}`, { method: 'PUT', body: { name: existingName, color: '#ff0000' } });

// ❌ Dangerous — nukes the space name
await api(`/space/${spaceId}`, { method: 'PUT', body: { color: '#ff0000' } });
```

This applies to `statuses`, `features`, and other top-level fields too — omitting them may clear their values.

### Rate limits are generous, but bulk operations need spacing

The ClickUp v2 API is generally forgiving on rate limits for typical usage. However, when running bulk operations (scanning many tasks, fetching comments for 50+ tasks in a loop, etc.), add a ~200ms delay between requests to avoid `429 Too Many Requests` errors:

```js
for (const task of tasks) {
  await fetchComments(task.id);
  await new Promise(r => setTimeout(r, 200)); // 200ms spacing
}
```

The `briefing.js` and `monitor.js` scripts already include retry-after handling for `429` responses.

---

## Adapting to Your Workspace

All workspace-specific values are now configurable via environment variables — no hardcoded IDs in the scripts.

### Required environment variables

| Variable | Description |
|---|---|
| `CLICKUP_API_KEY` | Your ClickUp API token |
| `CLICKUP_WORKSPACE_ID` | Your workspace (team) ID |

### Optional environment variables

| Variable | Used by | Description |
|---|---|---|
| `CLICKUP_API_KEY_FILE` | All scripts + CLI | Path to a file containing your API token. Default: `~/.agents/secrets/clickup-api-key.txt`. Useful for agent runtimes that store secrets in files rather than env vars. |
| `CLICKUP_SPACE_IDS` | `briefing.js`, `full-scan.py` | Comma-separated space IDs to scan. If omitted, `briefing.js` scans the entire workspace; `full-scan.py` requires this or `CLICKUP_LIST_IDS`. |
| `CLICKUP_LIST_IDS` | `full-scan.py` | Comma-separated list IDs to scan directly (alternative to `CLICKUP_SPACE_IDS`). |
| `CLICKUP_CHANNEL_ID` | `briefing.js`, `monitor.js` | Channel to post reports to when using `--post`. |
| `CLICKUP_CHANNEL_IDS` | `full-scan.py` | Comma-separated channel IDs to check for mentions. |
| `CLICKUP_AGENT_NAME` | `chat-poller.js`, `chat-daemon.js` | Your agent's display name (default: `oogie` for `chat-poller.js`, `rose` for `chat-daemon.js`). |
| `CLICKUP_AGENT_USER_ID` | `chat-daemon.js`, `full-scan.py` | Your agent's ClickUp user ID — own messages are skipped. |
| `CLICKUP_BOT_USER_ID` | `chat-poller.js` | Numeric user ID of the bot — own messages are skipped. |
| `CLICKUP_POLL_MS` | `chat-daemon.js` | Poll interval in milliseconds (default: 15000). |
| `CLICKUP_STATE_FILE` | `chat-poller.js`, `chat-daemon.js`, `full-scan.py` | Path to the dedup/state JSON file. |
| `TELEGRAM_BOT_TOKEN` | `chat-daemon.js` | Telegram bot token for alerts. |
| `TELEGRAM_CHAT_ID` | `chat-daemon.js` | Telegram chat/group to send alerts to. |
| `CLICKUP_AUTO_REPLY` | `chat-daemon.js` | Set to `1` to auto-reply in ClickUp Chat when mentioned. |

### Webhook worker

Update `webhook-worker/wrangler.toml` with your Cloudflare `account_id` and `routes`.

---

## File Structure

```
clickup-clawdbot/
├── cli/
│   └── clickup.js              # Zero-dep CLI — full ClickUp API v2 + v3 chat
├── webhook-worker/
│   ├── src/
│   │   └── index.js            # Cloudflare Worker — webhook receiver
│   ├── wrangler.toml           # Wrangler config (update account_id + routes)
│   └── package.json
├── scripts/
│   ├── briefing.js             # Daily morning briefing generator
│   ├── monitor.js              # Task health monitor
│   ├── chat-poller.js          # Chat channel @mention poller (5-min cron)
│   ├── chat-daemon.js          # Realtime @mention daemon (15-second polling)
│   ├── full-scan.py            # Full workspace scan — comments, attachments, mentions
│   └── clickup-event-handler.js # Local event server (port 3482)
├── skill/
│   ├── SKILL.md                # Clawdbot agent skill context
│   └── install.sh              # Dependency checker
├── SETUP.md                    # Workspace-specific config reference
├── RECOVERY.md                 # Emergency recovery procedures
├── LICENSE
└── README.md
```

---

## Development

### Testing the Webhook Worker Locally

```bash
cd webhook-worker
npm run dev      # Starts wrangler dev server at localhost:8787

# Test health check
curl http://localhost:8787/clickup/health

# Test echo endpoint
curl -X POST http://localhost:8787/clickup/test \
  -H "Content-Type: application/json" \
  -d '{"event": "taskCreated", "task_id": "test123"}'
```

### Watching Worker Logs in Production

```bash
cd webhook-worker
npm run tail
```

### Running the Event Handler

```bash
node scripts/clickup-event-handler.js

# In another terminal, send a test event
curl -X POST http://127.0.0.1:3482/clawdbot/clickup \
  -H "Content-Type: application/json" \
  -d '{"event":"taskCommentPosted","task_id":"abc123","mentioned_oogie":true,"comment_text":"hey @oogie review this","user":{"username":"jake"}}'
```

---

## Recovery

See [`RECOVERY.md`](RECOVERY.md) for procedures covering:
- Clawdbot gateway crashes
- Chat watcher failures
- Webhook flooding
- Disabling all ClickUp crons

---

## License

MIT — see [LICENSE](LICENSE).
