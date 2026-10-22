// Workflows (P2-05): a recipe link carries the steps to a fresh profile, and
// in Chromium a whole folder runs through the steps, every result written to a
// second folder. The folder pickers are stood in for by folders in the
// origin-private file system, which hands out the same kind of handles.
import { PDFDocument, StandardFonts } from "pdf-lib";

async function tinyPdf(n) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText(`Folder file ${n}`, { x: 30, y: 100, size: 14, font });
  return [...(await doc.save())];
}

export default async function workflows({ name, browser, base, test, fixtures, pdfInfo }) {
  const hydrated = (p) => p.waitForFunction(() => [...document.querySelectorAll("button")].some((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), null, { timeout: 20000 });

  await test("workflow: a recipe link opens the same steps in a fresh profile", async () => {
    const a = await browser.newContext({ locale: "en-US" });
    let link;
    try {
      const p = await a.newPage();
      await p.goto(`${base}/en/workflows`);
      await hydrated(p);
      await p.getByRole("button", { name: /Compress PDF/ }).first().click();
      await p.getByRole("button", { name: /Add page numbers/ }).first().click();
      await p.getByRole("button", { name: "Copy recipe link" }).click();
      await p.locator("main p[role=status]").waitFor({ timeout: 5000 });
      // Copied, and put in the address bar.
      link = p.url();
      if (!/#recipe=/.test(link)) throw new Error(`no recipe in ${link}`);
    } finally {
      await a.close();
    }
    const b = await browser.newContext({ locale: "en-US", acceptDownloads: true });
    try {
      const p = await b.newPage();
      await p.goto(link);
      await hydrated(p);
      await p.locator("main p[role=status]").waitFor({ timeout: 10000 });
      const steps = await p.locator("main ol > li").allInnerTexts();
      if (steps.length !== 2 || !/Compress/.test(steps[0]) || !/page numbers/i.test(steps[1])) throw new Error(`steps: ${steps.join(" | ")}`);
      await p.locator("input[type=file]").first().setInputFiles(`${fixtures}/report.pdf`);
      const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 60000 }), p.getByRole("button", { name: "Run", exact: true }).click()]);
      const path = `${await dl.path()}`;
      const { pages } = await pdfInfo(path);
      if (pages !== 3) throw new Error(`result has ${pages} pages`);
      return "2 steps, 3-page result";
    } finally {
      await b.close();
    }
  });

  // The File System Access API is Chromium's.
  if (name !== "chromium") return;
  await test("workflow: a folder of 50 PDFs gives 50 results in the output folder", async () => {
    const c = await browser.newContext({ locale: "en-US" });
    try {
      await c.addInitScript(() => {
        window.showDirectoryPicker = async (o) => (await navigator.storage.getDirectory()).getDirectoryHandle(o?.id === "workflow-in" ? "in" : "out", { create: true });
      });
      const p = await c.newPage();
      await p.goto(`${base}/en/workflows`);
      await hydrated(p);
      const files = await Promise.all(Array.from({ length: 50 }, (_, i) => tinyPdf(i + 1)));
      await p.evaluate(async (files) => {
        const root = await navigator.storage.getDirectory();
        for (const n of ["in", "out"]) await root.removeEntry(n, { recursive: true }).catch(() => {});
        const input = await root.getDirectoryHandle("in", { create: true });
        // Ten of them in a subfolder, with the same names as ten at the top.
        const sub = await input.getDirectoryHandle("more", { create: true });
        for (const [i, bytes] of files.entries()) {
          const dir = i < 10 ? sub : input;
          const w = await (await dir.getFileHandle(`file-${(i % 40) + 1}.pdf`, { create: true })).createWritable();
          await w.write(new Uint8Array(bytes));
          await w.close();
        }
      }, files);
      await p.getByRole("button", { name: /Compress PDF/ }).first().click();
      await p.getByRole("button", { name: /Add page numbers/ }).first().click();
      await p.getByRole("button", { name: "Run on a folder" }).click();
      await p.locator("main p[role=status]").filter({ hasText: /written/ }).waitFor({ timeout: 120000 });
      const written = await p.evaluate(async () => {
        const out = await (await navigator.storage.getDirectory()).getDirectoryHandle("out");
        const names = [];
        for await (const [n] of out.entries()) names.push(n);
        return names;
      });
      if (written.length !== 50 || new Set(written).size !== 50) throw new Error(`${written.length} files: ${written.slice(0, 5).join(", ")}`);
      return "50 files written";
    } finally {
      await c.close();
    }
  });
}
