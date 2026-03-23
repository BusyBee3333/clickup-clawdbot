# ClickUp Skill — The Burton Method Workspace

## Description

This skill enables Clawdbot to interact with ClickUp: read and create tasks, update statuses, assign work, post comments, send chat messages, and analyze team workload. Activates on queries like:

> "check clickup", "create a task", "what's on the board", "post in clickup chat", "clickup status", "task update", "assign task", "comment on task", "who's working on what", "what's overdue", "morning briefing", "project status", "move task to done", "summarize the backlog", "search for a task"

---

## Authentication

All CLI commands must be wrapped with `signet secret exec` to inject the API key:

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c 'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup <command>'
```

**Shorthand alias for documentation below:** `CU` = the full signet wrapper prefix. Every example below expands to the full form.

---

## Workspace Reference

| Resource | Name | ID |
|---|---|---|
| Workspace | The Burton Method | `9013713404` |
| Space | TBM | `90132878675` |
| Space | Development | `90132878801` |
| Space | TBMApp | `901311854521` |
| Space | Customer Support | `90136872281` |

### Members

| Name | Role | ID |
|---|---|---|
| Jake Shore | Owner | `126241816` |
| Samuel Burton | Admin | — |
| Reed Gantz | Admin | — |
| Haseeb Qureshi | Member | — |

### Chat Channels

`TBM`, `Development`, `Content Creation`, `Operations`, `Welcome`, `List`, `General`, plus DMs.
Get channel IDs with: `clickup chat channels`

---

## CLI Reference

### Spaces & Lists

```bash
# List all spaces
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup spaces'

# List all lists (optionally filtered by space)
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup lists'

signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup lists --space 90132878801'
```

### Tasks

```bash
# List tasks (many filter options)
clickup tasks
clickup tasks --list <LIST_ID>
clickup tasks --space <SPACE_ID>
clickup tasks --status "in progress"
clickup tasks --assignee "Jake Shore"
clickup tasks --limit 50

# Get single task detail
clickup task <TASK_ID>

# Create a task
clickup create <LIST_ID> \
  --name "Fix login bug" \
  --desc "Users can't log in after the deploy" \
  --assignee 126241816 \
  --priority 2

# Update a task
clickup update <TASK_ID> --status "done"
clickup update <TASK_ID> --name "New title"
clickup update <TASK_ID> --assignee 126241816 --priority 1

# Priority scale: 1=urgent, 2=high, 3=normal, 4=low
```

### Comments

```bash
# Post a comment on a task
clickup comment <TASK_ID> "Deployed the fix — verified in staging."

# Read all comments on a task
clickup comments <TASK_ID>
```

### Chat

```bash
# List all chat channels (get IDs here)
clickup chat channels

# Send a message to a channel
clickup chat send <CHANNEL_ID> "Deploy is live, all green."

# Read recent messages in a channel
clickup chat messages <CHANNEL_ID>

# Reply to a specific message
clickup chat reply <CHANNEL_ID> <MESSAGE_ID> "Thanks, confirmed on my end too."
```

### Members & Search

```bash
# List all workspace members
clickup members

# Full-text search across all tasks
clickup search "login bug"
clickup search "API rate limit"

# List configured webhooks
clickup webhooks
```

---

## Wrapper Pattern (copy-paste ready)

Replace `<CMD>` with any clickup subcommand + flags:

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup <CMD>'
```

---

## Example Patterns

### 1. "What tasks are overdue?"

List all tasks and look for those with due dates in the past. Run per-space or per-list:

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup tasks --space 90132878675 --limit 100'
```

Filter the output for tasks where `due_date` is before today. Summarize by name, assignee, and how far overdue.

---

### 2. "Create a bug report"

Default to the Development space list unless the user specifies otherwise. First get the list ID if needed:

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup lists --space 90132878801'
```

Then create:

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup create <LIST_ID> \
    --name "Bug: [short description]" \
    --desc "[full reproduction steps / context]" \
    --priority 2'
```

---

### 3. "What's Jake working on?"

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup tasks --assignee "Jake Shore" --limit 50'
```

