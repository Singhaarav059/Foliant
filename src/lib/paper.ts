// The paper-physics motion system: which action a tool's sheet performs
// (src/components/paper/*), whether this device gets the 3D scene, and the
// theme's colours for it.
import type { ToolId } from "./tools";

export type PaperAction = "merge" | "split" | "compress" | "seal" | "turn" | "convert" | "write" | "read";
export type PaperMode = "hero" | PaperAction;

const ACTIONS: Record<PaperAction, ToolId[]> = {
  merge: ["merge", "mix", "jpgToPdf", "booklet", "nUp", "scan", "attachments"],
  split: ["split", "extract", "remove", "removeBlank"],
  compress: ["compress", "linearize", "grayscale", "examKit", "repair", "flatten"],
  seal: ["protect", "unlock", "sign", "verify", "redact", "sanitize", "compare"],
  turn: ["rotate", "organize", "crop", "resize"],
  convert: ["wordToPdf", "pptToPdf", "excelToPdf", "htmlToPdf", "pdfToJpg", "pdfToWord", "pdfToPpt", "pdfToExcel", "pdfToPdfa", "pdfToMarkdown", "accessible"],
  write: ["edit", "watermark", "pageNumbers", "headerFooter", "forms", "metadata", "bookmarks"],
  read: ["ocr", "summarize", "chat", "listen", "translate"],
};

export function paperAction(tool: ToolId): PaperAction {
  for (const [action, tools] of Object.entries(ACTIONS) as [PaperAction, ToolId[]][]) if (tools.includes(tool)) return action;
  return "convert";
}

// Renderer names of WebGL drawn on the CPU (Chrome, Firefox and Edge without a usable GPU).
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i;

// The 3D scene runs on larger screens with motion allowed and WebGL drawn
// by a graphics card. Phones, reduced motion, data saver and software
// WebGL get the 2D version: drawn on the CPU, the scene takes the same
// processor the tools need (it slowed LibreOffice conversions to a stop
// on CI's GPU-less machines).
export function wants3d() {
  if (typeof window === "undefined") return false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !matchMedia("(min-width: 768px)").matches) return false;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  try {
    // Checked on a throwaway canvas, so a failure never reaches three.js (which logs it as an error).
    // failIfMajorPerformanceCaveat: no context where the browser would fall back to the CPU.
    const c = document.createElement("canvas");
    const opts = { failIfMajorPerformanceCaveat: true };
    const gl = (c.getContext("webgl2", opts) || c.getContext("webgl", opts)) as WebGLRenderingContext | null;
    if (!gl) return false;
    // Some browsers hand out a software context anyway: the renderer's name tells.
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !SOFTWARE.test(renderer);
  } catch {
    return false;
  }
}

export const reducedMotion = () => typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// The current theme's colours, read from the CSS tokens.
export function paperColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { bg: v("--bg"), surface: v("--surface"), surface2: v("--surface-2"), ink: v("--ink"), line: v("--line-strong"), accent: v("--accent") };
}
export type PaperColors = ReturnType<typeof paperColors>;

// Calls back when the theme changes: the device's setting or the header's choice.
export function onThemeChange(fn: () => void) {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const mo = new MutationObserver(fn);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  mq.addEventListener("change", fn);
  return () => {
    mo.disconnect();
    mq.removeEventListener("change", fn);
  };
}
