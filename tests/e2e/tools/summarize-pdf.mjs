// Summarize PDF: the summary is shown on the page (nothing downloads by
// itself), names the report's subject, a long one says more than a short one,
// and it saves as Markdown.
import { readFileSync } from "node:fs";
import { must } from "./lib.mjs";

const summary = (length) => async (h) => {
  const { page } = h;
  await page.waitForSelector("main aside.card", { timeout: 30000 });
  await h.radio("summaryLength", length);
  await h.action().click({ timeout: 10000 });
  const box = page.locator("main [data-summary]").first();
  await box.waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelector("main [data-summary]")?.textContent?.trim(), null, { timeout: 10000 });
  const text = (await box.innerText()).trim();
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), h.icon("download", "main section").click()]);
  const path = await d.path();
  return { kind: "summary", text, name: d.suggestedFilename(), md: readFileSync(path, "utf8") };
};
const check = (r) => {
  must(r.text.length > 40, `summary of ${r.text.length} characters`);
  must(/report|quarter/i.test(r.text), `summary: ${r.text.slice(0, 80)}`);
  must(/\.md$/.test(r.name) && r.md.trim().length >= r.text.length * 0.8, `saved ${r.name}, ${r.md.length} characters`);
};
const spec = {
  slug: "summarize-pdf",
  files: ["report.pdf"],
  variants: {
    short: { run: summary(0), check: (r, h) => { check(r); h.state.shortSummary = r.text.length; } },
    long: {
      run: summary(2),
      check: (r, h) => {
        check(r);
        if (h.state.shortSummary) must(r.text.length > h.state.shortSummary, `long ${r.text.length} ≤ short ${h.state.shortSummary}`);
      },
    },
  },
};
export default spec;
