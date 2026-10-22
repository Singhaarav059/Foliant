// Chat with PDF: without a model, a question about the report is answered from
// its own text, with a citation that opens the page it came from.
import { must } from "./lib.mjs";

const spec = {
  slug: "chat-with-pdf",
  files: ["report.pdf"],
  variants: {
    "no model": {
      run: async ({ page }) => {
        await page.waitForFunction(() => document.querySelector("#chat-q") && !document.querySelector("#chat-q").disabled, null, { timeout: 30000 });
        await page.locator("#chat-q").fill("How much did revenue grow?");
        await page.locator("#chat-q").press("Enter");
        await page.locator("main [data-answer=done]").first().waitFor({ timeout: 60000 });
        return page.evaluate(() => ({
          kind: "chat",
          answer: document.querySelector("main [data-answer=done]")?.textContent ?? "",
          cites: [...document.querySelectorAll("main [data-citation]")].map((b) => b.getAttribute("data-citation")),
        }));
      },
      check: (r) => {
        must(/12/.test(r.answer), `answer: ${r.answer.slice(0, 120)}`);
        must(r.cites.includes("1"), `citations: ${r.cites.join(",")}`);
        return `cites page ${r.cites[0]}`;
      },
    },
  },
};
export default spec;
