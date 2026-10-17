// OCR accuracy: draws pages of known text in Chrome under hard conditions,
// reads them with Tesseract (standard) and PaddleOCR (high accuracy) through
// the same page cleanup, and compares character error rates. Each case has a
// ceiling for each engine, high accuracy must be at least as good overall,
// and it's only offered for languages whose own letters it reads.
// Text is drawn in the bundled fonts, so every machine renders the same pages.
// Needs Chrome (CHROME_PATH, or the usual install location).
//
//   node tests/ocr-accuracy.mjs
import pw from "playwright-core";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorker, createScheduler } from "tesseract.js";
import { root, vendorDir, load, check, eq } from "./lib/load.mjs";

const chrome = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!chrome) {
  console.log("skip  no Chrome found (set CHROME_PATH)");
  process.exit(0);
}
const results = { failed: 0 };
const test = check(results);
const { readPage } = await load("ocr");
const paddle = await load("paddle");
paddle.paddleFiles.url = (name) => join(vendorDir, "paddle", name);
paddle.paddleFiles.load = async (name) => new Uint8Array(readFileSync(join(vendorDir, "paddle", name)));
paddle.paddleFiles.proxy = () => false;

const LATIN = [
  "Invoice 4471 issued on 12 March 2026 to Northwind Traders Ltd.",
  "Total due: 1,250.00 EUR, payable within thirty days of receipt.",
  "Please quote the reference AB-77-310 with every payment you make.",
  "Questions? Write to accounts@northwind.example or call +44 20 7946 0958.",
];
const CHINESE = ["发票编号四四七一，开具日期为二零二六年三月十二日。", "应付总额为一千二百五十欧元，请在三十天内付款。"];

// Each case: text lines, how they're drawn, the Tesseract language, and the
// highest character error rate [Tesseract, PaddleOCR] may reach. Measured
// 2026-10-17 with the text shifted by fractions of a pixel, which moves small
// print by a whole word (Tesseract drops "accounts@northwind.example" at some
// shifts: 0.4% to 10.6%), so each ceiling sits above the worst shift.
const cases = {
  clean: { lines: LATIN, font: "28px Tinos", lang: "eng", max: [0.01, 0.01] },
  smallPrint: { lines: LATIN, font: "13px Arimo", lang: "eng", max: [0.15, 0.03] },
  blurNoise: { lines: LATIN, font: "22px Arimo", blur: 1.4, noise: 40, lang: "eng", max: [0.03, 0.04] },
  faintShadow: { lines: LATIN, font: "22px Tinos", ink: "#9a9a9a", shadow: true, lang: "eng", max: [0.02, 0.02] },
  phonePhoto: { lines: LATIN, font: "24px Arimo", rotate: 2.5, blur: 1, noise: 25, shadow: true, lang: "eng", max: [0.02, 0.02] },
  degraded: { lines: LATIN, font: "18px Tinos", blur: 1.2, noise: 35, ink: "#555", shadow: true, rotate: 1.2, lang: "eng", max: [0.15, 0.12] },
  // Barely legible to a person: not compared, but a doubtful page must not
  // fill up with guesses (a CER over 100% means more junk than text).
  extreme: { lines: LATIN, font: "15px Tinos", blur: 1.5, noise: 60, ink: "#555", shadow: true, rotate: 1.2, lang: "eng", max: [1, 1], report: true },
  chinese: { lines: CHINESE, font: "30px 'Noto Sans SC'", lang: "chi_sim", max: [0.05, 0.03] },
};

