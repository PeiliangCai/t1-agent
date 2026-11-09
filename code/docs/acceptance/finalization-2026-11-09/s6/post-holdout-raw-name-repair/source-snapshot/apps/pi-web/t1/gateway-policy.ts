/** Pure path allowlist, shared by the mandatory entry guard and T1-only gateway. */
const id = "[A-Za-z0-9_:.,-]{1,200}";
const pathPattern = new RegExp(`^/api/t1/(?:workbench/(?:capabilities|catalog|papers|runs|papers/${id}(?:/pdf|/figures/${id}|/runs)?|runs/${id}(?:/events|/cancel|/figures/${id}(?:/verify)?|/records(?:/${id}(?:/review)?)?|/exports/(?:candidate_jsonl|candidate_csv|approved_jsonl|approved_csv|candidate_package|approved_package))?)|runs/${id}(?:/records|/events)?)$`);
// encodeURIComponent encodes only these two characters from our allowed ID alphabet.
// Decode neither slashes, dots, percent signs nor fixed route names; remaining '%' fails the allowlist.
const normalizeIdEncoding = (path: string) => path.replace(/%3a/gi, ":").replace(/%2c/gi, ",");
export const isT1ApiPath = (path: string) => {
  const normalized = normalizeIdEncoding(path);
  return !normalized.split("/").some(part => part === "." || part === "..") && pathPattern.test(normalized);
};
/** Methods are explicit as well as paths: this is never a general upstream proxy. */
export function isT1ApiMethod(path: string, method: string): boolean {
  path = normalizeIdEncoding(path);
  if (!isT1ApiPath(path)) return false;
  if (method === "GET" || method === "HEAD") return !/\/(?:cancel|review|verify)$/.test(path);
  if (method === "PUT") return new RegExp(`^/api/t1/workbench/papers/${id}/pdf$`).test(path);
  if (method === "DELETE" && new RegExp(`^/api/t1/workbench/papers/${id}$`).test(path)) return true;
  if (method === "POST") return new RegExp(`^/api/t1/workbench/(?:papers(?:/${id}/runs)?|runs/${id}/(?:cancel|figures/${id}/verify|records(?:/${id}/review)?))$`).test(path);
  return (method === "PATCH" || method === "DELETE") && new RegExp(`^/api/t1/workbench/runs/${id}/records/${id}$`).test(path);
}
export function t1BackendPath(parts: string[]): string | null {
  if (parts.some(part => !/^[A-Za-z0-9_:.,-]{1,200}$/.test(part) || part === "." || part === "..")) return null;
  const path = `/api/t1/${parts.join("/")}`;
  return isT1ApiPath(path) ? `/api/${parts.map(encodeURIComponent).join("/")}` : null;
}
