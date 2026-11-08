/** Standalone Chinese entry: adapt only the original ImagePreview hook, without changing pi-web preferences. */
export function useI18n() {
  return { t: (key: string) => ({ "chat.previewImage": "查看原整图", "chat.close": "关闭图片" })[key] ?? key };
}
