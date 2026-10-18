// Builds tests/fixtures/rich.docx: the Word features a converter most often
// loses. Run once; the file is checked in.
//
//   node tests/make-rich-docx.mjs
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Header, Footer, PageNumber, AlignmentType, Table, TableRow, TableCell,
  WidthType, ImageRun, PageOrientation, SectionType, LevelFormat, PageBreak,
} from "docx";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// A 40×20 blue/orange PNG.
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let x = 0xffffffff; for (const v of b) x = crcTable[(x ^ v) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const body = Buffer.concat([Buffer.from(t), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]); };
  const w = 40, h = 20, ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(x < w / 2 ? [30, 90, 200] : [240, 130, 40], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const header = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Northwind Quarterly", color: "1F4E79" })] })] });
const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES] })] })] });
const body = "Revenue grew in every region this quarter, led by renewals in the north and new accounts in the west. ".repeat(6);

const doc = new Document({
  creator: "Nopload tests",
  numbering: { config: [{ reference: "steps", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }] }] },
  sections: [
    {
      headers: { default: header },
      footers: { default: footer },
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Quarterly Review")] }),
        new Paragraph({ children: [new TextRun({ text: "Prepared in Georgia, in red: ", font: "Georgia", color: "C00000", bold: true }), new TextRun({ text: "confidential draft.", italics: true })] }),
        new Paragraph({ children: [new ImageRun({ type: "png", data: png(), transformation: { width: 160, height: 80 } })] }),
        new Table({
          width: { size: 9000, type: WidthType.DXA },
          rows: [["Region", "Q1", "Q2"], ["North", "1,200", "1,350"], ["West", "2,040", "2,210"]].map((r, i) =>
            new TableRow({ children: r.map((c) => new TableCell({ width: { size: 3000, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: c, bold: i === 0 })] })] })) })),
        }),
        ...["Collect the figures", "Check them twice", "Send the report"].map((t) => new Paragraph({ numbering: { reference: "steps", level: 0 }, children: [new TextRun(t)] })),
        new Paragraph({ children: [new PageBreak()] }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("After the page break")] }),
      ],
    },
    {
      properties: { type: SectionType.NEXT_PAGE, column: { count: 2, space: 708 } },
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Two columns")] }),
        ...Array.from({ length: 8 }, () => new Paragraph({ children: [new TextRun(body)] })),
      ],
    },
    {
      properties: { type: SectionType.NEXT_PAGE, page: { size: { orientation: PageOrientation.LANDSCAPE, width: 11906, height: 16838 } } },
      children: [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Landscape appendix")] })],
    },
  ],
});
writeFileSync(new URL("./fixtures/rich.docx", import.meta.url), await Packer.toBuffer(doc));
console.log("wrote tests/fixtures/rich.docx");
