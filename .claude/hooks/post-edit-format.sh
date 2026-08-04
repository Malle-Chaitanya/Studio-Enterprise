#!/usr/bin/env bash
# PostToolUse hook — light formatting/consistency nudges after an edit.
#
# CS_GE has no Prettier in the toolchain (tsc is the only gate), so this hook is
# deliberately minimal: it does NOT rewrite files (no formatter is installed).
# Instead it warns about the two mistakes that actually bite this codebase:
#   1. A server-side relative import missing the ESM `.js` extension.
#   2. A stray `console.log` in app code (use the Pino `logger`).
#
# Wire it in settings.json under PostToolUse (matcher "Write|Edit|MultiEdit").
# Non-blocking: exits 0 always; it only prints guidance.
set -uo pipefail

payload="$(cat 2>/dev/null || true)"
target="$(printf '%s' "$payload" | grep -oE '"(file_path|path)"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]+)"/\1/')"

case "${target:-}" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac
[ -f "$target" ] || exit 0

base="$(basename "$target")"
case "$base" in
  _diag_*|_test_*|_demo_*|_poc_*|_probe_*|_spike_*|_dump_*|_prep_*|_register_*|_del_*) exit 0 ;;
esac

# 1. Server relative imports must end in .js (ESM). Flag ./ or ../ imports without it.
if printf '%s' "$target" | grep -q "server/"; then
  if grep -nE "from[[:space:]]+['\"]\.\.?/[^'\"]*['\"]" "$target" | grep -vE "\.(js|json)['\"]" >/dev/null 2>&1; then
    echo "post-edit-format: ⚠ $base has a relative import missing the '.js' extension (server uses ESM specifiers). See .claude/rules/code-style.md." >&2
  fi
fi

# 2. console.log in app code (config.ts's console.error is the allowed exception).
if [ "$base" != "config.ts" ] && grep -nE "console\.(log|debug|info)\(" "$target" >/dev/null 2>&1; then
  echo "post-edit-format: ⚠ $base uses console.* — app code should use the Pino 'logger' (server/src/logger.ts). See .claude/rules/code-style.md." >&2
fi

exit 0