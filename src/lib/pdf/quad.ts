// The phone scanner's image geometry (Scanner.tsx), all on the device and
// without OpenCV. It follows the method jscanify (MIT) runs on OpenCV:
//   1. shrink the frame and blur it
//   2. Canny edges (Sobel, thinning, two thresholds)
//   3. take connected edge outlines, and the bright paper region, as
//      candidates; each one's convex hull is cut down to four corners
//   4. keep the candidate whose sides lie best on edges, then fit a straight
//      line to the edge pixels along each side and intersect them
// Then a homography warps the page flat, at the shape the page really has
// (Zhang and He's whiteboard method recovers it from one view), and the
// "looks" clean it up.
//
// Every function here works on plain RGBA arrays, so the Node tests
// (tests/scanner-quad.mjs) run it as it runs in the browser.

export type Pt = { x: number; y: number };
/** Top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];
export type Raster = { data: Uint8ClampedArray; width: number; height: number };
export type Look = "color" | "grayscale" | "bw";

// Detection runs on a frame shrunk to this many pixels on its long side.
const WORK = 400;
// Canny thresholds on the blurred 0–255 greys (Sobel magnitude).
const HIGH = 44;
const LOW = 20;

// ── Corner detection

export function detectQuad(img: Raster): Quad | null {
  const scale = Math.min(1, WORK / Math.max(img.width, img.height));
  const { g, w, h } = shrinkGrey(img, scale);
  const blurred = blur(g, w, h);
  const { ridge, gx, gy, mag } = canny(blurred, w, h);
  const edge = hysteresis(ridge, mag, w, LOW, HIGH);
  // Outlines at rising thresholds: a page whose outline touches the table's
  // texture at one threshold usually stands alone at a higher one.
  const candidates: Pt[][] = [];
  for (const k of [1, 1.7, 2.8]) {
    const e = k === 1 ? edge : hysteresis(ridge, mag, w, LOW * k, HIGH * k);
    candidates.push(...components(dilate(e, w, h), w, h, true));
  }
  candidates.push(...brightRegions(blurred, w, h));

  let best: { q: Pt[]; score: number } | null = null;
  for (const pts of candidates) {
    const hull = convexHull(pts);
    if (hull.length < 4) continue;
    const rough = toFour(hull);
    if (!plausible(rough, w, h)) continue;
    const q = refine(rough, edge, gx, gy, mag, w, h) ?? rough;
    if (!plausible(q, w, h)) continue;
    const s = support(q, edge, gx, gy, mag, w, h);
    if (s < 0.7) continue;
    const score = polyArea(q) * s ** 4;
    if (!best || score > best.score) best = { q, score };
  }
  if (!best) return null;

  const step = 1 / scale;
  return order(best.q.map((p) => ({ x: (p.x + 0.5) * step, y: (p.y + 0.5) * step })));
}

// Area-averaged luminance at `scale` (≤ 1).
function shrinkGrey(img: Raster, scale: number) {
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const sum = new Float32Array(w * h);
  const count = new Float32Array(w * h);
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / img.height)) * w;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const t = ty + Math.min(w - 1, Math.floor((x * w) / img.width));
      sum[t] += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      count[t]++;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] /= count[i] || 1;
  return { g: sum, w, h };
}

// Binomial 5-tap blur (close to a Gaussian with sigma 1), edges clamped.
function blur(src: Float32Array, w: number, h: number) {
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let j = -2; j <= 2; j++) a += k[j + 2] * src[y * w + Math.min(w - 1, Math.max(0, x + j))];
      tmp[y * w + x] = a / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let j = -2; j <= 2; j++) a += k[j + 2] * tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x];
      out[y * w + x] = a / 16;
    }
  }
  return out;
}

function canny(g: Float32Array, w: number, h: number) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
      gx[i] = c + 2 * f + r - a - 2 * d - p;
      gy[i] = p + 2 * q + r - a - 2 * b - c;
      mag[i] = Math.hypot(gx[i], gy[i]);
    }
  }
  // Thin each edge to the pixels that are a maximum across it.
  const ridge = new Uint8Array(w * h);
  const T = Math.tan(Math.PI / 8);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < LOW) continue;
      const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
      let o: number;
      if (ay <= ax * T) o = 1;
      else if (ax <= ay * T) o = w;
      else o = gx[i] * gy[i] > 0 ? w + 1 : w - 1;
      if (m >= mag[i - o] && m > mag[i + o]) ridge[i] = 1;
    }
  }
  return { ridge, gx, gy, mag };
}

// Canny's two thresholds: ridge pixels at least `low` strong, kept only where
// they connect to one at least `high` strong.
function hysteresis(ridge: Uint8Array, mag: Float32Array, w: number, low: number, high: number) {
  const edge = new Uint8Array(ridge.length);
  const stack: number[] = [];
  for (let i = 0; i < ridge.length; i++) if (ridge[i] && mag[i] >= high) { edge[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!;
    for (const o of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) {
      const j = i + o;
      if (ridge[j] && !edge[j] && mag[j] >= low) { edge[j] = 1; stack.push(j); }
    }
  }
  return edge;
}

function dilate(src: Uint8Array, w: number, h: number) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

// Connected regions of set pixels that span a fair part of the frame, each as
// the leftmost and rightmost pixel of every row (enough for its hull).
function components(mask: Uint8Array, w: number, h: number, eight: boolean): Pt[][] {
  const seen = new Uint8Array(w * h);
  const out: Pt[][] = [];
  const steps = eight ? [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1] : [-w, -1, 1, w];
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    seen[s] = 1;
    stack.push(s);
    const left = new Map<number, number>();
    const right = new Map<number, number>();
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (!left.has(y) || x < left.get(y)!) left.set(y, x);
      if (!right.has(y) || x > right.get(y)!) right.set(y, x);
      for (const o of steps) {
        const j = i + o;
        if (j < 0 || j >= mask.length || seen[j] || !mask[j]) continue;
        // Don't wrap from one row's end to the next row's start.
        if (Math.abs((j % w) - x) > 1) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (x1 - x0 < w * 0.15 || y1 - y0 < h * 0.15) continue;
    const pts: Pt[] = [];
    for (const [y, x] of left) pts.push({ x, y });
    for (const [y, x] of right) pts.push({ x, y });
    out.push(pts);
  }
  return out;
}

// The biggest region brighter than Otsu's threshold (white paper on a darker
// table, even where its outline is too faint for edges), and the same for a
// threshold halfway from there to the brightest greys.
function brightRegions(g: Float32Array, w: number, h: number): Pt[][] {
  const hist = new Float64Array(256);
  for (const v of g) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const t = otsu(hist, g.length);
  let top = 255;
  for (let n = 0; top > 0 && n + hist[top] < g.length * 0.01; top--) n += hist[top];
  const out: Pt[][] = [];
  for (const cut of [t, (t + top) / 2]) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) mask[i] = g[i] > cut ? 1 : 0;
    let best: Pt[] | null = null, bestArea = 0;
    for (const pts of components(mask, w, h, false)) {
      const a = polyArea(convexHull(pts));
      if (a > bestArea) { bestArea = a; best = pts; }
    }
    if (best) out.push(best);
  }
  return out;
}

function otsu(hist: Float64Array, total: number) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

// Andrew's monotone chain, counter-clockwise in y-down coordinates.
function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Drops hull corners one at a time, always the one whose removal loses the
// least area, until four are left.
function toFour(hull: Pt[]): Pt[] {
  const p = [...hull];
  const tri = (a: Pt, b: Pt, c: Pt) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  while (p.length > 4) {
    let k = 0, least = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = tri(p[(i + p.length - 1) % p.length], p[i], p[(i + 1) % p.length]);
      if (a < least) { least = a; k = i; }
    }
    p.splice(k, 1);
  }
  return p;
}

function polyArea(p: Pt[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a) / 2;
}

// Convex, a twentieth of the frame or more, and no corner sharper than 30° or
// flatter than 150°: a sheet of paper seen by a camera.
function plausible(q: Pt[], w: number, h: number) {
  if (q.length !== 4 || polyArea(q) < 0.05 * w * h) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
    const cr = ux * vy - uy * vx;
    if (!sign) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
    const angle = (Math.acos((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))) * 180) / Math.PI;
    if (!(angle > 30 && angle < 150)) return false;
  }
  return true;
}

// The share of points along the quad's sides with an edge running the same
// way within 2 pixels.
function support(q: Pt[], edge: Uint8Array, gx: Float32Array, gy: Float32Array, mag: Float32Array, w: number, h: number) {
  let on = 0, total = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const n = Math.max(8, Math.round(len));
    for (let k = 1; k < n; k++) {
      const x = Math.round(a.x + ((b.x - a.x) * k) / n), y = Math.round(a.y + ((b.y - a.y) * k) / n);
      total++;
      search: for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (edge[j] && Math.abs(gx[j] * nx + gy[j] * ny) > 0.8 * mag[j]) { on++; break search; }
        }
      }
    }
  }
  return total ? on / total : 0;
}

// Fits a straight line to the edge pixels along each side (weighted by edge
// strength, only those whose gradient crosses the side), twice with a
// narrowing band, and intersects neighbouring lines for sub-pixel corners.
function refine(q: Pt[], edge: Uint8Array, gx: Float32Array, gy: Float32Array, mag: Float32Array, w: number, h: number): Pt[] | null {
  const lines: [number, number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
    let line: [number, number, number] = [-dy, dx, -dy * a.x + dx * a.y];
    for (const band of [6, 3, 1.5]) {
      const [nx, ny, c] = line;
      const x0 = Math.max(1, Math.floor(Math.min(a.x, b.x) - band - 1)), x1 = Math.min(w - 2, Math.ceil(Math.max(a.x, b.x) + band + 1));
      const y0 = Math.max(1, Math.floor(Math.min(a.y, b.y) - band - 1)), y1 = Math.min(h - 2, Math.ceil(Math.max(a.y, b.y) + band + 1));
      let sw = 0, sx = 0, sy = 0;
      const pts: number[] = [];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const k = y * w + x;
          if (!edge[k]) continue;
          if (Math.abs(nx * x + ny * y - c) > band) continue;
          const t = ((x - a.x) * dx + (y - a.y) * dy) / len;
          if (t < 0.06 || t > 0.94) continue;
          if (Math.abs(gx[k] * nx + gy[k] * ny) < 0.85 * mag[k]) continue;
          const wt = mag[k];
          sw += wt; sx += wt * x; sy += wt * y;
          pts.push(x, y, wt);
        }
      }
      if (pts.length < 3 * 8) return null;
      const mx = sx / sw, my = sy / sw;
      let cxx = 0, cxy = 0, cyy = 0;
      for (let j = 0; j < pts.length; j += 3) {
        const ex = pts[j] - mx, ey = pts[j + 1] - my, wt = pts[j + 2];
        cxx += wt * ex * ex; cxy += wt * ex * ey; cyy += wt * ey * ey;
      }
      // Direction of the line: the covariance's main eigenvector.
      const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const ux = Math.cos(theta), uy = Math.sin(theta);
      line = [-uy, ux, -uy * mx + ux * my];
    }
    lines.push(line);
  }
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const [a1, b1, c1] = lines[(i + 3) % 4], [a2, b2, c2] = lines[i];
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-9) return null;
    const p = { x: (c1 * b2 - c2 * b1) / det, y: (a1 * c2 - a2 * c1) / det };
    // A fit that moves a corner far off its rough position went wrong.
    if (Math.hypot(p.x - q[i].x, p.y - q[i].y) > 0.05 * Math.hypot(w, h)) return null;
    out.push(p);
  }
  return out;
}

/** Puts four corners in top-left, top-right, bottom-right, bottom-left order. */
export function order(points: Pt[]): Quad {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const p = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (p[i].x + p[i].y < p[start].x + p[start].y) start = i;
  return [0, 1, 2, 3].map((i) => p[(start + i) % 4]) as Quad;
}

