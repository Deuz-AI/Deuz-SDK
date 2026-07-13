#!/bin/bash
# Guards against README.md and the docs Introduction page drifting apart on
# the test count / file count ("Quality bar"). Run before every release.
# Usage: ./docs/check-consistency.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
README="$ROOT/README.md"
INTRO="$ROOT/docs/content/docs/index.mdx"

# Matches "575 tests" whether or not it's wrapped in markdown bold.
readme_tests=$(grep -oE '[0-9]+ tests\b' "$README" | head -1 | grep -oE '^[0-9]+')
intro_tests=$(grep -oE '[0-9]+ tests\b' "$INTRO" | head -1 | grep -oE '^[0-9]+')

fail=0

if [ -z "$readme_tests" ] || [ -z "$intro_tests" ]; then
  echo "FAIL  could not find an 'N tests' mention in README.md and/or docs/content/docs/index.mdx"
  fail=1
elif [ "$readme_tests" != "$intro_tests" ]; then
  echo "FAIL  test count mismatch: README.md says $readme_tests, docs/content/docs/index.mdx says $intro_tests"
  fail=1
else
  echo "OK    README.md and docs/content/docs/index.mdx both say $readme_tests tests"
fi

actual_tests=$(cd "$ROOT" && npx vitest run 2>&1 | grep -oE 'Tests\s+[0-9]+ passed' | grep -oE '[0-9]+')
if [ -n "$actual_tests" ] && [ -n "$readme_tests" ] && [ "$actual_tests" != "$readme_tests" ]; then
  echo "FAIL  actual vitest run reports $actual_tests passed tests, but docs say $readme_tests"
  fail=1
elif [ -n "$actual_tests" ]; then
  echo "OK    actual vitest run matches docs ($actual_tests tests)"
fi

exit $fail
