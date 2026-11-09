const checks = ['http://127.0.0.1:3210/health', 'http://127.0.0.1:30141/api/t1/workbench/capabilities'];
try {
  for (const url of checks) {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const value = await response.json();
    if (!response.ok || !(value.status === 'ok' || value.schema_version === 't1-workbench-capabilities-1')) throw new Error('unhealthy');
  }
} catch { process.exitCode = 1; }
