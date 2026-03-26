#!/usr/bin/env python3
"""
full-scan.py — Full ClickUp workspace scan

Checks all comments, attachments, and @mentions on assigned tasks, then
polls chat channels for recent activity. Outputs JSON findings or "CLEAN".

Configuration via environment variables:
  CLICKUP_API_KEY          ClickUp API token (or see CLICKUP_API_KEY_FILE)
  CLICKUP_API_KEY_FILE     Path to file containing API token
                           (default: ~/.agents/secrets/clickup-api-key.txt)
  CLICKUP_WORKSPACE_ID     Workspace (team) ID (required)
  CLICKUP_USER_ID          Your ClickUp user ID — comments from this ID are skipped
  CLICKUP_SPACE_IDS        Comma-separated space IDs to scan
                           (required unless CLICKUP_LIST_IDS is set)
  CLICKUP_LIST_IDS         Comma-separated list IDs to scan directly (optional)
  CLICKUP_CHANNEL_IDS      Comma-separated chat channel IDs to poll
  CLICKUP_SCAN_WINDOW_MS   Look-back window in milliseconds (default: 300000 = 5 min)
  CLICKUP_STATE_FILE       Path to deduplication state file
                           (default: ~/.agents/logs/clickup-responded-ids.json)
"""

import requests
import time
import json
import sys
import os
from pathlib import Path


# ── Auth & Config ──────────────────────────────────────────────────────────────

def resolve_api_key():
    key = os.environ.get('CLICKUP_API_KEY', '').strip()
    if key:
        return key
    key_file = os.environ.get(
        'CLICKUP_API_KEY_FILE',
        str(Path.home() / '.agents' / 'secrets' / 'clickup-api-key.txt')
    )
    try:
        return Path(key_file).read_text().strip()
    except FileNotFoundError:
        print(f'Error: API key not found. Set CLICKUP_API_KEY or CLICKUP_API_KEY_FILE.', file=sys.stderr)
        sys.exit(1)


API_KEY = resolve_api_key()
HEADERS = {'Authorization': API_KEY, 'Content-Type': 'application/json'}

TEAM_ID = os.environ.get('CLICKUP_WORKSPACE_ID', '').strip()
if not TEAM_ID:
    print('Error: CLICKUP_WORKSPACE_ID is required', file=sys.stderr)
    sys.exit(1)

# Your user ID — comments/messages from this ID are skipped (they're your own)
MY_USER_ID = os.environ.get('CLICKUP_USER_ID', '').strip()

# Spaces to scan (comma-separated)
SPACE_IDS = [s.strip() for s in os.environ.get('CLICKUP_SPACE_IDS', '').split(',') if s.strip()]

# Optional: scan specific list IDs directly instead of discovering via spaces
LIST_IDS = [s.strip() for s in os.environ.get('CLICKUP_LIST_IDS', '').split(',') if s.strip()]

# Chat channel IDs to check (comma-separated)
CHANNEL_IDS = [s.strip() for s in os.environ.get('CLICKUP_CHANNEL_IDS', '').split(',') if s.strip()]

# Look-back window (default: 5 minutes)
WINDOW_MS = int(os.environ.get('CLICKUP_SCAN_WINDOW_MS', str(5 * 60 * 1000)))

# Deduplication state file
STATE_FILE = Path(os.environ.get(
    'CLICKUP_STATE_FILE',
    str(Path.home() / '.agents' / 'logs' / 'clickup-responded-ids.json')
))

# ── State (deduplication) ──────────────────────────────────────────────────────

def load_state():
    try:
        with open(STATE_FILE) as f:
            return set(json.load(f))
    except Exception:
        return set()


def save_state(ids: set):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Keep only the 2000 most recent IDs to bound file size
    trimmed = list(ids)[-2000:]
    with open(STATE_FILE, 'w') as f:
        json.dump(trimmed, f)


# ── Helpers ────────────────────────────────────────────────────────────────────

BASE_V2 = 'https://api.clickup.com/api/v2'
BASE_V3 = 'https://api.clickup.com/api/v3'

now_ms = int(time.time() * 1000)
since_ms = now_ms - WINDOW_MS


def get(url, **kwargs):
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10, **kwargs)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f'[warn] GET {url}: {e}', file=sys.stderr)
        return {}


# ── Discover lists ─────────────────────────────────────────────────────────────

