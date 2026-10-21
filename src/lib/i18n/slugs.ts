// Page addresses in each language's own words: /de/pdf-komprimieren,
// /es/comprimir-pdf. Pages are known by their English slug (the one in
// src/lib/tools.ts or src/lib/intents.ts); this file gives each language's
// slug for it. Written from each language's tool names, in ASCII with the
// accents dropped, as sites in these languages usually write their addresses.
// Russian, Ukrainian, Bulgarian and Greek are transliterated. Japanese,
// Korean, Chinese, Arabic, Hindi and Thai keep the English slugs: sites in
// those languages mostly use Latin ones, and native script only shows up as
// %-escapes when a link is copied.
//
// A slug that isn't listed stays English. The English slugs of tools used to
// be every language's address; scripts/static-extras.mjs redirects them to
// the localized ones, and the server build's proxy does the same.
import { hasLocale, type Locale } from "./locales";

type Slugs = Record<string, string>;

// Shared by languages that build "X to PDF" the same way.
const convert = (to: string): Slugs => ({
  "jpg-to-pdf": `jpg-${to}-pdf`,
  "word-to-pdf": `word-${to}-pdf`,
  "powerpoint-to-pdf": `powerpoint-${to}-pdf`,
  "excel-to-pdf": `excel-${to}-pdf`,
  "html-to-pdf": `html-${to}-pdf`,
  "pdf-to-jpg": `pdf-${to}-jpg`,
  "pdf-to-word": `pdf-${to}-word`,
  "pdf-to-powerpoint": `pdf-${to}-powerpoint`,
  "pdf-to-excel": `pdf-${to}-excel`,
  "pdf-to-pdfa": `pdf-${to}-pdfa`,
  "pdf-to-markdown": `pdf-${to}-markdown`,
});

