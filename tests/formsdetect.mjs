// Form field detection (src/lib/pdf/formsdetect.ts) on generated flat forms
// whose blanks are known: underscore runs, drawn answer lines, captioned
// signature lines, check boxes, empty table cells and comment boxes, mixed
// with things that are not fields (headings with rules under them, footers,
// underlined text, bullets, filled tables, a logo). Precision and recall are
// measured against the known blanks and must stay above the minimums below.
//
//   node tests/formsdetect.mjs [--verbose]
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { load, openPdf, check, eq } from "./lib/load.mjs";

const { detectDocument, detectFields, toItems } = await load("formsdetect");
const { editPdf } = await load("edit");

const MIN_PRECISION = 0.9;
const MIN_RECALL = 0.9;
const MIN_LABELS = 0.9; // of the blanks found, those named after their own label
const FORMS = 30;
const verbose = process.argv.includes("--verbose");

const results = { failed: 0 };
const test = check(results);

// ── Fixtures. Coordinates are top-left origin, in points, like the detector's.
const W = 612, H = 792;
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TEXT_LABELS = ["Name", "Full name", "Address", "City", "Phone", "Email", "Employer", "Occupation", "Postcode", "Reference", "Account holder", "Emergency contact"];
const DATE_LABELS = ["Date", "Date of birth", "Start date"];
const SIGN_LABELS = ["Signature", "Applicant signature"];
// Which blocks the generated forms used, to report coverage.
const used = [];
const kindOf = (label) => (/date/i.test(label) ? "dateField" : /signature/i.test(label) ? "signatureField" : "textField");