def discover_lists():
    """Return list of {id, name} dicts from configured spaces (or LIST_IDS)."""
    lists = []

    if LIST_IDS:
        return [{'id': lid} for lid in LIST_IDS]

    for space_id in SPACE_IDS:
        # Folders
        folders = get(f'{BASE_V2}/space/{space_id}/folder?archived=false').get('folders', [])
        for folder in folders:
            for lst in folder.get('lists', []):
                if lst.get('task_count', 0) != 0:
                    lists.append({'id': lst['id'], 'name': lst.get('name', '')})
        # Folderless lists
        for lst in get(f'{BASE_V2}/space/{space_id}/list?archived=false').get('lists', []):
            if lst.get('task_count', 0) != 0:
                lists.append({'id': lst['id'], 'name': lst.get('name', '')})

    return lists


# ── Main scan ──────────────────────────────────────────────────────────────────

responded_ids = load_state()
findings = []
new_ids = set()


# === 1. Scan tasks for new comments and attachments ===

lists = discover_lists()
if not lists and not SPACE_IDS and not LIST_IDS:
    print('[warn] No spaces or lists configured — skipping task scan. Set CLICKUP_SPACE_IDS or CLICKUP_LIST_IDS.', file=sys.stderr)

for lst in lists:
    try:
        tasks = get(
            f'{BASE_V2}/list/{lst["id"]}/task',
            params={'order_by': 'updated', 'reverse': 'true', 'limit': '20'}
        ).get('tasks', [])

        for task in tasks:
            updated = int(task.get('date_updated', 0))
            if updated < since_ms:
                continue  # Skip tasks not recently updated

            task_id = task['id']
            task_name = task.get('name', task_id)

            # Comments
            comments = get(f'{BASE_V2}/task/{task_id}/comment').get('comments', [])
            for comment in comments:
                cid = str(comment.get('id', ''))
                uid = str(comment.get('user', {}).get('id', ''))
                date = int(comment.get('date', 0))

                if cid in responded_ids:
                    continue
                if MY_USER_ID and uid == MY_USER_ID:
                    continue
                if date < since_ms:
                    continue

                findings.append({
                    'type': 'task_comment',
                    'task_id': task_id,
                    'task_name': task_name,
                    'comment_id': cid,
                    'from': comment.get('user', {}).get('username', uid or '?'),
                    'text': comment.get('comment_text', '')[:300],
                    'date': date,
                })
                new_ids.add(cid)

            # Attachments
            for attachment in task.get('attachments', []):
                aid = str(attachment.get('id', ''))
                a_date = int(attachment.get('date', 0))
                if aid in responded_ids:
                    continue
                if a_date < since_ms:
                    continue
                findings.append({
                    'type': 'attachment',
                    'task_id': task_id,
                    'task_name': task_name,
                    'attachment_id': aid,
                    'from': attachment.get('user', {}).get('username', '?'),
                    'filename': attachment.get('title', '?'),
                    'url': attachment.get('url', ''),
                    'date': a_date,
                })
                new_ids.add(aid)

    except Exception as e:
        print(f'[warn] Error scanning list {lst.get("id")}: {e}', file=sys.stderr)


# === 2. Check ClickUp Chat channels ===

for ch_id in CHANNEL_IDS:
    try:
        msgs = get(
            f'{BASE_V3}/workspaces/{TEAM_ID}/chat/channels/{ch_id}/messages',
            params={'limit': '10'}
        ).get('data', [])

        for msg in msgs:
            mid = str(msg.get('id', ''))
            date = int(msg.get('date', 0))
            uid = str(msg.get('user_id', ''))
            content = msg.get('content', '')

            if mid in responded_ids:
                continue
            if MY_USER_ID and uid == MY_USER_ID:
                continue
            if date < since_ms:
                continue

            # Include if the message mentions our user ID or matches any mention marker
            mentions_me = MY_USER_ID and (
                MY_USER_ID in content or
                f'#user_mention#{MY_USER_ID}' in content
            )

            if mentions_me:
                findings.append({
                    'type': 'chat_mention',
                    'channel_id': ch_id,
                    'message_id': mid,
                    'from': uid,
                    'text': content[:300],
                    'date': date,
                })
                new_ids.add(mid)

    except Exception as e:
        print(f'[warn] Error scanning channel {ch_id}: {e}', file=sys.stderr)


# === Persist deduplication state ===

save_state(responded_ids | new_ids)


# === Output ===

if findings:
    print(json.dumps(findings, indent=2))
else:
    print('CLEAN')
