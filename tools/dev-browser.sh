#!/usr/bin/env bash
# Dev browser for iterating on this app.
#
# Chromium blocks a site from creating GPU contexts for a few seconds whenever it
# attributes context losses to it, and drops the oldest context once ~16 are open
# browser-wide. Reload-heavy work on a WebGL page trips both, and the app then
# boots into "the browser is refusing a WebGL context". Two switches take that
# out of the picture, and a throwaway profile keeps them away from daily browsing.
set -u

URL="${1:-http://localhost:8123/}"
PROFILE="${TRDELNIK_DEV_PROFILE:-/tmp/trdelnik-dev-profile}"

for candidate in google-chrome chromium brave-browser microsoft-edge; do
  if command -v "$candidate" >/dev/null 2>&1; then
    BROWSER="$candidate"
    break
  fi
done
if [ -z "${BROWSER:-}" ]; then
  echo "no Chromium-family browser found; Firefox does not do per-domain 3D blocking, so plain firefox $URL is fine" >&2
  exit 1
fi

echo "$BROWSER -> $URL (profile: $PROFILE)"
exec "$BROWSER" \
  --user-data-dir="$PROFILE" \
  --disable-domain-blocking-for-3d-apis \
  --disable-gpu-process-crash-limit \
  "$URL"
