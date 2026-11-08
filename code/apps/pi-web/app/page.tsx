import { I18nProvider } from "@/hooks/useI18n";
import { T1Workbench } from "@/t1/T1Workbench";
import "./globals.css";
import "./sidebar.css";
import "./sidebar-menu.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "@/t1/workbench.css";

export default function Home() {
  return <I18nProvider><T1Workbench /></I18nProvider>;
}
