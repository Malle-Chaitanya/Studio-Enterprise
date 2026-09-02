#!/usr/bin/env bash
# Run the suite until it fails, keeping the FULL output of the failing run.
#
# The flake showed once in ~11 runs and the output was gone before it could be read, so the
# test could not even be named. This keeps the evidence instead of the count.
cd "$(dirname "$0")/../.." || exit 1
OUT="${TMPDIR:-/tmp}/flaky-hunt"
mkdir -p "$OUT"
for i in $(seq 1 "${RUNS:-60}"); do
  log="$OUT/run-$i.log"
  if ! npx vitest run --reporter=verbose > "$log" 2>&1; then
    echo "FAILED on run $i -> $log"
    sed -e 's/\x1b\[[0-9;]*m//g' "$log" | grep -E "×|FAIL|AssertionError|Error:|expected|actual" | head -30
    exit 1
  fi
  rm -f "$log"          # keep only the failure
  echo "run $i ok"
done
echo "no failure in ${RUNS:-60} runs"
