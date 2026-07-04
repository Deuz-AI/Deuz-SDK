#!/bin/bash
# Post-deploy smoke test for the docs site (deuz-sdk.tech).
# Usage: ./docs/smoke-test.sh [base_url] [www_host]
set -uo pipefail

BASE_URL="${1:-https://deuz-sdk.tech}"
WWW_URL="${2:-https://www.deuz-sdk.tech}"
PATHS=(
  "/"
  "/docs"
  "/docs/quickstart"
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

# www must redirect to the apex domain, not serve the app directly.
www_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$WWW_URL/")
www_location=$(curl -sS -o /dev/null -w '%{redirect_url}' --max-time 15 "$WWW_URL/")
if [ "$www_code" = "301" ] && [[ "$www_location" == "$BASE_URL"* ]]; then
  echo "OK   $www_code  $WWW_URL/ -> $www_location"
else
  echo "FAIL $www_code  $WWW_URL/ -> '$www_location' (expected 301 to $BASE_URL)"
  fail=1
fi

exit $fail
