#!/usr/bin/env bash
# ClickUp Skill — Install / Status Check
# Verifies that all dependencies for the ClickUp skill are present.

set -euo pipefail

CLICKUP_BIN="/usr/local/bin/clickup"
SECRET_NAME="CLICKUP_BURTONMETHOD_KEY"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ClickUp Skill — Dependency Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Check clickup CLI
echo ""
echo "[1/2] Checking for clickup CLI at ${CLICKUP_BIN}..."
if [ -x "$CLICKUP_BIN" ]; then
  VERSION=$("$CLICKUP_BIN" --version 2>/dev/null || echo "unknown")
  echo "  ✓  clickup CLI found  (version: ${VERSION})"
else
  echo "  ✗  clickup CLI NOT found at ${CLICKUP_BIN}"
  echo ""
  echo "     To install, build or place the binary at ${CLICKUP_BIN} and make it executable:"
  echo "       sudo chmod +x ${CLICKUP_BIN}"
  echo ""
  MISSING=1
fi

# 2. Check signet secret
echo ""
echo "[2/2] Checking signet secret '${SECRET_NAME}'..."
if command -v signet &>/dev/null; then
  if signet secret get "$SECRET_NAME" &>/dev/null; then
    echo "  ✓  Secret '${SECRET_NAME}' found in signet"
  else
    echo "  ✗  Secret '${SECRET_NAME}' NOT found in signet"
    echo ""
    echo "     To add it:"
    echo "       signet secret put ${SECRET_NAME}"
    echo "     Then paste your ClickUp API token when prompted."
    echo ""
    MISSING=1
  fi
else
  echo "  ✗  'signet' command not found — cannot verify secret"
  echo ""
  echo "     Make sure signet is installed and on your PATH."
  MISSING=1
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "${MISSING:-0}" = "1" ]; then
  echo " Status: INCOMPLETE — fix the issues above, then re-run."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 1
else
  echo " Status: READY — ClickUp skill is fully configured."
  echo ""
  echo " Quick test:"
  echo "   signet secret exec --secret ${SECRET_NAME} -- \\"
  echo "     bash -c 'CLICKUP_API_KEY=\$${SECRET_NAME} clickup spaces'"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 0
fi
