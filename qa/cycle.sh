#!/usr/bin/env bash
# The 5-clean-cycles bar: one cycle = the whole gate (npm run qa) + every
# standing probe + a dist build. Any red run resets the count to zero and
# stops here — fix it, add the regression test, start again.
set -uo pipefail
cd "$(dirname "$0")"
export PW_CHROMIUM="${PW_CHROMIUM:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}"
N="${1:-5}"
clean=0
for i in $(seq 1 "$N"); do
  echo "══════════ cycle $i / $N ══════════"
  if npm run --silent qa && npm run --silent probes && node ../tools/dist.mjs; then
    clean=$((clean + 1)); echo "cycle $i clean ($clean consecutive)"
  else
    echo "cycle $i RED — clean count reset to zero"; exit 1
  fi
done
echo "$clean consecutive clean cycles"
