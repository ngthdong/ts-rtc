#!/usr/bin/env bash
# End-to-end TURN check with turnutils_uclient (coturn package, or the coturn image via Docker).
# For the real test run it from ANOTHER network than the server:
#   TURN_SECRET=... scripts/turn-check.sh <turn-host> [port]
set -euo pipefail
host=${1:?usage: TURN_SECRET=... scripts/turn-check.sh <turn-host> [port]}
port=${2:-3478}
: "${TURN_SECRET:?set TURN_SECRET (the coturn static-auth-secret)}"

uclient() {
  if command -v turnutils_uclient >/dev/null; then
    turnutils_uclient "$@"
  else
    docker run --rm --network host coturn/coturn:4.7.0 turnutils_uclient "$@"
  fi
}

# Same scheme as apps/server/src/turn/credentials.ts. $1 = seconds until expiry.
credentials() {
  local user="$(($(date +%s) + $1)):turn-check-$$"
  printf '%s %s' "$user" "$(printf '%s' "$user" | openssl dgst -sha1 -hmac "$TURN_SECRET" -binary | base64)"
}

failed=0
check() { # check <label> <pattern the output must contain> <uclient args...>
  local label=$1 pattern=$2 output
  shift 2
  output=$(uclient -n 3 -m 1 -p "$port" "$@" "$host" 2>&1 || true)
  if grep -q "$pattern" <<<"$output"; then
    echo "PASS  $label"
  else
    echo "FAIL  $label (no \"$pattern\" in turnutils_uclient output)"
    failed=1
  fi
}

ok='Total lost packets 0'
read -r user pass <<<"$(credentials 600)"
check 'UDP relay with fresh credentials' "$ok" -y -u "$user" -w "$pass"
check 'TCP relay with fresh credentials' "$ok" -t -y -u "$user" -w "$pass"
# -e takes its value attached: with a space, uclient ignores the address and exits early.
check 'relaying into 10.0.0.0/8 is refused' 'error 403' -u "$user" -w "$pass" -e10.0.0.1 -r 3480
read -r user pass <<<"$(credentials -60)"
check 'expired credentials are refused' 'Cannot complete Allocation' -y -u "$user" -w "$pass"
exit "$failed"