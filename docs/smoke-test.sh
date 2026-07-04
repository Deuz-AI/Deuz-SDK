#!/bin/bash
# Post-deploy smoke test for the docs site (deuz-sdk.tech).
# Usage: ./docs/smoke-test.sh [base_url]
set -uo pipefail

BASE_URL="${1:-https://deuz-sdk.tech}"
PATHS=(
  "/"
  "/docs"
  "/docs/installation"
  "/llms.txt"
  "/llms-full.txt"
  "/sitemap.xml"
  "/robots.txt"
)

fail=0
for path in "${PATHS[@]}"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "${BASE_URL}${path}")
  if [ "$code" = "200" ]; then
    echo "OK   $code  ${BASE_URL}${path}"
  else
    echo "FAIL $code  ${BASE_URL}${path}"
    fail=1
  fi
done

exit $fail
