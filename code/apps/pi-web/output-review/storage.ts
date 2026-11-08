import { validateResults, type Results } from "./model";
import type { ReviewPack } from "./types";

export type StoragePort = Pick<Storage, "getItem" | "setItem">;
export type SavedState = { storage_schema: "output-review-browser-1"; revision: number; writer_id: string; saved_at: string; results: Results };
export class ProgressConflict extends Error {}

export function parseSaved(raw: string, pack: ReviewPack): SavedState {
  const value = JSON.parse(raw) as SavedState;
  if (!value || Object.keys(value).sort().join(",") !== "results,revision,saved_at,storage_schema,writer_id" || value.storage_schema !== "output-review-browser-1" || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.writer_id !== "string" || value.writer_id.length > 100 || typeof value.saved_at !== "string" || Number.isNaN(Date.parse(value.saved_at))) throw new Error("浏览器进度格式损坏");
  return { ...value, results: validateResults(value.results, pack) };
}

/** Compare before writing: a second tab's progress is never silently overwritten. */
export function saveUnchanged(storage: StoragePort, key: string, expectedRaw: string | null, next: SavedState): string {
  if (storage.getItem(key) !== expectedRaw) throw new ProgressConflict("检测到其他标签页或窗口的新进度");
  const raw = JSON.stringify(next);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new ProgressConflict("保存时检测到另一个标签页更新，请先导出本页备份");
  return raw;
}
