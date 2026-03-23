# ClickUp Integration Setup Reference

## Workspace
- Name: The Burton Method
- ID: 9013713404
- Account: jake@burtonmethod.com
- API Key: signet secret CLICKUP_BURTONMETHOD_KEY

## Webhook
- ID: YOUR_WEBHOOK_ID
- Endpoint: https://hooks.mcpengage.com/clickup/webhook
- Secret: stored in CF Worker as WEBHOOK_SECRET
- Events: taskCreated, taskUpdated, taskStatusUpdated, taskCommentPosted, taskAssigneeUpdated, taskPriorityUpdated, taskDueDateUpdated, taskMoved, taskDeleted, taskTagUpdated

## Components
1. **CLI**: /usr/local/bin/clickup (symlink → clickup-integration/cli/clickup.js)
2. **Webhook Worker**: clickup-webhook.jake-2ab.workers.dev / hooks.mcpengage.com/clickup
3. **Skill**: skills/clickup/SKILL.md

## Architecture
ClickUp Events → Webhook Worker (CF) → Clawdbot Gateway → Agent Session → clickup CLI → ClickUp API

## Team
- Jake Shore (owner, ID 126241816)
- Samuel Burton (admin, ID 88004124)
- Reed Gantz (admin, ID 88004130)
- Haseeb Qureshi (member, ID 111934779)
