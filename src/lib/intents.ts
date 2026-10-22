// Search-intent pages: one page per broad search ("PDF converter", "reduce
// PDF size") that brings together the tools that answer it, each with its
// own name, introduction and link. Nothing here is written for the page
// except its title; the rest is the tools' own content, so no page repeats
// another. Served at /{lang}/{slug}, with slugs localized in
// src/lib/i18n/slugs.ts.
import type { Locale } from "./i18n/locales";
import type { ToolId } from "./tools";

export type Intent = { id: string; slug: string; tools: ToolId[]; title: Record<Locale, string> };

export const INTENTS: Intent[] = [
  {
    id: "converter",
    slug: "pdf-converter",
    tools: ["wordToPdf", "excelToPdf", "pptToPdf", "jpgToPdf", "htmlToPdf", "pdfToWord", "pdfToExcel", "pdfToPpt", "pdfToJpg", "pdfToPdfa", "pdfToMarkdown"],
    title: {
      en: "Free PDF converter", es: "Convertidor de PDF gratis", fr: "Convertisseur PDF gratuit", de: "Kostenloser PDF-Konverter",
      it: "Convertitore PDF gratuito", pt: "Conversor de PDF grátis", ja: "無料のPDF変換ツール", ru: "Бесплатный конвертер PDF",
      ko: "무료 PDF 변환기", "zh-cn": "免费 PDF 转换器", "zh-tw": "免費 PDF 轉換器", ar: "محوّل PDF مجاني",
      bg: "Безплатен PDF конвертор", ca: "Convertidor de PDF gratuït", nl: "Gratis pdf-converter", el: "Δωρεάν μετατροπέας PDF",
      hi: "मुफ़्त PDF कन्वर्टर", id: "Konverter PDF gratis", ms: "Penukar PDF percuma", pl: "Darmowy konwerter PDF",
      sv: "Gratis PDF-konverterare", th: "โปรแกรมแปลงไฟล์ PDF ฟรี", tr: "Ücretsiz PDF dönüştürücü", uk: "Безкоштовний конвертер PDF",
      vi: "Công cụ chuyển đổi PDF miễn phí", sw: "Kigeuzi cha PDF bila malipo",
      bn: "বিনামূল্যে PDF কনভার্টার", ta: "இலவச PDF மாற்றி", te: "ఉచిత PDF కన్వర్టర్", mr: "मोफत PDF कन्व्हर्टर", ur: "مفت PDF کنورٹر", fa: "مبدل رایگان PDF",
    },
  },
  {
    id: "reduceSize",
    slug: "reduce-pdf-size",
    tools: ["compress", "split", "remove", "extract"],
    title: {
      en: "Reduce PDF file size", es: "Reducir el tamaño de un PDF", fr: "Réduire la taille d’un PDF", de: "PDF verkleinern",
      it: "Ridurre le dimensioni di un PDF", pt: "Reduzir o tamanho de um PDF", ja: "PDFのファイルサイズを小さくする", ru: "Уменьшить размер PDF",
      ko: "PDF 파일 크기 줄이기", "zh-cn": "减小 PDF 文件大小", "zh-tw": "縮小 PDF 檔案大小", ar: "تقليل حجم ملف PDF",
      bg: "Намаляване на размера на PDF", ca: "Reduir la mida d’un PDF", nl: "Pdf verkleinen", el: "Μείωση μεγέθους PDF",
      hi: "PDF का साइज़ कम करें", id: "Perkecil ukuran PDF", ms: "Kecilkan saiz PDF", pl: "Zmniejsz rozmiar PDF",
      sv: "Minska storleken på en PDF", th: "ลดขนาดไฟล์ PDF", tr: "PDF boyutunu küçült", uk: "Зменшити розмір PDF",
      vi: "Giảm dung lượng PDF", sw: "Fanya PDF iwe ndogo",
      bn: "PDF-এর আকার কমান", ta: "PDF அளவைக் குறைக்கவும்", te: "PDF పరిమాణాన్ని తగ్గించండి", mr: "PDF चा आकार कमी करा", ur: "PDF کا سائز کم کریں", fa: "کاهش حجم PDF",
    },
  },
  {
    id: "editor",
    slug: "pdf-editor",
    tools: ["edit", "forms", "sign", "watermark", "pageNumbers", "crop", "rotate"],
    title: {
      en: "Free online PDF editor", es: "Editor de PDF online gratis", fr: "Éditeur PDF en ligne gratuit", de: "Kostenloser Online-PDF-Editor",
      it: "Editor PDF online gratuito", pt: "Editor de PDF online grátis", ja: "無料のオンラインPDF編集ツール", ru: "Бесплатный онлайн-редактор PDF",
      ko: "무료 온라인 PDF 편집기", "zh-cn": "免费在线 PDF 编辑器", "zh-tw": "免費線上 PDF 編輯器", ar: "محرر PDF مجاني على الإنترنت",
      bg: "Безплатен онлайн PDF редактор", ca: "Editor de PDF en línia gratuït", nl: "Gratis online pdf-editor", el: "Δωρεάν online επεξεργαστής PDF",
      hi: "मुफ़्त ऑनलाइन PDF एडिटर", id: "Editor PDF online gratis", ms: "Editor PDF dalam talian percuma", pl: "Darmowy edytor PDF online",
      sv: "Gratis PDF-redigerare online", th: "โปรแกรมแก้ไข PDF ออนไลน์ฟรี", tr: "Ücretsiz çevrimiçi PDF editörü", uk: "Безкоштовний онлайн-редактор PDF",
      vi: "Trình chỉnh sửa PDF trực tuyến miễn phí", sw: "Mhariri wa PDF mtandaoni bila malipo",
      bn: "বিনামূল্যে অনলাইন PDF এডিটর", ta: "இலவச ஆன்லைன் PDF எடிட்டர்", te: "ఉచిత ఆన్‌లైన్ PDF ఎడిటర్", mr: "मोफत ऑनलाइन PDF एडिटर", ur: "مفت آن لائن PDF ایڈیٹر", fa: "ویرایشگر آنلاین رایگان PDF",
    },
  },
  {
    id: "security",
    slug: "pdf-security",
    tools: ["protect", "unlock", "redact", "sign", "compare"],
    title: {
      en: "PDF security tools", es: "Herramientas de seguridad para PDF", fr: "Outils de sécurité PDF", de: "PDF-Sicherheitswerkzeuge",
      it: "Strumenti di sicurezza PDF", pt: "Ferramentas de segurança para PDF", ja: "PDFセキュリティツール", ru: "Инструменты защиты PDF",
      ko: "PDF 보안 도구", "zh-cn": "PDF 安全工具", "zh-tw": "PDF 安全工具", ar: "أدوات أمان PDF",
      bg: "Инструменти за сигурност на PDF", ca: "Eines de seguretat per a PDF", nl: "Pdf-beveiligingstools", el: "Εργαλεία ασφάλειας PDF",
      hi: "PDF सुरक्षा टूल", id: "Alat keamanan PDF", ms: "Alat keselamatan PDF", pl: "Narzędzia bezpieczeństwa PDF",
      sv: "Säkerhetsverktyg för PDF", th: "เครื่องมือความปลอดภัย PDF", tr: "PDF güvenlik araçları", uk: "Інструменти захисту PDF",
      vi: "Công cụ bảo mật PDF", sw: "Zana za usalama wa PDF",
      bn: "PDF নিরাপত্তা টুল", ta: "PDF பாதுகாப்புக் கருவிகள்", te: "PDF భద్రతా సాధనాలు", mr: "PDF सुरक्षा टूल", ur: "PDF سیکیورٹی ٹولز", fa: "ابزارهای امنیت PDF",
    },
  },
];

export const intentBySlug = (slug: string) => INTENTS.find((i) => i.slug === slug);