export const SLUGS: Partial<Record<Locale, Slugs>> = {
  es: {
    "merge-pdf": "unir-pdf", "split-pdf": "dividir-pdf", "extract-pages": "extraer-paginas-pdf", "remove-pages": "eliminar-paginas-pdf",
    "organize-pdf": "organizar-pdf", "scan-to-pdf": "escanear-a-pdf", "compress-pdf": "comprimir-pdf", "repair-pdf": "reparar-pdf",
    ...convert("a"),
    "rotate-pdf": "girar-pdf", "add-page-numbers": "numerar-paginas-pdf", "add-watermark": "marca-de-agua-pdf", "crop-pdf": "recortar-pdf",
    "edit-pdf": "editar-pdf", "pdf-forms": "formularios-pdf", "unlock-pdf": "desbloquear-pdf", "protect-pdf": "proteger-pdf",
    "sign-pdf": "firmar-pdf", "redact-pdf": "censurar-pdf", "compare-pdf": "comparar-pdf",
    "pdf-converter": "convertidor-pdf", "reduce-pdf-size": "reducir-tamano-pdf", "pdf-editor": "editor-pdf", "pdf-security": "seguridad-pdf",
  },
  fr: {
    "merge-pdf": "fusionner-pdf", "split-pdf": "diviser-pdf", "extract-pages": "extraire-pages-pdf", "remove-pages": "supprimer-pages-pdf",
    "organize-pdf": "organiser-pdf", "scan-to-pdf": "numeriser-en-pdf", "compress-pdf": "compresser-pdf", "repair-pdf": "reparer-pdf",
    ...convert("en"),
    "rotate-pdf": "pivoter-pdf", "add-page-numbers": "numeroter-pages-pdf", "add-watermark": "filigrane-pdf", "crop-pdf": "rogner-pdf",
    "edit-pdf": "modifier-pdf", "pdf-forms": "formulaires-pdf", "unlock-pdf": "deverrouiller-pdf", "protect-pdf": "proteger-pdf",
    "sign-pdf": "signer-pdf", "redact-pdf": "caviarder-pdf", "compare-pdf": "comparer-pdf",
    "pdf-converter": "convertisseur-pdf", "reduce-pdf-size": "reduire-taille-pdf", "pdf-editor": "editeur-pdf", "pdf-security": "securite-pdf",
  },
  de: {
    "merge-pdf": "pdf-zusammenfuegen", "split-pdf": "pdf-teilen", "extract-pages": "pdf-seiten-extrahieren", "remove-pages": "pdf-seiten-entfernen",
    "organize-pdf": "pdf-organisieren", "scan-to-pdf": "in-pdf-scannen", "compress-pdf": "pdf-komprimieren", "repair-pdf": "pdf-reparieren",
    "ocr-pdf": "pdf-ocr", ...convert("in"),
    "rotate-pdf": "pdf-drehen", "add-page-numbers": "seitenzahlen-einfuegen", "add-watermark": "wasserzeichen-einfuegen", "crop-pdf": "pdf-zuschneiden",
    "edit-pdf": "pdf-bearbeiten", "pdf-forms": "pdf-formulare", "unlock-pdf": "pdf-entsperren", "protect-pdf": "pdf-schuetzen",
    "sign-pdf": "pdf-unterschreiben", "redact-pdf": "pdf-schwaerzen", "compare-pdf": "pdf-vergleichen",
    "pdf-converter": "pdf-konverter", "reduce-pdf-size": "pdf-verkleinern", "pdf-security": "pdf-sicherheit",
  },
  it: {
    "merge-pdf": "unire-pdf", "split-pdf": "dividere-pdf", "extract-pages": "estrarre-pagine-pdf", "remove-pages": "rimuovere-pagine-pdf",
    "organize-pdf": "organizzare-pdf", "scan-to-pdf": "scansionare-in-pdf", "compress-pdf": "comprimere-pdf", "repair-pdf": "riparare-pdf",
    ...convert("in"),
    "rotate-pdf": "ruotare-pdf", "add-page-numbers": "numerare-pagine-pdf", "add-watermark": "filigrana-pdf", "crop-pdf": "ritagliare-pdf",
    "edit-pdf": "modificare-pdf", "pdf-forms": "moduli-pdf", "unlock-pdf": "sbloccare-pdf", "protect-pdf": "proteggere-pdf",
    "sign-pdf": "firmare-pdf", "redact-pdf": "oscurare-pdf", "compare-pdf": "confrontare-pdf",
    "pdf-converter": "convertitore-pdf", "reduce-pdf-size": "ridurre-dimensione-pdf", "pdf-editor": "editor-pdf", "pdf-security": "sicurezza-pdf",
  },
  pt: {
    "merge-pdf": "juntar-pdf", "split-pdf": "dividir-pdf", "extract-pages": "extrair-paginas-pdf", "remove-pages": "remover-paginas-pdf",
    "organize-pdf": "organizar-pdf", "scan-to-pdf": "digitalizar-para-pdf", "compress-pdf": "comprimir-pdf", "repair-pdf": "reparar-pdf",
    ...convert("para"),
    "rotate-pdf": "girar-pdf", "add-page-numbers": "numerar-paginas-pdf", "add-watermark": "marca-dagua-pdf", "crop-pdf": "cortar-pdf",
    "edit-pdf": "editar-pdf", "pdf-forms": "formularios-pdf", "unlock-pdf": "desbloquear-pdf", "protect-pdf": "proteger-pdf",
    "sign-pdf": "assinar-pdf", "redact-pdf": "ocultar-dados-pdf", "compare-pdf": "comparar-pdf",
    "pdf-converter": "conversor-pdf", "reduce-pdf-size": "reduzir-tamanho-pdf", "pdf-editor": "editor-pdf", "pdf-security": "seguranca-pdf",
  },
  ru: {
    "merge-pdf": "obedinit-pdf", "split-pdf": "razdelit-pdf", "extract-pages": "izvlech-stranitsy-pdf", "remove-pages": "udalit-stranitsy-pdf",
    "organize-pdf": "uporyadochit-pdf", "scan-to-pdf": "skanirovat-v-pdf", "compress-pdf": "szhat-pdf", "repair-pdf": "vosstanovit-pdf",
    "ocr-pdf": "raspoznat-tekst-pdf", ...convert("v"),
    "rotate-pdf": "povernut-pdf", "add-page-numbers": "pronumerovat-stranitsy-pdf", "add-watermark": "vodyanoy-znak-pdf", "crop-pdf": "obrezat-pdf",
    "edit-pdf": "redaktirovat-pdf", "pdf-forms": "formy-pdf", "unlock-pdf": "razblokirovat-pdf", "protect-pdf": "zashchitit-pdf",
    "sign-pdf": "podpisat-pdf", "redact-pdf": "skryt-dannye-pdf", "compare-pdf": "sravnit-pdf",
    "pdf-converter": "konverter-pdf", "reduce-pdf-size": "umenshit-razmer-pdf", "pdf-editor": "redaktor-pdf", "pdf-security": "bezopasnost-pdf",
  },
  uk: {
    "merge-pdf": "obiednaty-pdf", "split-pdf": "rozdilyty-pdf", "extract-pages": "vytiahty-storinky-pdf", "remove-pages": "vydalyty-storinky-pdf",
    "organize-pdf": "uporiadkuvaty-pdf", "scan-to-pdf": "skanuvaty-v-pdf", "compress-pdf": "stysnuty-pdf", "repair-pdf": "vidnovyty-pdf",
    "ocr-pdf": "rozpiznaty-tekst-pdf", ...convert("v"),
    "rotate-pdf": "povernuty-pdf", "add-page-numbers": "dodaty-nomery-storinok", "add-watermark": "dodaty-vodianyi-znak", "crop-pdf": "obrizaty-pdf",
    "edit-pdf": "redahuvaty-pdf", "pdf-forms": "formy-pdf", "unlock-pdf": "rozblokuvaty-pdf", "protect-pdf": "zakhystyty-pdf",
    "sign-pdf": "pidpysaty-pdf", "redact-pdf": "prykhovaty-dani-pdf", "compare-pdf": "porivniaty-pdf",
    "pdf-converter": "konverter-pdf", "reduce-pdf-size": "zmenshyty-rozmir-pdf", "pdf-editor": "redaktor-pdf", "pdf-security": "bezpeka-pdf",
  },
  bg: {
    "merge-pdf": "obediniavane-na-pdf", "split-pdf": "razdeliane-na-pdf", "extract-pages": "izvlichane-na-stranitsi", "remove-pages": "premahvane-na-stranitsi",
    "organize-pdf": "podrezhdane-na-pdf", "scan-to-pdf": "skanirane-v-pdf", "compress-pdf": "kompresirane-na-pdf", "repair-pdf": "popravka-na-pdf",
    "ocr-pdf": "ocr-na-pdf", ...convert("v"),
    "rotate-pdf": "zavartane-na-pdf", "add-page-numbers": "nomerirane-na-stranitsi", "add-watermark": "voden-znak-pdf", "crop-pdf": "izriazvane-na-pdf",
    "edit-pdf": "redaktirane-na-pdf", "pdf-forms": "pdf-formuliari", "unlock-pdf": "otkliuchvane-na-pdf", "protect-pdf": "zashtita-na-pdf",
    "sign-pdf": "podpisvane-na-pdf", "redact-pdf": "zalichavane-v-pdf", "compare-pdf": "sravniavane-na-pdf",
    "pdf-converter": "pdf-konvertor", "reduce-pdf-size": "namaliavane-na-razmera-na-pdf", "pdf-editor": "pdf-redaktor", "pdf-security": "sigurnost-na-pdf",
  },
  el: {
    "merge-pdf": "sygchoneusi-pdf", "split-pdf": "diachorismos-pdf", "extract-pages": "exagogi-selidon-pdf", "remove-pages": "afairesi-selidon-pdf",
    "organize-pdf": "organosi-pdf", "scan-to-pdf": "sarosi-se-pdf", "compress-pdf": "sympiesi-pdf", "repair-pdf": "epidiorthosi-pdf",
    ...convert("se"),
    "rotate-pdf": "peristrofi-pdf", "add-page-numbers": "arithmisi-selidon-pdf", "add-watermark": "ydatografima-pdf", "crop-pdf": "perikopi-pdf",
    "edit-pdf": "epexergasia-pdf", "pdf-forms": "formes-pdf", "unlock-pdf": "xekleidoma-pdf", "protect-pdf": "prostasia-pdf",
    "sign-pdf": "ypografi-pdf", "redact-pdf": "apokrypsi-stoicheion-pdf", "compare-pdf": "sygkrisi-pdf",
    "pdf-converter": "metatropeas-pdf", "reduce-pdf-size": "meiosi-megethous-pdf", "pdf-editor": "epexergastis-pdf", "pdf-security": "asfaleia-pdf",
  },
  ca: {
    "merge-pdf": "unir-pdf", "split-pdf": "dividir-pdf", "extract-pages": "extreure-pagines-pdf", "remove-pages": "eliminar-pagines-pdf",
    "organize-pdf": "organitzar-pdf", "scan-to-pdf": "escanejar-a-pdf", "compress-pdf": "comprimir-pdf", "repair-pdf": "reparar-pdf",
    ...convert("a"),
    "rotate-pdf": "girar-pdf", "add-page-numbers": "numerar-pagines-pdf", "add-watermark": "marca-daigua-pdf", "crop-pdf": "retallar-pdf",
    "edit-pdf": "editar-pdf", "pdf-forms": "formularis-pdf", "unlock-pdf": "desbloquejar-pdf", "protect-pdf": "protegir-pdf",
    "sign-pdf": "signar-pdf", "redact-pdf": "censurar-pdf", "compare-pdf": "comparar-pdf",
    "pdf-converter": "convertidor-pdf", "reduce-pdf-size": "reduir-mida-pdf", "pdf-editor": "editor-pdf", "pdf-security": "seguretat-pdf",
  },
  nl: {
    "merge-pdf": "pdf-samenvoegen", "split-pdf": "pdf-splitsen", "extract-pages": "paginas-extraheren", "remove-pages": "paginas-verwijderen",
    "organize-pdf": "pdf-ordenen", "scan-to-pdf": "scannen-naar-pdf", "compress-pdf": "pdf-comprimeren", "repair-pdf": "pdf-herstellen",
    "ocr-pdf": "pdf-ocr", ...convert("naar"),
    "rotate-pdf": "pdf-draaien", "add-page-numbers": "paginanummers-toevoegen", "add-watermark": "watermerk-toevoegen", "crop-pdf": "pdf-bijsnijden",
    "edit-pdf": "pdf-bewerken", "pdf-forms": "pdf-formulieren", "unlock-pdf": "pdf-ontgrendelen", "protect-pdf": "pdf-beveiligen",
    "sign-pdf": "pdf-ondertekenen", "redact-pdf": "pdf-zwartlakken", "compare-pdf": "pdf-vergelijken",
    "reduce-pdf-size": "pdf-verkleinen", "pdf-security": "pdf-beveiliging",
  },
  id: {
    "merge-pdf": "gabungkan-pdf", "split-pdf": "pisahkan-pdf", "extract-pages": "ekstrak-halaman-pdf", "remove-pages": "hapus-halaman-pdf",
    "organize-pdf": "atur-pdf", "scan-to-pdf": "pindai-ke-pdf", "compress-pdf": "kompres-pdf", "repair-pdf": "perbaiki-pdf",
    ...convert("ke"),
    "rotate-pdf": "putar-pdf", "add-page-numbers": "tambah-nomor-halaman", "add-watermark": "tambah-watermark", "crop-pdf": "potong-pdf",
    "pdf-forms": "formulir-pdf", "unlock-pdf": "buka-kunci-pdf", "protect-pdf": "lindungi-pdf",
    "sign-pdf": "tanda-tangan-pdf", "redact-pdf": "sensor-pdf", "compare-pdf": "bandingkan-pdf",
    "pdf-converter": "konverter-pdf", "reduce-pdf-size": "perkecil-ukuran-pdf", "pdf-editor": "editor-pdf", "pdf-security": "keamanan-pdf",
  },
  ms: {
    "merge-pdf": "gabung-pdf", "split-pdf": "pisah-pdf", "extract-pages": "ekstrak-halaman-pdf", "remove-pages": "buang-halaman-pdf",
    "organize-pdf": "susun-pdf", "scan-to-pdf": "imbas-ke-pdf", "compress-pdf": "mampat-pdf", "repair-pdf": "baiki-pdf",
    ...convert("ke"),
    "rotate-pdf": "putar-pdf", "add-page-numbers": "tambah-nombor-halaman", "add-watermark": "tambah-tera-air", "crop-pdf": "pangkas-pdf",
    "pdf-forms": "borang-pdf", "unlock-pdf": "buka-kunci-pdf", "protect-pdf": "lindungi-pdf",
    "sign-pdf": "tandatangan-pdf", "redact-pdf": "sunting-keluar-pdf", "compare-pdf": "banding-pdf",
    "pdf-converter": "penukar-pdf", "reduce-pdf-size": "kecilkan-saiz-pdf", "pdf-editor": "editor-pdf", "pdf-security": "keselamatan-pdf",
  },
  pl: {
    "merge-pdf": "polacz-pdf", "split-pdf": "podziel-pdf", "extract-pages": "wyodrebnij-strony-pdf", "remove-pages": "usun-strony-pdf",
    "organize-pdf": "uporzadkuj-pdf", "scan-to-pdf": "skanuj-do-pdf", "compress-pdf": "kompresuj-pdf", "repair-pdf": "napraw-pdf",
    ...convert("do"),
    "rotate-pdf": "obroc-pdf", "add-page-numbers": "numeruj-strony-pdf", "add-watermark": "znak-wodny-pdf", "crop-pdf": "przytnij-pdf",
    "edit-pdf": "edytuj-pdf", "pdf-forms": "formularze-pdf", "unlock-pdf": "odblokuj-pdf", "protect-pdf": "zabezpiecz-pdf",
    "sign-pdf": "podpisz-pdf", "redact-pdf": "utajnij-pdf", "compare-pdf": "porownaj-pdf",
    "pdf-converter": "konwerter-pdf", "reduce-pdf-size": "zmniejsz-rozmiar-pdf", "pdf-editor": "edytor-pdf", "pdf-security": "bezpieczenstwo-pdf",
  },
  sv: {
    "merge-pdf": "sla-ihop-pdf", "split-pdf": "dela-pdf", "extract-pages": "extrahera-sidor-pdf", "remove-pages": "ta-bort-sidor-pdf",
    "organize-pdf": "ordna-pdf", "scan-to-pdf": "skanna-till-pdf", "compress-pdf": "komprimera-pdf", "repair-pdf": "reparera-pdf",
    ...convert("till"),
    "rotate-pdf": "rotera-pdf", "add-page-numbers": "lagg-till-sidnummer", "add-watermark": "lagg-till-vattenstampel", "crop-pdf": "beskar-pdf",
    "edit-pdf": "redigera-pdf", "pdf-forms": "pdf-formular", "unlock-pdf": "las-upp-pdf", "protect-pdf": "skydda-pdf",
    "sign-pdf": "signera-pdf", "redact-pdf": "maska-pdf", "compare-pdf": "jamfor-pdf",
    "pdf-converter": "pdf-konverterare", "reduce-pdf-size": "minska-pdf-storlek", "pdf-editor": "pdf-redigerare", "pdf-security": "pdf-sakerhet",
  },
  tr: {
    "merge-pdf": "pdf-birlestir", "split-pdf": "pdf-bol", "extract-pages": "pdf-sayfa-cikar", "remove-pages": "pdf-sayfa-sil",
    "organize-pdf": "pdf-sayfalarini-duzenle", "scan-to-pdf": "pdf-tara", "compress-pdf": "pdf-sikistir", "repair-pdf": "pdf-onar",
    "ocr-pdf": "pdf-ocr",
    "jpg-to-pdf": "jpg-pdf-donustur", "word-to-pdf": "word-pdf-donustur", "powerpoint-to-pdf": "powerpoint-pdf-donustur",
    "excel-to-pdf": "excel-pdf-donustur", "html-to-pdf": "html-pdf-donustur", "pdf-to-jpg": "pdf-jpg-donustur",
    "pdf-to-word": "pdf-word-donustur", "pdf-to-powerpoint": "pdf-powerpoint-donustur", "pdf-to-excel": "pdf-excel-donustur",
    "pdf-to-pdfa": "pdf-pdfa-donustur", "pdf-to-markdown": "pdf-markdown-donustur",
    "rotate-pdf": "pdf-dondur", "add-page-numbers": "sayfa-numarasi-ekle", "add-watermark": "filigran-ekle", "crop-pdf": "pdf-kirp",
    "edit-pdf": "pdf-duzenle", "pdf-forms": "pdf-formlari", "unlock-pdf": "pdf-kilidini-ac", "protect-pdf": "pdf-koru",
    "sign-pdf": "pdf-imzala", "redact-pdf": "pdf-karart", "compare-pdf": "pdf-karsilastir",
    "pdf-converter": "pdf-donusturucu", "reduce-pdf-size": "pdf-boyutunu-kucult", "pdf-editor": "pdf-editoru", "pdf-security": "pdf-guvenligi",
  },
  vi: {
    "merge-pdf": "gop-pdf", "split-pdf": "tach-pdf", "extract-pages": "trich-xuat-trang-pdf", "remove-pages": "xoa-trang-pdf",
    "organize-pdf": "sap-xep-pdf", "scan-to-pdf": "quet-thanh-pdf", "compress-pdf": "nen-pdf", "repair-pdf": "sua-loi-pdf",
    ...convert("sang"),
    "rotate-pdf": "xoay-pdf", "add-page-numbers": "them-so-trang-pdf", "add-watermark": "them-hinh-mo-pdf", "crop-pdf": "cat-pdf",
    "edit-pdf": "chinh-sua-pdf", "pdf-forms": "bieu-mau-pdf", "unlock-pdf": "mo-khoa-pdf", "protect-pdf": "bao-ve-pdf",
    "sign-pdf": "ky-pdf", "redact-pdf": "che-thong-tin-pdf", "compare-pdf": "so-sanh-pdf",
    "pdf-converter": "chuyen-doi-pdf", "reduce-pdf-size": "giam-dung-luong-pdf", "pdf-editor": "trinh-chinh-sua-pdf", "pdf-security": "bao-mat-pdf",
  },
  sw: {
    "merge-pdf": "unganisha-pdf", "split-pdf": "gawanya-pdf", "extract-pages": "toa-kurasa-pdf", "remove-pages": "ondoa-kurasa-pdf",
    "organize-pdf": "panga-pdf", "scan-to-pdf": "changanua-hadi-pdf", "compress-pdf": "punguza-ukubwa-wa-pdf", "repair-pdf": "rekebisha-pdf",
    "ocr-pdf": "ocr-ya-pdf", ...convert("kuwa"),
    "rotate-pdf": "zungusha-pdf", "add-page-numbers": "weka-namba-za-kurasa", "add-watermark": "weka-alama-maji", "crop-pdf": "kata-pdf",
    "edit-pdf": "hariri-pdf", "pdf-forms": "fomu-za-pdf", "unlock-pdf": "fungua-pdf", "protect-pdf": "linda-pdf",
    "sign-pdf": "tia-sahihi-pdf", "redact-pdf": "ficha-taarifa-pdf", "compare-pdf": "linganisha-pdf",
    "pdf-converter": "kigeuzi-cha-pdf", "reduce-pdf-size": "fanya-pdf-iwe-ndogo", "pdf-editor": "mhariri-wa-pdf", "pdf-security": "usalama-wa-pdf",
  },
};