async function makeForm(seed, extra) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const truth = [];
  const text = (s, x, base, size = 10, f = font) => page.drawText(s, { x, y: H - base, size, font: f, color: rgb(0, 0, 0) });
  // Each form draws in its own way: answer lines stroked or as thin filled
  // rectangles, boxes as rectangles or as four lines, blanks as one text run
  // or as a label and a separate run of underscores.
  const style = { thinRects: r() < 0.5, fourLines: r() < 0.5, splitRuns: r() < 0.5, gap: 8 + r() * 8 };
  const line = (x0, y, x1, t = 0.75) => style.thinRects
    ? page.drawRectangle({ x: x0, y: H - y - t / 2, width: x1 - x0, height: t, color: rgb(0, 0, 0) })
    : page.drawLine({ start: { x: x0, y: H - y }, end: { x: x1, y: H - y }, thickness: t, color: rgb(0, 0, 0) });
  const box = (x, top, w, h, o = {}) => {
    if (!style.fourLines || o.color) return page.drawRectangle({ x, y: H - top - h, width: w, height: h, borderColor: rgb(0, 0, 0), borderWidth: 0.75, ...o });
    const seg = (ax, ay, bx, by) => page.drawLine({ start: { x: ax, y: H - ay }, end: { x: bx, y: H - by }, thickness: 0.75, color: rgb(0, 0, 0) });
    seg(x, top, x + w, top); seg(x, top + h, x + w, top + h); seg(x, top, x, top + h); seg(x + w, top, x + w, top + h);
  };
  const blank = (kind, x0, top, x1, bottom, label) => truth.push({ kind, x0, y0: top, x1, y1: bottom, label });
  const L = 54;
  let y = 64;

  // Title, with a rule under it across the page: not a field.
  text("Application form", L, y, 18, bold);
  line(L, y + 8, W - L, 1);
  y += 40;

  const blocks = ["underscores", "line", "inline", "checks", "table", "captions", "comments", "paragraph", "filledTable", "underlined", "bullets", "logo", "section", "framed", "comb", "dots", "contents"];
  // Shuffle, so every form is laid out differently.
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }
  // Nine of them per page, so every one fits above the footer.
  for (const b of blocks.slice(0, 9)) {
    const size = pick([9, 10, 11, 12]);
    if (b === "underscores") {
      for (let k = 0; k < 2; k++) {
        const label = pick([...TEXT_LABELS, ...DATE_LABELS]);
        const head = `${label}: `;
        const n = 12 + Math.floor(r() * 20);
        let x0 = L + font.widthOfTextAtSize(head, size);
        if (style.splitRuns) {
          text(head.trim(), L, y, size);
          x0 += 3;
          text("_".repeat(n), x0, y, size);
        } else text(head + "_".repeat(n), L, y, size);
        blank(kindOf(label), x0, y - size, x0 + font.widthOfTextAtSize("_".repeat(n), size), y + 2, label);
        y += size + style.gap;
      }
    } else if (b === "line") {
      for (let k = 0; k < 2; k++) {
        const label = pick([...TEXT_LABELS, ...SIGN_LABELS]);
        text(`${label}:`, L, y, size);
        const x0 = L + font.widthOfTextAtSize(`${label}:`, size) + 6;
        const x1 = Math.min(W - L, x0 + 120 + r() * 220);
        line(x0, y + 2, x1);
        blank(kindOf(label), x0, y - size, x1, y + 2, label);
        y += size + style.gap + 2;
      }
    } else if (b === "inline") {
      // Two blanks on one line.
      const [a, c] = [pick(TEXT_LABELS), pick(DATE_LABELS)];
      let x = L;
      for (const label of [a, c]) {
        const head = `${label} `;
        text(head + "_".repeat(14), x, y, size);
        const x0 = x + font.widthOfTextAtSize(head, size);
        const x1 = x0 + font.widthOfTextAtSize("_".repeat(14), size);
        blank(kindOf(label), x0, y - size, x1, y + 2, label);
        x = x1 + 24;
      }
      y += size + 16;
    } else if (b === "checks") {
      const s = 9 + Math.floor(r() * 4);
      text("Tick all that apply:", L, y, size);
      y += size + 8;
      let x = L;
      // Labels after the boxes, or before them.
      const after = r() < 0.7;
      for (const label of ["Full time", "Part time", "Contract"]) {
        const lw = font.widthOfTextAtSize(label, size);
        if (!after) {
          text(label, x, y, size);
          x += lw + 5;
        }
        box(x, y - s + 1, s, s);
        blank("checkbox", x, y - s + 1, x + s, y + 1, label);
        if (after) text(label, x + s + 5, y, size);
        x += s + (after ? 5 + lw : 0) + 24;
      }
      y += size + 18;
    } else if (b === "table") {
      // Labels on the left, empty answer cells on the right.
      const rows = 2 + Math.floor(r() * 3);
      const rh = 18 + Math.floor(r() * 6);
      const [x0, xm, x1] = [L, L + 140, W - L];
      for (let k = 0; k <= rows; k++) line(x0, y + k * rh, x1, 0.75);
      for (const x of [x0, xm, x1]) page.drawLine({ start: { x, y: H - y }, end: { x, y: H - y - rows * rh }, thickness: 0.75, color: rgb(0, 0, 0) });
      for (let k = 0; k < rows; k++) {
        const label = pick([...TEXT_LABELS, ...DATE_LABELS]);
        text(label, x0 + 4, y + k * rh + rh * 0.68, 9);
        blank(kindOf(label), xm, y + k * rh, x1, y + (k + 1) * rh, label);
      }
      y += rows * rh + 22;
    } else if (b === "captions") {
      // Lines with what goes on them printed underneath.
      y += 14;
      const parts = [["Signature", L, L + 200], ["Date", L + 240, L + 360]];
      for (const [label, x0, x1] of parts) {
        line(x0, y, x1);
        text(label, x0, y + 11, 8);
        blank(kindOf(label), x0, y - 16, x1, y, label);
      }
      y += 34;
    } else if (b === "comments") {
      text("Comments", L, y, size, bold);
      const h = 44 + Math.floor(r() * 20);
      box(L, y + 6, 300, h);
      blank("textField", L, y + 6, L + 300, y + 6 + h, "Comments");
      y += h + 30;
    } else if (b === "paragraph") {
      for (const s of ["Please complete every section of this form in block capitals.", "Incomplete applications may be returned to the sender without review."]) {
        text(s, L, y, 9);
        y += 13;
      }
      y += 10;
    } else if (b === "filledTable") {
      const xs = [L, L + 160, L + 320, W - L];
      for (let k = 0; k <= 3; k++) line(xs[0], y + k * 18, xs[3], 0.6);
      for (const x of xs) page.drawLine({ start: { x, y: H - y }, end: { x, y: H - y - 54 }, thickness: 0.6, color: rgb(0, 0, 0) });
      for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) text(["Item", "Qty", "Price"][c] + ` ${k + 1}`, xs[c] + 4, y + k * 18 + 13, 9);
      y += 54 + 20;
    } else if (b === "underlined") {
      const s = "See the notes at www.example.org/help";
      text(s, L, y, size);
      line(L, y + 1.5, L + font.widthOfTextAtSize(s, size), 0.6);
      y += size + 14;
    } else if (b === "bullets") {
      for (const s of ["Bring photo identification", "Bring proof of address"]) {
        page.drawRectangle({ x: L, y: H - y + 1, width: 4, height: 4, color: rgb(0, 0, 0) });
        text(s, L + 10, y, 9);
        y += 14;
      }
      y += 8;
    } else if (b === "comb") {
      // One box per character: one field across them all.
      const label = pick(["Postcode", "Account number", "Reference"]);
      text(label, L, y, size);
      const x0 = L + font.widthOfTextAtSize(label, size) + 8;
      const n = 6 + Math.floor(r() * 4), cw = 14, top = y - 13, bottom = y + 3;
      line(x0, top, x0 + n * cw, 0.75);
      line(x0, bottom, x0 + n * cw, 0.75);
      for (let k = 0; k <= n; k++) page.drawLine({ start: { x: x0 + k * cw, y: H - top }, end: { x: x0 + k * cw, y: H - bottom }, thickness: 0.75, color: rgb(0, 0, 0) });
      blank("textField", x0, top, x0 + n * cw, bottom, label);
      y += size + 18;
    } else if (b === "dots") {
      // Dotted leaders to write on.
      const label = pick([...TEXT_LABELS, ...DATE_LABELS]);
      const head = `${label}: `;
      const dots = ".".repeat(30 + Math.floor(r() * 30));
      text(head + dots, L, y, size);
      const x0 = L + font.widthOfTextAtSize(head, size);
      blank(kindOf(label), x0, y - size, x0 + font.widthOfTextAtSize(dots, size), y + 2, label);
      y += size + style.gap;
    } else if (b === "contents") {
      // A contents list: its leaders run to page numbers, and aren't blanks.
      for (const [s, n] of [["Introduction", 2], ["Eligibility", 3]]) {
        text(`${s} ${".".repeat(40)} ${n}`, L, y, 9);
        y += 13;
      }
      y += 8;
    } else if (b === "section") {
      // A short rule above a section heading: neither is a field.
      y += 6;
      line(L, y, L + 200 + r() * 160, 0.75);
      text(pick(["Your details", "Employment", "Declaration"]), L, y + 18, 12, bold);
      y += 34;
    } else if (b === "framed") {
      // A note in a box: the box holds text, so it's no blank.
      box(L, y, 380, 40);
      text("Note: keep a copy of this form for your records.", L + 8, y + 16, 9);
      text("Forms received after the deadline will not be processed.", L + 8, y + 30, 9);
      y += 56;
    } else if (b === "logo") {
      page.drawRectangle({ x: W - L - 60, y: H - y - 30, width: 60, height: 30, color: rgb(0.1, 0.3, 0.6) });
      text("ACME", W - L - 52, y + 20, 12, bold);
      y += 44;
    }
  }
  if (y > H - 64) throw new Error(`form ${seed} runs into the footer (y ${Math.round(y)})`);
  used.push(...blocks.slice(0, 9));
  // Footer: a rule across the page with the page number under it.
  line(L, H - 50, W - L, 0.5);
  text("Page 1 of 1", L, H - 38, 8);
  extra?.({ page, doc, font, truth });
  return { bytes: await doc.save(), truth };
}