Group results by status (To Do / In Progress / Review) and present as a summary.

---

### 4. "Post an update in the dev channel"

First resolve the channel ID if not cached:

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup chat channels'
```

Then send:

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup chat send <DEV_CHANNEL_ID> \
    "Update: authentication refactor is merged and deployed to staging. QA can begin."'
```

---

### 5. "Summarize the TBM board"

Pull all tasks for the TBM space and group by status:

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup tasks --space 90132878675 --limit 100'
```

Present as:
- **To Do:** N tasks
- **In Progress:** N tasks (list names + assignees)
- **Review/QA:** N tasks
- **Done:** N tasks (recent)
- **Blocked:** N tasks (flag these)

---

### 6. "Move task X to done"

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup update <TASK_ID> --status "done"'
```

If unsure of the exact task ID, search first:

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup search "task name keywords"'
```

---

### 7. "Comment on a task about progress"

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup comment <TASK_ID> \
    "Progress update: completed the data migration step. Next up is integration testing."'
```

---

### 8. "What happened in the Operations channel?"

```bash
# Get channel ID
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup chat channels'

# Read recent messages
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup chat messages <OPS_CHANNEL_ID>'
```

Summarize the last N messages, noting any action items, decisions, or open questions.

---

### 9. "Who's got the most tasks?"

Pull task counts per assignee across spaces:

```bash
# For each space, run:
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup tasks --space 90132878675 --limit 200'

# Repeat for 90132878801, 901311854521, 90136872281
```

Tally task counts per member across all spaces. Present ranked list with task totals and breakdown by status.

---

### 10. "Search for anything about the API"

```bash
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'CLICKUP_API_KEY=$CLICKUP_BURTONMETHOD_KEY clickup search "API"'
```

Return task names, their list/space, status, and assignee. Group by space for clarity.

---

## Proactive Behaviors

### Project Status Request
When asked "what's the project status?" or "what's going on in ClickUp?":
1. Pull tasks from all 4 spaces
2. Group by status
3. Flag overdue, blocked, or unassigned tasks
4. Summarize in plain language

### Create & Assign Work
When asked to "create a task for X" or "assign this to Y":
1. Determine the right space/list from context (Dev bug → Development space, customer issue → Customer Support space)
2. Run `clickup create` with name, description, assignee, priority
3. Confirm back with the task ID and a link if available

### Webhook Response Pattern
When a ClickUp webhook event arrives (e.g. task status change, new comment):
1. Parse the event payload for task ID, event type, and actor
2. Post a contextual comment using `clickup comment <task-id> "..."`
3. Optionally notify in the relevant chat channel

### Team Workload Analysis
When asked "how's the team doing?" or "who's overloaded?":
1. Run `clickup members` to confirm member list
2. Pull tasks per assignee across all spaces
3. Present workload table: member → in-progress count → total open count → overdue count
4. Flag anyone with >10 open tasks or multiple overdue items

### Morning Briefing Pattern
When triggered for a daily briefing:
1. **Overdue:** `clickup tasks --status "to do"` + filter past due dates
2. **Due today:** filter tasks with today's due date
3. **In Progress:** `clickup tasks --status "in progress"`
4. **Unassigned:** tasks with no assignee
5. Present as a clean digest: overdue first, then today's items, then a short summary of in-progress work

---

## Space-to-Use Heuristic

| User Request Context | Default Space |
|---|---|
| Bug reports, features, technical work | Development (`90132878801`) |
| Product/strategy/content | TBM (`90132878675`) |
| App-specific work | TBMApp (`901311854521`) |
| Customer issues, support tickets | Customer Support (`90136872281`) |

When in doubt, ask the user which space/list to use, or search first to find an existing related task.

---

## Notes

- Task IDs are alphanumeric strings (e.g. `abc123`). They appear in ClickUp URLs and CLI output.
- Status names are workspace-specific. Common ones: `to do`, `in progress`, `review`, `done`, `blocked`.
- Always confirm before bulk-updating or closing multiple tasks.
- When posting chat messages on behalf of a user, be clear it's coming from Clawdbot/buba unless told otherwise.
