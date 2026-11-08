#!/usr/bin/env python3
"""Create a private config template only when it does not already exist."""
from pathlib import Path
import json
import os

root = Path(__file__).resolve().parents[1]
try:
    descriptor = os.open(root / '.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    print(json.dumps({'created': False, 'existing_configuration_untouched': True}))
else:
    with os.fdopen(descriptor, 'w') as output:
        output.write(root.joinpath('.env.example').read_text())
    print(json.dumps({'created': True, 'mode': '0o600'}))
