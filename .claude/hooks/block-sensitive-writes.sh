#!/usr/bin/env bash
# PreToolUse hook — blocks writes/edits to secret-bearing or protected files.
#
# CS_GE holds two clouds' admin credentials for multiple customers, so the #1
# safety rule is "never touch a secret file". This hook is a backstop to the
# .gitignore + settings.json deny-list: it denies the tool call outright.
#
# Wire it in settings.json:
#   "hooks": { "PreToolUse": [ { "matcher": "Write|Edit|MultiEdit",
#     "hooks": [ { "type": "command",
#       "command": "bash .claude/hooks/block-sensitive-writes.sh" } ] } ] }
#
# Claude Code passes the tool payload as JSON on stdin. Exit non-zero to BLOCK.
set -euo pipefail

payload="$(cat)"

# Extract the target path from the tool input (file_path or path).
target="$(printf '%s' "$payload" | grep -oE '"(file_path|path)"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]+)"/\1/')"

if [ -z "${target:-}" ]; then
  exit 0   # nothing to check
fi

base="$(basename "$target")"

# Deny-list: credentials, env files, SA keys, secrets dirs.
case "$target" in
  *service_account.json|*sa-key*.json|*service-account*.json|*/secrets/*|*/.env|*.env|*.env.local)
    echo "BLOCKED: '$target' is a protected secret file. Credentials come from the environment / Secret Manager and are never edited via Claude. See .claude/rules/security-rules.md." >&2
    exit 1
    ;;
esac

# Extra guard on the exact filenames regardless of directory.
case "$base" in
  service_account.json|.env)
    echo "BLOCKED: '$base' is a protected secret file — refusing to write. See .claude/rules/security-rules.md." >&2
    exit 1
    ;;
esac

exit 0