// ── Scoring
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
};
const cls = (k) => (k === "checkbox" ? "check" : "text");
const inPoints = (s) => ({ kind: s.kind, label: s.label, x0: s.x * W, y0: s.y * H, x1: (s.x + s.w) * W, y1: (s.y + s.h) * H });
// Greedy one-to-one matching by overlap, same class (check box or text).
function score(found, truth) {
  const pairs = [];
  found.forEach((f, i) => truth.forEach((t, j) => {
    const o = iou(f, t);
    if (o >= 0.4 && cls(f.kind) === cls(t.kind)) pairs.push([o, i, j]);
  }));
  pairs.sort((a, b) => b[0] - a[0]);
  const fi = new Set(), tj = new Set();
  let kindRight = 0, labelRight = 0;
  const wrongLabels = [];
  for (const [, i, j] of pairs) {
    if (fi.has(i) || tj.has(j)) continue;
    fi.add(i);
    tj.add(j);
    if (found[i].kind === truth[j].kind) kindRight++;
    if (found[i].label === truth[j].label) labelRight++;
    else wrongLabels.push(`"${found[i].label}" for "${truth[j].label}"`);
  }
  return {
    tp: fi.size, found: found.length, truth: truth.length, kindRight, labelRight, wrongLabels,
    falsePos: found.filter((_, i) => !fi.has(i)), missed: truth.filter((_, j) => !tj.has(j)),
  };
}
// pdf.js takes over the bytes it is given, so it gets a copy.
const open = (bytes) => openPdf(bytes.slice());
const detect = async (bytes) => (await detectDocument(await open(bytes))).map(inPoints);

