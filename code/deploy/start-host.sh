#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test -f .env || { echo 'Create private code/.env from .env.example and fill the key.' >&2; exit 2; }
test -f deploy/local/workbench.env || { echo 'Create deploy/local/workbench.env from deploy/host.env.example.' >&2; exit 2; }
exec .tools/node/bin/node --env-file=.env --env-file=deploy/local/workbench.env --import tsx apps/server/src/main.ts
