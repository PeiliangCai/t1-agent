#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$project_root/.tools/node/bin:$PATH"
if [[ ! -x "$project_root/.tools/node/bin/node" ]]; then
  printf '%s\n' 'Run python3 scripts/install-node.py first.' >&2
  exit 1
fi
exec "$@"