// ── Homography and page shape

/** The 3×3 matrix (row-major, last entry 1) taking each `from` corner to its `to` corner. */
export function homography(from: Pt[], to: Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((row, i) => row[8] / (row[i] || 1e-12)), 1];
}

export function applyH(m: number[], p: Pt): Pt {
  const z = m[6] * p.x + m[7] * p.y + m[8];
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / z, y: (m[3] * p.x + m[4] * p.y + m[5]) / z };
}

/**
 * The flattened page's size in pixels: its width-to-height ratio comes from
 * the perspective (Zhang & He, "Whiteboard scanning and image enhancement",
 * 2007, assuming the frame's centre is the camera's axis), and it keeps about
 * as many pixels as the page has in the frame, up to `maxSide`.
 */
export function pageSize(q: Pt[], frameW: number, frameH: number, maxSide = 3000) {
  const [tl, tr, br, bl] = q;
  const len = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const across = Math.max(len(tl, tr), len(bl, br));
  const down = Math.max(len(tl, bl), len(tr, br));
  let ratio = across / down;

  const m = (p: Pt) => [p.x - frameW / 2, p.y - frameH / 2, 1];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [m1, m2, m3, m4] = [m(tl), m(tr), m(bl), m(br)];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  const long = Math.max(frameW, frameH);
  let f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  // With a pair of sides parallel in the frame the focal length can't be
  // measured, and near that it is unstable: then assume a phone camera's
  // (26 mm equivalent: about 65 degrees across the long side).
  const measurable = Math.min(Math.abs(k2 - 1), Math.abs(k3 - 1)) > 0.05;
  if (!(measurable && Number.isFinite(f2) && f2 > (0.4 * long) ** 2 && f2 < (3 * long) ** 2)) f2 = (0.78 * long) ** 2;
  const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2 + f2 * n2[2] ** 2) / (n3[0] ** 2 + n3[1] ** 2 + f2 * n3[2] ** 2));
  // Trust it unless it is far from what the sides say.
  if (Number.isFinite(r) && r > ratio / 2 && r < ratio * 2) ratio = r;
  let height = Math.max(down, across / ratio);
  let width = height * ratio;
  const big = Math.max(width, height) / maxSide;
  if (big > 1) { width /= big; height /= big; }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/** Warps the quad's inside to a `width` × `height` image (bilinear). */
