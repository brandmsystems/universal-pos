#!/bin/sh
# Free Render instances sleep after 15 minutes without inbound traffic, and
# each service sleeps on its own: a visitor wakes the web, but the API stays
# asleep until a request reaches it -- and a proxied request to a sleeping API
# gets an immediate 502, which the sign-in screen reports as "not accepted".
#
# So while the web is up, it keeps the API up: one request at start, then one
# every five minutes. When the web sleeps this process stops with it and the
# API follows, so the pair still sleeps together. Opt-in: only the free
# Blueprint sets WAKE_API; elsewhere nothing sleeps.
[ "${WAKE_API:-}" = "1" ] || exit 0

url="${API_SCHEME}://${API_UPSTREAM}/healthz"
echo "wake-api: keeping $url awake"
(
  while true; do
    wget -q -T 90 -O /dev/null "$url" || echo "wake-api: $url did not answer"
    sleep 300
  done
) &
