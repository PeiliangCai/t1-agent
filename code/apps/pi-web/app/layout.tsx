import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "T1 · 论文原文工作台", description: "基于 Pi Web 的 T1 论文原文与 Figure 工作台",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Each page owns its CSS. Annotation never loads the Pi Web theme or PWA.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN" translate="no" suppressHydrationWarning><body suppressHydrationWarning>{children}</body></html>;
}