export function warp(img: Raster, q: Pt[], width: number, height: number): Raster {
  const m = homography([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }], q);
  const out = new Uint8ClampedArray(width * height * 4);
  const { data: d, width: W, height: H } = img;
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const z = m[6] * px + m[7] * py + m[8];
      const sx = Math.min(W - 1, Math.max(0, (m[0] * px + m[1] * py + m[2]) / z - 0.5));
      const sy = Math.min(H - 1, Math.max(0, (m[3] * px + m[4] * py + m[5]) / z - 0.5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
      const o = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) {
        const top = d[i00 + k] + (d[i10 + k] - d[i00 + k]) * fx;
        const bottom = d[i01 + k] + (d[i11 + k] - d[i01 + k]) * fx;
        out[o + k] = top + (bottom - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

// ── Orientation

/**
 * How far (degrees clockwise) to turn a flattened page so its text reads
 * left to right: 0, 90, 180 or 270. Text lines show up as stripes in the
 * dark-pixel profile across them; the side where lines start together (the
 * left margin, as most text is ragged on the right) tells the direction.
 * Anything unclear is left as it is.
 */
export function textTurn(img: Raster): 0 | 90 | 180 | 270 {
  const scale = Math.min(1, 400 / Math.max(img.width, img.height));
  const { g, w, h } = shrinkGrey(img, scale);
  const sorted = Float32Array.from(g).sort();
  const paper = sorted[Math.floor(sorted.length * 0.9)];
  const ink = new Uint8Array(w * h);
  let total = 0;
  for (let i = 0; i < g.length; i++) if (g[i] < paper * 0.6) { ink[i] = 1; total++; }
  if (total < g.length * 0.005) return 0;
  const rows = new Float64Array(h), cols = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) { rows[y]++; cols[x]++; }
  // Stripiness: how much the profile jumps between neighbours, per ink pixel.
  const jumpy = (p: Float64Array) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.abs(p[i] - p[i - 1]); return s / total; };
  const sideways = jumpy(cols) > 1.6 * jumpy(rows);
  const upright = jumpy(rows) > 1.6 * jumpy(cols);
  if (!sideways && !upright) return 0;
  // Where each line starts and ends, along the reading axis.
  const ends = (lineCount: number, along: number, at: (line: number, k: number) => boolean) => {
    const first: number[] = [], last: number[] = [];
    for (let l = 0; l < lineCount; l++) {
      let a = -1, b = -1;
      for (let k = 0; k < along; k++) if (at(l, k)) { if (a < 0) a = k; b = k; }
      if (a >= 0 && b - a > along * 0.2) { first.push(a); last.push(b); }
    }
    if (first.length < 3) return 0;
    const spread = (v: number[]) => { const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) + 0.5; };
    const r = spread(last) / spread(first);
    return r > 2.5 ? 1 : r < 1 / 2.5 ? -1 : 0;
  };
  if (upright) {
    // Lines start together on the right: the page is upside down.
    return ends(h, w, (y, x) => !!ink[y * w + x]) < 0 ? 180 : 0;
  }
  const dir = ends(w, h, (x, y) => !!ink[y * w + x]);
  // Lines starting together at the top read downwards: turn anticlockwise.
  return dir > 0 ? 270 : dir < 0 ? 90 : 90;
}