// Ordinary sentences with each language's own letters and marks, for the
// high-accuracy gate. Greek, French and Portuguese show why they aren't offered.
const LANGUAGES = {
  deu: ["Die Größe der Lieferung überrascht uns: dreißig Kisten für Müller & Söhne.", "Übrigens prüfen wir die Rechnung bis Ende März und bestätigen den Empfang."],
  fra: ["« Le cœur du problème, c’est l’œuvre elle-même », a-t-il déclaré à Noël.", "Elle était naïve : connaître l’Île-de-France ne suffit pas pour y être reçue."],
  ita: ["Perché la società non ha ancora pagato? È già passato più di un mese.", "La città è piena di turisti e l’università resterà chiusa fino a lunedì."],
  spa: ["¿Dónde está la factura del señor Muñoz? ¡Llegó ayer por la mañana!", "El año pasado pagamos treinta y dos euros más por cada envío a León."],
  por: ["A informação sobre a situação financeira ainda não está disponível.", "Em março, as ações subiram e os acionistas ficaram satisfeitos com a gestão."],
  nld: ["De vergadering van het bestuur is verplaatst naar donderdag 14 mei.", "Wij zijn blij dat de coöperatie de financiële stukken op tijd heeft ingediend."],
  swe: ["Fakturan från företaget ska betalas senast den sista maj i år.", "Vi hälsar alla välkomna till årets möte i Göteborg på Östra torget."],
  cat: ["L’Ajuntament ha aprovat el pressupost per a l’any vinent després d’un debat.", "La col·lecció del museu inclou obres d’artistes catalans i és oberta cada dia."],
  ind: ["Rapat dewan direksi akan diadakan pada hari Kamis di kantor pusat Jakarta.", "Mohon kirimkan laporan keuangan sebelum akhir bulan ini kepada kami."],
  msa: ["Mesyuarat lembaga pengarah akan diadakan pada hari Khamis di ibu pejabat.", "Sila hantar laporan kewangan sebelum hujung bulan ini kepada kami."],
  swa: ["Mkutano wa bodi ya wakurugenzi utafanyika Alhamisi katika ofisi kuu.", "Tafadhali tuma ripoti ya fedha kabla ya mwisho wa mwezi huu."],
  ell: ["Η εταιρεία έστειλε το τιμολόγιο στους πελάτες της την Τρίτη το πρωί.", "Παρακαλούμε επιβεβαιώστε την παραλαβή μέχρι το τέλος του μήνα."],
  jpn: ["請求書番号は四四七一で、発行日は二〇二六年三月十二日です。", "お支払いは三十日以内にお願いいたします。"],
  chi_tra: ["發票編號為四四七一，開立日期為二零二六年三月十二日。", "應付總額為一千二百五十歐元，請於三十天內付款。"],
};
const FONTS = { jpn: "30px 'Noto Sans JP'", chi_tra: "30px 'Noto Sans TC'" };
for (const [lang, lines] of Object.entries(LANGUAGES)) cases[lang] = { lines, font: FONTS[lang] ?? "26px Tinos", lang, language: true };

