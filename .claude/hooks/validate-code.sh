#!/usr/bin/env bash
# PostToolUse / manual hook — typechecks the package a just-edited file belongs to.
#
# CS_GE has no ESLint/Prettier gate; `tsc --noEmit` is THE gate. This hook runs
# the right package's typecheck after a TS/TSX edit so type breakage surfaces
# immediately instead of at commit time.
#
# Wire it in settings.json:
#   "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit",
#     "hooks": [ { "type": "command",
#       "command": "bash .claude/hooks/validate-code.sh" } ] } ] }
#
# Non-blocking by design: it reports type errors but exits 0 so it never wedges
# an editing session. Skips throwaway diagnostic spikes.
set -uo pipefail

payload="$(cat 2>/dev/null || true)"
target="$(printf '%s' "$payload" | grep -oE '"(file_path|path)"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]+)"/\1/')"

# Only care about TypeScript sources.
case "${target:-}" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Skip diagnostic/test spikes — they intentionally break the app's strictness.
base="$(basename "$target")"
case "$base" in
  _diag_*|_test_*|_demo_*|_poc_*|_probe_*|_spike_*|_dump_*|_prep_*|_register_*|_del_*) exit 0 ;;
esac

# Route to the correct package.
if printf '%s' "$target" | grep -q "server/"; then
  pkg="server"
elif printf '%s' "$target" | grep -q "web/"; then
  pkg="web"
else
  exit 0
fi

if [ -f "$pkg/package.json" ]; then
  echo "validate-code: running typecheck in $pkg/ ..."
  ( cd "$pkg" && npm run --silent typecheck ) || \
    echo "validate-code: ⚠ typecheck reported errors in $pkg/ — fix before committing (see .claude/rules/code-style.md)." >&2
fi

exit 0