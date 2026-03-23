# ClickUp Integration — Emergency Recovery

## If Oogie is dead / gateway won't start:

```bash
# Restore the pre-ClickUp config
cp /Users/jackshard/.clawdbot/clawdbot.json.backup-20260322-225920 /Users/jackshard/.clawdbot/clawdbot.json

# Restart gateway
clawdbot gateway restart

# If clawdbot CLI hangs, kill and restart manually:
pkill -f clawdbot-gateway
sleep 2
clawdbot gateway start
```

## If the Chat Watcher is broken:

```bash
# Stop it
launchctl unload ~/Library/LaunchAgents/com.oogie.clickup-chat-watcher.plist

# Check logs
tail -50 ~/.clawdbot/workspace/clickup-integration/logs/chat-watcher-stdout.log

# Restart it
launchctl load ~/Library/LaunchAgents/com.oogie.clickup-chat-watcher.plist

# Make sure the clawd browser is running (the watcher needs it)
# In Discord: @Oogie start the clawd browser
```

## If just the ClickUp event handler is broken:

```bash
# Stop it
launchctl unload ~/Library/LaunchAgents/com.oogie.clickup-events.plist

# Oogie will still work fine, just won't get ClickUp events in real-time
# The 5-min cron poller is a fallback
```

## If the webhook is flooding events:

```bash
# Delete the ClickUp webhook
signet secret exec --secret CLICKUP_BURTONMETHOD_KEY -- bash -c \
  'curl -s -X DELETE "https://api.clickup.com/api/v2/webhook/f8c27363-3062-4b08-aafa-aae37bfc9332" \
  -H "Authorization: $CLICKUP_BURTONMETHOD_KEY"'
```

## Disable all ClickUp crons:

In Discord, tell Oogie: "disable all clickup crons"
Or manually: cron IDs are `9b0f8943`, `255a1c55`, `64b1023d`
