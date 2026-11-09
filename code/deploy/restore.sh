#!/bin/sh
set -eu
# Restore only to a fresh, explicitly selected volume. Existing contents are rejected.
test "$#" -eq 1 || { echo 'usage: T1_DATA_VOLUME=NEW_VOLUME sh deploy/restore.sh BACKUP.tar.gz' >&2; exit 2; }
test -n "${T1_DATA_VOLUME:-}" || { echo 'T1_DATA_VOLUME must explicitly name a NEW volume' >&2; exit 2; }
test -f "$1" || exit 2
test -z "$(docker ps -q --filter "volume=$T1_DATA_VOLUME")" || { echo 'restore target is mounted by a running container' >&2; exit 2; }
docker compose run --rm --no-deps -T --entrypoint node app deploy/data-snapshot.mjs restore < "$1"
