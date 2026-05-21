#!/bin/bash
# darkride-entrypoint.sh
#
# Wraps budtmo/docker-android's start logic. We background the original
# entrypoint, wait for adbd to bind on port 5555 (the signal the emulator
# is fully booted), then foreground the parent so `docker start` blocks
# until the container exits.

set -euo pipefail

# budtmo's image runs its emulator launch via /home/androidusr/docker-android/...
# Background it so we can probe for adbd readiness.
/home/androidusr/docker-android/mixins/scripts/run.sh &
BUDTMO_PID=$!

# Wait until adbd binds on 5555. Up to 120s (the emulator can take a while
# to cold boot under emulated CPU). If it never binds, exit with the
# parent's exit code so docker shows the failure.
echo "[darkride] waiting for adbd on 5555..."
for i in {1..60}; do
  if (echo > /dev/tcp/127.0.0.1/5555) >/dev/null 2>&1; then
    echo "[darkride] adbd ready"
    break
  fi
  if [ "$i" = "60" ]; then
    echo "[darkride] adbd did not bind within 120s — exiting"
    kill -TERM $BUDTMO_PID 2>/dev/null || true
    wait $BUDTMO_PID
    exit 1
  fi
  sleep 2
done

# Keep the container alive as long as the budtmo process runs. When
# `docker stop` sends SIGTERM, this `wait` returns with the child's exit
# code and the container shuts down cleanly.
wait $BUDTMO_PID
