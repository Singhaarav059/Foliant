// Synthetic camera frames for the scanner tests: an A4 page with text-like
// lines, seen by a pinhole camera, on a noisy, textured table. Used by
// tests/scanner-quad.mjs and tests/e2e/scanner.mjs.
import { applyH, homography } from "../../src/lib/pdf/quad.ts";

// Deterministic noise, so a failure can be reproduced.
export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
export const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

// The page: white paper, a margin, then dark "text lines" of varying length.
// Coordinates are in page units (0..PW, 0..PH), A4 shaped.
export const PW = 210, PH = 297;
export function pageInk(u, v) {
  if (u < 20 || u > PW - 20 || v < 25 || v > PH - 25) return 0;
  const line = Math.floor((v - 25) / 9);
  if ((v - 25) % 9 > 3.2) return 0;
  const len = PW - 40 - ((line * 37) % 60);
  return u - 20 < len && Math.floor((u - 20) / 7) % 6 !== 5 ? 1 : 0;
}

// Renders a photo: the page through `h` (page → image), on a table.
export function photo({ w = 960, h = 720, corners, paper = [244, 240, 232], table = [96, 78, 60], noise = 8, clutter = 0, seed = 1, turned = false }) {
  const r = rng(seed);
  const page = [{ x: 0, y: 0 }, { x: PW, y: 0 }, { x: PW, y: PH }, { x: 0, y: PH }];
  const inv = homography(corners, page);
  const data = new Uint8ClampedArray(w * h * 4);
  const blobs = Array.from({ length: clutter }, () => ({ x: r() * w, y: r() * h, rad: 10 + r() * 40, c: 40 + r() * 120 }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = applyH(inv, { x: x + 0.5, y: y + 0.5 });
      let c;
      if (p.x >= 0 && p.x <= PW && p.y >= 0 && p.y <= PH) {
        const ink = turned ? pageInk(p.y * (PW / PH), (PW - p.x) * (PH / PW)) : pageInk(p.x, p.y);
        // Light falls off towards one side, as under a lamp.
        const shade = 1 - 0.18 * (x / w);
        c = paper.map((v) => (ink ? 35 : v * shade));
      } else {
        const grain = 14 * Math.sin(x / 7 + Math.sin(y / 23) * 3);
        c = table.map((v) => v + grain);
        for (const b of blobs) if ((x - b.x) ** 2 + (y - b.y) ** 2 < b.rad ** 2) c = [b.c, b.c * 0.9, b.c * 0.8];
      }
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = c[k] + gauss(r) * noise;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

// A camera looking at the page: the page (in mm) is turned by `tilt` (about
// the x axis), `yaw` (y) and `roll` (z), moved to `at`, and projected with
// focal length `f` around the frame's centre, as a phone camera would see it.
// The default `f` is a phone's main camera (26 mm equivalent, 0.78 × the long
// side), the lens quad.ts pageSize assumes when one view can't measure it.
export function project({ tilt = 0, yaw = 0, roll = 0, at = [0, 0, 400] }, w = 960, h = 720, f = 0.78 * Math.max(w, h)) {
  const rad = Math.PI / 180;
  const [a, b, c] = [tilt * rad, yaw * rad, roll * rad];
  const rx = (p) => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
  const ry = (p) => [p[0] * Math.cos(b) + p[2] * Math.sin(b), p[1], -p[0] * Math.sin(b) + p[2] * Math.cos(b)];
  const rz = (p) => [p[0] * Math.cos(c) - p[1] * Math.sin(c), p[0] * Math.sin(c) + p[1] * Math.cos(c), p[2]];
  return [[0, 0], [PW, 0], [PW, PH], [0, PH]].map(([u, v]) => {
    const p = rz(ry(rx([u - PW / 2, v - PH / 2, 0])));
    const [X, Y, Z] = [p[0] + at[0], p[1] + at[1], p[2] + at[2]];
    return { x: (f * X) / Z + w / 2, y: (f * Y) / Z + h / 2 };
  });
}

