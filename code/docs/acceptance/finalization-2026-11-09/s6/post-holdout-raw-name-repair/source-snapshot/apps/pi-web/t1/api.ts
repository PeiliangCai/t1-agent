export class WorkbenchError extends Error {
  constructor(public status: number, public code: string, public currentVersion?: number) { super(code); }
}
export async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api/t1/${path}`, { ...init, cache: "no-store" });
  if (!response.ok) {
    const value = await response.json().catch(() => ({})) as { error?: string; message?: string; current_version?: number };
    throw new WorkbenchError(response.status, value.message ?? value.error ?? "request_failed", value.current_version);
  }
  return response;
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await request(path, init)).json();
}
export const jsonBody = (method: string, value: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
