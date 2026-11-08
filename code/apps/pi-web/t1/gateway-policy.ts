/** Pure path allowlist, shared by the mandatory entry guard and T1-only gateway. */
const id = "[A-Za-z0-9_:.,-]{1,200}";
const pathPattern = new RegExp(`^/api/t1/(?:workbench/(?:capabilities|papers|runs|papers/${id}(?:/pdf|/figures/${id})?)|runs/${id}(?:/records|/events)?)$`);
export const isT1ApiPath = (path: string) => !path.split("/").some(part => part === "." || part === "..") && pathPattern.test(path);
export function t1BackendPath(parts: string[]): string | null {
  if (parts.some(part => !/^[A-Za-z0-9_:.,-]{1,200}$/.test(part) || part === "." || part === "..")) return null;
  const path = `/api/t1/${parts.join("/")}`;
  return isT1ApiPath(path) ? `/api/${parts.map(encodeURIComponent).join("/")}` : null;
}
