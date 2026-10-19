// The phone scanner's geometry in src/lib/pdf/quad.ts: finding the page's four
// corners in a camera frame, the homography, the page's true shape, the warp,
// auto-rotation and the enhancement looks. Each photo is synthetic: a page with
// text-like lines placed with a known homography onto a noisy, textured table.
//
//   node tests/scanner-quad.mjs
import { applyH, detectQuad, enhance, homography, pageSize, rotate, textTurn, warp } from "../src/lib/pdf/quad.ts";
import { PH, PW, gauss, pageInk, photo, project, rng } from "./lib/scan-scene.mjs";

let failed = 0;
async function test(name, fn) {
  try {
    const note = await fn();
    console.log(`ok   ${name}${note ? ` (${note})` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

const diag = (img) => Math.hypot(img.width, img.height);
const cornerError = (got, want) => Math.max(...want.map((p, i) => Math.hypot(got[i].x - p.x, got[i].y - p.y)));
const q = (...xy) => [0, 2, 4, 6].map((i) => ({ x: xy[i], y: xy[i + 1] }));

const CASES = [
  { name: "straight on, centred", corners: project({}) },
  { name: "tilted towards the camera (keystone)", corners: project({ tilt: 30 }) },
  { name: "rotated 25 degrees and tilted", corners: project({ roll: 25, tilt: 12, at: [0, 0, 430] }) },
  { name: "skewed and off-centre", corners: project({ tilt: 15, yaw: 22, at: [-100, 10, 430] }) },
  { name: "small page, far away", corners: project({ tilt: 8, roll: -4, at: [40, 20, 800] }), noise: 12 },
  { name: "light table, low contrast", corners: project({ tilt: 10, roll: -5 }), table: [185, 180, 172] },
  { name: "cluttered table", corners: project({ yaw: -12, roll: 4, at: [10, 0, 420] }), clutter: 14, seed: 7 },
];

for (const c of CASES) {
  await test(`corners: ${c.name}`, () => {
    const img = photo(c);
    const got = detectQuad(img);
    if (!got) throw new Error("no page found");
    const err = cornerError(got, c.corners) / diag(img);
    if (err >= 0.02) throw new Error(`worst corner is ${(err * 100).toFixed(2)}% of the diagonal away; got ${JSON.stringify(got.map((p) => [Math.round(p.x), Math.round(p.y)]))}`);
    return `${(err * 100).toFixed(2)}% of the diagonal`;
  });
}

await test("a frame with no page in it gives no corners", () => {
  const r = rng(3);
  const w = 640, h = 480, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    const v = 90 + 14 * Math.sin(i / 4 / 7) + gauss(r) * 10;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  const got = detectQuad({ data, width: w, height: h });
  if (got) throw new Error(`found ${JSON.stringify(got)}`);
});

await test("homography maps the four corners exactly and round-trips", () => {
  const a = q(0, 0, 100, 0, 100, 140, 0, 140);
  const b = q(13, 7, 120, 30, 98, 170, 2, 150);
  const h = homography(a, b);
  for (let i = 0; i < 4; i++) {
    const p = applyH(h, a[i]);
    if (Math.hypot(p.x - b[i].x, p.y - b[i].y) > 1e-6) throw new Error(`corner ${i} → ${p.x},${p.y}`);
  }
  const back = homography(b, a);
  const p = applyH(back, applyH(h, { x: 37, y: 91 }));
  if (Math.hypot(p.x - 37, p.y - 91) > 1e-6) throw new Error(`round trip gave ${p.x},${p.y}`);
});

// The page's shape from a perspective view, without knowing the camera.
for (const c of CASES.slice(0, 4)) {
  await test(`page shape: ${c.name} is A4 within 3%, from the detected corners`, () => {
    const s = pageSize(detectQuad(photo(c)), 960, 720);
    const off = Math.abs(s.width / s.height / (PW / PH) - 1);
    if (off > 0.03) throw new Error(`${s.width} × ${s.height} is ${(off * 100).toFixed(1)}% off A4`);
    return `${(off * 100).toFixed(2)}% off`;
  });
}

await test("warp: the detected page comes out flat, its text lines where the page has them", () => {
  const c = CASES[2];
  const img = photo(c);
  const out = warp(img, detectQuad(img), 420, 594);
  // Compare ink against the page drawing, cell by cell (each 2 page units).
  let agree = 0, total = 0;
  for (let y = 2; y < 594 - 2; y += 3) {
    for (let x = 2; x < 420 - 2; x += 3) {
      const i = (y * 420 + x) * 4;
      const dark = out.data[i] + out.data[i + 1] + out.data[i + 2] < 3 * 140;
      const ink = pageInk((x + 0.5) * (PW / 420), (y + 0.5) * (PH / 594));
      // Skip pixels right on a line's edge, where blur decides.
      const nearEdge = [[-1.2, 0], [1.2, 0], [0, -1.2], [0, 1.2]].some(([dx, dy]) => pageInk((x + 0.5) * (PW / 420) + dx, (y + 0.5) * (PH / 594) + dy) !== ink);
      if (nearEdge) continue;
      total++;
      if (dark === !!ink) agree++;
    }
  }
  const share = agree / total;
  if (share < 0.97) throw new Error(`only ${(share * 100).toFixed(1)}% of the page matches`);
  return `${(share * 100).toFixed(1)}% match`;
});

await test("auto-rotate: text running down the page asks for a quarter turn, upright text doesn't", () => {
  const upright = photo({ w: 420, h: 594, corners: q(0, 0, 420, 0, 420, 594, 0, 594), noise: 4 });
  const sideways = photo({ w: 420, h: 594, corners: q(0, 0, 420, 0, 420, 594, 0, 594), noise: 4, turned: true });
  if (textTurn(upright) !== 0) throw new Error("upright page turned");
  if (textTurn(sideways) === 0) throw new Error("sideways page not turned");
  const turned = rotate(sideways, textTurn(sideways));
  if (turned.width !== 594 || turned.height !== 420) throw new Error(`rotated to ${turned.width} × ${turned.height}`);
  if (textTurn(turned) !== 0) throw new Error("still sideways after the turn");
});

await test("enhance: B/W is pure black and white and keeps the text under uneven light", () => {
  const img = photo({ w: 420, h: 594, corners: q(0, 0, 420, 0, 420, 594, 0, 594), noise: 6 });
  // A shadow across the page: the left edge gets under half the light.
  for (let y = 0; y < 594; y++) for (let x = 0; x < 420; x++) for (let k = 0; k < 3; k++) img.data[(y * 420 + x) * 4 + k] *= 0.4 + 0.6 * (x / 420);
  const bw = enhance(img, "bw");
  let grey = 0, ink = 0, paper = 0, inked = 0;
  for (let y = 0; y < 594; y++) {
    for (let x = 0; x < 420; x++) {
      const i = (y * 420 + x) * 4;
      const v = bw.data[i];
      if (v !== 0 && v !== 255) grey++;
      if (bw.data[i + 1] !== v || bw.data[i + 2] !== v) grey++;
      const want = pageInk((x + 0.5) / 2, (y + 0.5) / 2);
      if (want) { inked++; if (v === 0) ink++; } else if (v === 255) paper++;
    }
  }
  if (grey) throw new Error(`${grey} pixels are neither black nor white`);
  const paperShare = paper / (420 * 594 - inked), inkShare = ink / inked;
  if (paperShare < 0.97 || inkShare < 0.8) throw new Error(`paper ${(paperShare * 100).toFixed(1)}% white, ink ${(inkShare * 100).toFixed(1)}% black`);
  return `paper ${(paperShare * 100).toFixed(1)}% white, ink ${(inkShare * 100).toFixed(1)}% black`;
});

await test("enhance: greyscale has equal channels, colour keeps colour", () => {
  const img = { data: new Uint8ClampedArray([200, 40, 40, 255, 40, 200, 40, 255, 250, 250, 250, 255, 20, 20, 20, 255]), width: 2, height: 2 };
  const g = enhance(img, "grayscale");
  for (let i = 0; i < 16; i += 4) if (g.data[i] !== g.data[i + 1] || g.data[i] !== g.data[i + 2]) throw new Error("channels differ");
  const c = enhance(img, "color");
  if (!(c.data[0] > c.data[1] + 60)) throw new Error(`red became ${c.data.slice(0, 3)}`);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