// ── Tests

await test(`precision ≥ ${MIN_PRECISION} and recall ≥ ${MIN_RECALL} over ${FORMS} generated forms`, async () => {
  const total = { tp: 0, found: 0, truth: 0, kindRight: 0, labelRight: 0 };
  for (let s = 1; s <= FORMS; s++) {
    const { bytes, truth } = await makeForm(s);
    const r = score(await detect(bytes), truth);
    for (const k of Object.keys(total)) total[k] += r[k];
    if (verbose && r.wrongLabels.length) console.log(`  form ${s}: labels ${r.wrongLabels.join(", ")}`);
    if (verbose && (r.falsePos.length || r.missed.length)) {
      const fmt = (x) => `${x.kind}:${x.label}@${Math.round(x.x0)},${Math.round(x.y0)}-${Math.round(x.x1)},${Math.round(x.y1)}`;
      console.log(`  form ${s}: extra [${r.falsePos.map(fmt).join(" ")}] missed [${r.missed.map(fmt).join(" ")}]`);
    }
  }
  const precision = total.tp / total.found, recall = total.tp / total.truth;
  const counts = {};
  for (const b of used) counts[b] = (counts[b] ?? 0) + 1;
  if (verbose) console.log(`      blocks: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`      ${total.truth} blanks, ${total.found} suggested, ${total.tp} right: precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)}, kind right ${(total.kindRight / Math.max(1, total.tp)).toFixed(3)}, label right ${(total.labelRight / Math.max(1, total.tp)).toFixed(3)}`);
  if (precision < MIN_PRECISION) throw new Error(`precision ${precision.toFixed(3)}`);
  if (recall < MIN_RECALL) throw new Error(`recall ${recall.toFixed(3)}`);
  if (total.labelRight / total.tp < MIN_LABELS) throw new Error(`labels right ${(total.labelRight / total.tp).toFixed(3)}`);
});

await test("date and signature blanks are suggested as date and signature fields", async () => {
  let right = 0, of = 0;
  for (let s = 1; s <= FORMS; s++) {
    const { bytes, truth } = await makeForm(s);
    const found = await detect(bytes);
    for (const t of truth.filter((x) => x.kind !== "textField" && x.kind !== "checkbox")) {
      of++;
      if (found.some((f) => f.kind === t.kind && iou(f, t) >= 0.4)) right++;
    }
  }
  if (right / of < 0.9) throw new Error(`${right}/${of}`);
  return `${right}/${of}`;
});

// The backlog's acceptance case: 3 underline blanks and 2 boxes.
async function acceptanceForm() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const at = (s, x, y) => page.drawText(s, { x, y: H - y, size: 11, font });
  at("Name: ______________________", 72, 100);
  at("Email: _____________________", 72, 130);
  at("Phone:", 72, 160);
  page.drawLine({ start: { x: 115, y: H - 162 }, end: { x: 300, y: H - 162 }, thickness: 0.75 });
  page.drawRectangle({ x: 72, y: H - 200, width: 11, height: 11, borderWidth: 0.75, borderColor: rgb(0, 0, 0) });
  at("I agree to the terms", 90, 199);
  page.drawRectangle({ x: 72, y: H - 225, width: 11, height: 11, borderWidth: 0.75, borderColor: rgb(0, 0, 0) });
  at("Send me news", 90, 224);
  return doc.save();
}

await test("3 underline blanks and 2 boxes: 3 text and 2 checkbox suggestions; accepted, 5 fields", async () => {
  const bytes = await acceptanceForm();
  const found = await detectDocument(await open(bytes));
  const texts = found.filter((f) => f.kind !== "checkbox"), checks = found.filter((f) => f.kind === "checkbox");
  if (texts.length < 3 || checks.length < 2) throw new Error(`${texts.length} text, ${checks.length} checkbox`);
  eq(texts.map((f) => f.label).join(), "Name,Email,Phone", "labels");
  eq(checks.map((f) => f.label).join(), "I agree to the terms,Send me news", "checkbox labels");
  const out = await editPdf(new File([bytes], "flat.pdf"), toItems(found), "forms");
  const pdf = await openPdf(new Uint8Array(await out[0].blob.arrayBuffer()));
  const fields = [...(await pdf.getFieldObjects())].map(([name, ws]) => [name, ws.find((w) => w.type).type]);
  eq(fields.length, 5, "fields");
  eq(fields.map((f) => f[1]).sort().join(), "checkbox,checkbox,text,text,text", "types");
  return fields.map((f) => f[0]).join(", ");
});

await test("a blank that already has a field isn't suggested again", async () => {
  const bytes = await acceptanceForm();
  const found = await detectDocument(await open(bytes));
  const once = await editPdf(new File([bytes], "flat.pdf"), toItems(found.slice(0, 2)), "forms");
  const again = await detectDocument(await openPdf(new Uint8Array(await once[0].blob.arrayBuffer())));
  eq(again.map((f) => f.label).join(), found.slice(2).map((f) => f.label).join(), "suggestions left");
});

await test("box characters in the text (☐) are check boxes", async () => {
  const run = (text, x, y) => ({ text, x, y, w: text.length * 6, h: 10, size: 10, bold: false, italic: false });
  const lines = [{ runs: [run("☐ Yes", 72, 100)], text: "☐ Yes", x: 72, y: 100, w: 30, size: 10, bold: false }];
  const found = detectFields({ width: W, height: H, lines, items: lines[0].runs }, { h: [], v: [] });
  eq(found.length, 1, "suggestions");
  eq(found[0].kind, "checkbox", "kind");
  eq(found[0].label, "Yes", "label");
});

await test("a page with nothing to fill in gets no suggestions", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Annual report", { x: 72, y: H - 80, size: 20, font });
  page.drawLine({ start: { x: 72, y: H - 90 }, end: { x: W - 72, y: H - 90 }, thickness: 1 });
  for (let k = 0; k < 20; k++) page.drawText("Revenue grew in every region, led by strong demand for the new range.", { x: 72, y: H - 120 - k * 14, size: 10, font });
  page.drawLine({ start: { x: 72, y: 50 }, end: { x: W - 72, y: 50 }, thickness: 0.5 });
  page.drawText("Page 1", { x: 72, y: 38, size: 8, font });
  eq((await detectDocument(await open(await doc.save()))).length, 0, "suggestions");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
