#!/bin/sh
# Starts as root only to make the data folders writable, then runs the app as
# an unprivileged user. PUID/PGID choose that user (default 1000, the image's
# "node" user), e.g. to match the owner of the folders on the host.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  for dir in "${DATA_DIR:-/data}" "${CONSUME_DIR:-/consume}"; do
    [ -n "$dir" ] || continue
    mkdir -p "$dir"
    # Only walk the tree when ownership is wrong, so restarts stay fast.
    if [ "$(stat -c %u:%g "$dir")" != "$PUID:$PGID" ]; then
      chown -R "$PUID:$PGID" "$dir"
    fi
  done
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi

exec "$@"