// A page's slug in a language, from its English slug.
export const localSlug = (slug: string, lang: Locale) => SLUGS[lang]?.[slug] ?? slug;

// The English slug of a page, from its slug in a language; undefined when the
// language has no page there (an English slug it has replaced included).
export function englishSlug(slug: string, lang: Locale): string | undefined {
  const table = SLUGS[lang] ?? {};
  for (const [en, local] of Object.entries(table)) if (local === slug) return en;
  return slug in table ? undefined : slug;
}

// The localized address an old English one moved to, or undefined if it
// didn't move: /es/merge-pdf → /es/unir-pdf.
export function movedTo(slug: string, lang: Locale): string | undefined {
  const local = SLUGS[lang]?.[slug];
  return local && local !== slug ? `/${lang}/${local}` : undefined;
}

// A path after /{lang}, written with English slugs ("/merge-pdf"), in a
// language: "/unir-pdf". Other paths ("", "/faq", "/workflows") stay.
export function localizePath(path: string, lang: Locale) {
  const m = path.match(/^\/([^/?#]+)(.*)$/);
  return m ? `/${localSlug(m[1], lang)}${m[2]}` : path;
}

// The same page in another language, from a full path: /es/unir-pdf → /de/pdf-zusammenfuegen.
export function switchLanguage(pathname: string, to: Locale) {
  const [, from = "", slug, ...rest] = pathname.split("/");
  if (!hasLocale(from) || !slug) return `/${to}${slug ? `/${[slug, ...rest].join("/")}` : ""}`;
  const en = englishSlug(slug, from) ?? slug;
  return `/${to}/${[localSlug(en, to), ...rest].join("/")}`;
}