// The fonts come from @fontsource, with their unicode ranges, over a stand-in origin.
const FAMILIES = ["tinos", "arimo", "noto-sans-sc", "noto-sans-tc", "noto-sans-jp"];
const browser = await pw.chromium.launch({ executablePath: chrome });
const page = await browser.newPage();
await page.route("http://test.local/**", (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html>${FAMILIES.map((f) => `<link rel="stylesheet" href="/fonts/${f}/400.css">`).join("")}` });
  const file = join(root, "node_modules/@fontsource", path.replace(/^\/fonts\//, ""));
  if (!path.startsWith("/fonts/") || path.includes("..") || !existsSync(file)) return route.fulfill({ status: 404 });
  return route.fulfill({ body: readFileSync(file), contentType: file.endsWith(".css") ? "text/css" : "font/woff2" });
});
await page.goto("http://test.local/");
async function draw(c) {
  return page.evaluate(async (c) => {
    // Canvas text doesn't wait for web fonts: load the faces this text needs, and refuse a fallback.
    await document.fonts.load(c.font, c.lines.join(""));
    if (!document.fonts.check(c.font, c.lines.join(""))) throw new Error(`font not loaded: ${c.font}`);
    const W = 1400, H = 700;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const x = cv.getContext("2d");
    x.fillStyle = "#fff";
    x.fillRect(0, 0, W, H);
    if (c.shadow) { // uneven light and paper texture
      const g = x.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "#fdfaf2");
      g.addColorStop(1, "#8f8a80");
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
    }
    x.save();
    if (c.rotate) { x.translate(W / 2, H / 2); x.rotate((c.rotate * Math.PI) / 180); x.translate(-W / 2, -H / 2); }
    if (c.blur) x.filter = `blur(${c.blur}px)`;
    x.fillStyle = c.ink ?? "#111";
    x.font = c.font;
    const size = parseInt(c.font, 10);
    c.lines.forEach((line, i) => x.fillText(line, 60, 120 + i * size * 2.2));
    x.restore();
    const img = x.getImageData(0, 0, W, H).data;
    const gray = new Array(W * H);
    let seed = 1;
    for (let i = 0; i < W * H; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = c.noise ? ((seed / 0x7fffffff) - 0.5) * c.noise : 0;
      gray[i] = Math.max(0, Math.min(255, Math.round(img[i * 4] * 0.3 + img[i * 4 + 1] * 0.59 + img[i * 4 + 2] * 0.11 + n)));
    }
    return { w: W, h: H, data: gray };
  }, c);
}

// Character error rate: edit distance / reference length, ignoring spaces for Chinese.
function cer(ref, hyp, cjk) {
  const norm = (s) => (cjk ? s.replace(/\s+/g, "") : s.replace(/\s+/g, " ").trim());
  const a = [...norm(ref)], b = [...norm(hyp)];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / a.length;
}

// One Tesseract worker at a time, for the language of the case at hand.
let tess = null;
async function tesseract(lang) {
  if (tess?.lang !== lang) {
    await tess?.scheduler.terminate();
    const scheduler = createScheduler();
    scheduler.addWorker(await createWorker(lang, undefined, { langPath: join(vendorDir, "tessdata"), cachePath: mkdtempSync(join(tmpdir(), "tess-")) }));
    tess = { lang, scheduler };
  }
  const { grayPng } = await load("ocrprep");
  const { scheduler } = tess;
  return async (g) => (await scheduler.addJob("recognize", Buffer.from(grayPng(g)), {}, { blocks: true })).data;
}

const rows = [];
for (const [name, c] of Object.entries(cases)) {
  const px = await draw(c);
  const image = { w: px.w, h: px.h, data: Uint8Array.from(px.data) };
  const ref = c.lines.join(" ");
  const cjk = c.lang.startsWith("chi") || c.lang === "jpn";
  const t0 = Date.now();
  const t = await readPage(await tesseract(c.lang), image);
  const t1 = Date.now();
  const p = await readPage(paddle.paddlePage, image);
  const t2 = Date.now();
  const join = (r) => r.words.map((w) => w.text).join(cjk ? "" : " ");
  rows.push({ ...c, name, tess: cer(ref, join(t), cjk), paddle: cer(ref, join(p), cjk), tms: t1 - t0, pms: t2 - t1, pText: join(p), tText: join(t), doubtful: t.doubtful });
}
await browser.close();
await tess?.scheduler.terminate();

const pct = (v) => `${(v * 100).toFixed(1)}%`.padStart(7);
const offered = (lang) => paddle.PADDLE_LANGS.includes(lang);
console.log("      case          Tesseract   PaddleOCR   (character error rate; time)");
for (const r of rows) console.log(`      ${r.name.padEnd(13)} ${pct(r.tess)} ${String(r.tms).padStart(5)}ms ${pct(r.paddle)} ${String(r.pms).padStart(5)}ms${r.language && !offered(r.lang) ? "   (high accuracy not offered)" : ""}`);
const scored = rows.filter((r) => !r.report && !r.language);
const mean = (k) => scored.reduce((s, r) => s + r[k], 0) / scored.length;
console.log(`      mean (excluding extreme) ${pct(mean("tess"))}  ${pct(mean("paddle"))}`);
if (process.env.SHOW) for (const r of rows) console.log(`\n      [${r.name}]\n      T: ${r.tText}\n      P: ${r.pText}`);

await test("each engine stays under each page's ceiling", () => {
  const over = rows.filter((r) => r.max).flatMap((r) => [["Tesseract", r.tess, r.max[0]], ["PaddleOCR", r.paddle, r.max[1]]].filter(([, v, max]) => v > max).map(([e, v, max]) => `${r.name} ${e} ${pct(v).trim()} > ${pct(max).trim()}`));
  if (over.length) throw new Error(over.join(", "));
});
// Measured 2026-10-17 (Tesseract vs PaddleOCR): Greek 0.8% vs 64% (no tonos or final
// sigma in the model's alphabet), French 0% vs 11% (« » œ ï î), Portuguese 0% vs 4.2-4.9%
// (ã read as ǎ, too close to the line to hold). The rest pass by 1.6 points or more.
await test("high accuracy is offered only for languages it reads", () => {
  const bad = [];
  for (const lang of paddle.PADDLE_LANGS) {
    if (lang === "eng" || lang === "chi_sim") continue; // the cases above
    const r = rows.find((x) => x.language && x.lang === lang);
    if (!r) bad.push(`${lang}: no sample here`);
    else if (r.paddle > r.tess + 0.05) bad.push(`${lang}: ${pct(r.paddle).trim()} vs ${pct(r.tess).trim()}`);
  }
  if (bad.length) throw new Error(bad.join(", "));
});
await test("a page too poor to read is flagged, a clean one isn't", () => {
  eq(rows.find((r) => r.name === "extreme").doubtful, true, "extreme flagged");
  eq(rows.filter((r) => r.doubtful).map((r) => r.name).join(), "extreme", "pages flagged");
});
await test("high accuracy beats standard on average", () => eq(mean("paddle") < mean("tess"), true, "mean CER lower"));
// Measured 2026-10-17: PaddleOCR can trail Tesseract on tiny, blurred Latin print
// ("degraded": 6.0-7.2% vs 1.9-10.9% as the text shifts) and leads elsewhere. Guard that gap.
await test("high accuracy is never much worse on any page", () => {
  for (const r of scored) if (r.paddle > r.tess + 0.05) throw new Error(`${r.name}: ${pct(r.paddle)} vs ${pct(r.tess)}`);
});
await test("zeros in numbers aren't read as the letter o", async () => {
  const { fixDigits } = paddle;
  eq(["1,250.0o", "AB-77-31o", "2O26", "o800", "Total", "Oslo", "No.5"].map(fixDigits).join(" "), "1,250.00 AB-77-310 2026 0800 Total Oslo No.5", "fixes");
});
process.exit(results.failed ? 1 : 0);
