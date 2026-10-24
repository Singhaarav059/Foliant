// Legal text describes how this app actually behaves. It is a starting point:
// the operator's name, country and contact come from src/lib/brand.ts (a
// release build refuses the placeholders), and the text should be reviewed by
// a lawyer before going live.
import { BRAND, OPERATOR } from "./brand";
import { AI_CLOUD, STATIC } from "./mode";

// The static build has no server or cookies, so its text says so.
const on = <T,>(when: boolean, items: T[]) => (when ? items : []);

export const LEGAL_UPDATED = "2026-10-24";

// link: a line ending in a link, as [lead-in, text, href]; no href, no link.
type Section = { id?: string; h: string; p: string[]; list?: string[]; link?: [string, string, string] };
export type LegalDoc = { title: string; intro: string; sections: Section[] };

// Who runs the site and how to reach them, at the top of the privacy policy and terms.
const operator = (p: string): Section => ({
  id: "operator",
  h: "Who runs this site",
  p: [p],
  link: ["Contact:", OPERATOR.contact, OPERATOR.contactHref],
});

export const LEGAL: Record<"privacy" | "terms" | "cookies", LegalDoc> = {
  privacy: {
    title: "Privacy policy",
    intro: `This policy explains what ${BRAND.name} collects, why, and what you can do about it.`,
    sections: [
      operator(`${BRAND.name} is run by ${OPERATOR.name}, based in ${OPERATOR.country}, who is responsible for your data. Questions about this policy or your data go to the contact below.`),
      {
        h: "Files you process",
        p: STATIC
          ? [
              AI_CLOUD
                ? "Every tool works on your files inside your browser. Your files are never sent to us or to anyone else. The AI tools are the one exception to keeping their contents on your device: see “The AI tools” below."
                : "Every tool runs entirely in your browser. Your files are never sent to us or to anyone else.",
              "Office and HTML files are laid out in your browser and saved through its own print dialog.",
              "High-fidelity Office conversion and high-accuracy OCR download their engines (LibreOffice, and PaddleOCR with ONNX Runtime) from this same site the first time you use them. They run on your device too, so your files still stay there.",
              ...on(!AI_CLOUD, ["The AI tools (Chat with PDF, Summarize, Translate) download a model from this same site only when you choose one, and keep it on your device for next time. Models run on your device, as does your browser's built-in AI, which they use when it's already there. Your files and questions stay on your device."]),
            ]
          : [
              "Tools marked “Runs on your device” process files entirely in your browser. Those files are never sent to us.",
              "High-accuracy OCR downloads its engine (PaddleOCR with ONNX Runtime) from this same site the first time you use it. It runs on your device too, so your files still stay there.",
              "The AI tools (Chat with PDF, Summarize, Translate) download a model from this same site only when you choose one, and keep it on your device for next time. Models run on your device, as does your browser's built-in AI, which they use when it's already there. Your files and questions stay on your device.",
              "Office conversions and web page conversion send the file to our server over HTTPS. We process it in memory or a temporary folder and delete it as soon as the result is returned. We don't keep copies or look at the contents.",
            ],
      },
      ...on(AI_CLOUD, [{
        id: "ai",
        h: "The AI tools",
        p: [
          "Chat with PDF, Summarize PDF and Translate PDF use a cloud AI by default, because it gives much better results than the AI a phone or laptop can run. The tool says so next to its options, and you can switch to on-device AI there at any time.",
          "With the cloud AI, your file stays on your device, but some of its text is sent: for Chat with PDF, your question, the earlier questions and answers in that chat, and the passages of the PDF that best match the question; for Summarize PDF, the document's text (about the first 15,000 words, plus its key sentences when it's longer); for Translate PDF, the document's text, a few blocks at a time.",
          "That text goes over HTTPS to a small function of ours on Cloudflare. With the default choice, Claude by Anthropic, the function passes it to Claude, an AI model made by Anthropic; when Anthropic can't answer (for example during an outage), it goes to Cloudflare Workers AI instead. If you choose Cloudflare Workers AI, it goes only there, where Qwen3, an open model, answers, and never to Anthropic. The result says which one answered.",
          "We don't store or log the text or the answers. To stop one visitor using up the service, the function counts how much text each IP address sent in the last hour, in memory only, for up to an hour. Anthropic and Cloudflare process the text under their own commercial terms and privacy policies; under those terms neither uses it to train AI models. Anthropic may keep it for a limited time to detect misuse.",
          "With on-device AI, nothing is sent: the AI tools download a model from this same site only when you choose one and keep it on your device for next time, or use your browser's built-in AI when it's already there. Without a model they pick sentences from the document itself. The answers are simpler, and large models need a recent computer.",
        ],
      }]),
      ...on(!STATIC, [{
        h: "Messages",
        p: ["If you use the contact form we store your email address and message so we can reply."],
      }]),
      {
        h: "Technical data",
        p: [
          STATIC
            ? AI_CLOUD
              ? "This site is served as plain files by a hosting provider, which may log requests (IP address, time, page requested) under its own privacy policy. Apart from the AI function described above, we don't run a server of our own."
              : "This site is served as plain files by a hosting provider, which may log requests (IP address, time, page requested) under its own privacy policy. We don't run a server of our own."
            : "Our server logs requests (IP address, time, page requested) for security and rate limiting. Logs are kept for a short period and then deleted.",
        ],
      },
      {
        h: "What we don't do",
        p: ["We don't sell data, show ads, or use third-party trackers or analytics."],
      },
      {
        h: "Your rights",
        p: STATIC
          ? [
              `We hold no personal data about you${AI_CLOUD ? ", apart from the hour-long, in-memory count of AI text per IP address described above" : ""}. What this site keeps in your browser (workflows, signatures, your language, your AI choice) is removed when you clear your browser data.`,
            ]
          : [
              "What this site keeps in your browser (workflows, signatures, your language) is removed when you clear your browser data. To have a message you sent through the contact form deleted, contact us.",
              "Depending on where you live you may have further rights, such as access, correction and objection. Contact us through the contact page to use them.",
            ],
      },
    ],
  },
  terms: {
    title: "Terms of use",
    intro: `By using ${BRAND.name} you agree to these terms.`,
    sections: [
      operator(`${BRAND.name} is run by ${OPERATOR.name}, based in ${OPERATOR.country}.`),
      {
        h: "Using the service",
        p: [
          "You may use the tools for any lawful purpose. Only process documents you have the right to process.",
          STATIC
            ? "Don't attempt to disrupt the service."
            : "Don't attempt to overload, probe or disrupt the service, or use the web page converter to reach systems you aren't allowed to access.",
        ],
      },
      {
        h: "Your content",
        p: ["You keep all rights to your files. We only handle them to perform the task you ask for, as described in the privacy policy."],
      },
      {
        h: "No warranty",
        p: [
          "The service is provided as is. We work to keep it accurate and available but can't guarantee that every conversion is perfect or that the service is uninterrupted. Keep your originals.",
        ],
      },
      {
        h: "Liability",
        p: ["To the extent the law allows, we aren't liable for indirect losses or for data loss arising from use of the service."],
      },
      {
        h: "Governing law",
        p: [`These terms are governed by the law of ${OPERATOR.country}. If you live elsewhere, you keep any protection the law of your own country gives you that an agreement can't take away.`],
      },
      {
        h: "Changes",
        p: ["We may update these terms. The date at the top shows the latest version."],
      },
    ],
  },
  cookies: {
    title: "Cookies",
    intro: "We use as little browser storage as possible, and none of it tracks you.",
    sections: [
      STATIC
        ? { h: "Cookies", p: ["This site doesn't set any cookies."] }
        : {
            h: "Cookies",
            p: ["We set one cookie, which is strictly necessary:"],
            list: ["locale: remembers the language you picked. Expires after a year."],
          },
      {
        h: "Local storage",
        p: [
          "Signatures and workflows you save, the language you picked and where the AI tools run, are kept in your browser's local storage on your device only. Clearing your browser data removes them.",
          "The installable app stores the site's code in your browser so the on-device tools work offline.",
        ],
      },
      {
        h: "No tracking",
        p: ["There are no advertising, analytics or social media cookies, so there's no consent banner."],
      },
    ],
  },
};