/** Turns an image by 90, 180 or 270 degrees clockwise. */
export function rotate(img: Raster, degrees: number): Raster {
  const turn = ((Math.round(degrees / 90) % 4) + 4) % 4;
  if (!turn) return img;
  const { width: w, height: h, data: d } = img;
  const [ow, oh] = turn === 2 ? [w, h] : [h, w];
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      if (turn === 1) { nx = h - 1 - y; ny = x; }
      else if (turn === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      const i = (y * w + x) * 4, o = (ny * ow + nx) * 4;
      out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; out[o + 3] = d[i + 3];
    }
  }
  return { data: out, width: ow, height: oh };
}

// ── Looks

/**
 * colour: levels stretched so paper is white and ink is dark, colours kept;
 * greyscale: the same in grey; bw: black and white by an adaptive threshold
 * (Bradley and Roth: darker than 85% of its neighbourhood's mean is ink),
 * which keeps text under shadows and uneven light.
 */
export function enhance(img: Raster, look: Look): Raster {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const grey = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) grey[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const out = new Uint8ClampedArray(d.length);
  if (look === "bw") {
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += grey[y * w + x];
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
      }
    }
    const r = Math.max(7, Math.round(Math.max(w, h) / 32));
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
        const sum = integral[yb * (w + 1) + xb] - integral[ya * (w + 1) + xb] - integral[yb * (w + 1) + xa] + integral[ya * (w + 1) + xa];
        const mean = sum / ((xb - xa) * (yb - ya));
        const v = grey[y * w + x] < mean * 0.85 ? 0 : 255;
        const o = (y * w + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }
  const sorted = Float32Array.from(grey).sort();
  const lo = sorted[Math.floor((n - 1) * 0.02)], hi = sorted[Math.ceil((n - 1) * 0.98)];
  const k = 255 / Math.max(16, hi - lo);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    if (look === "grayscale") out[i] = out[i + 1] = out[i + 2] = (grey[j] - lo) * k;
    else for (let c = 0; c < 3; c++) out[i + c] = (d[i + c] - lo) * k;
    out[i + 3] = 255;
  }
  return { data: out, width: w, height: h };
}
