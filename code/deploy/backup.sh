#!/bin/sh
set -eu
# Invoke from code/. Only the selected Compose project's app is stopped.
# T1_DATA_VOLUME must select its dedicated volume; never point two app instances at one volume.
test "$#" -eq 1 || { echo 'usage: sh deploy/backup.sh PRIVATE_OUTPUT.tar.gz' >&2; exit 2; }
test ! -e "$1" || { echo 'backup output already exists' >&2; exit 2; }
umask 077
docker compose stop app
trap 'docker compose start app >&2' EXIT HUP INT TERM
if docker compose run --rm --no-deps -T --entrypoint node app deploy/data-snapshot.mjs create > "$1.part"; then
  mv "$1.part" "$1"
  sha256sum "$1" > "$1.sha256"
else
  rm -f "$1.part"
  exit 1
fi
