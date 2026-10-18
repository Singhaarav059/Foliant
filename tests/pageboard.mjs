// The page board's list operations (src/lib/pageplan.ts): Shift-click
// ranges, interleaving files, reversing, sorting, splitting Rotate's pages by
// file, and picking pages by orientation.
//
//   node tests/pageboard.mjs
import { rangeKeys, interleave, reverse, sortByOriginal, byFile, byOrientation } from "../src/lib/pageplan.ts";

let failed = 0;
const test = (label, fn) => {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label}  ${e.message}`);
  }
};
const eq = (got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};
const page = (file, n, extra = {}) => ({ key: `${"AB"[file]}${n + 1}`, file, page: n, rotate: 0, ...extra });
const keys = (list) => list.map((p) => p.key);
const a = [0, 1, 2].map((n) => page(0, n));
const b = [0, 1, 2].map((n) => page(1, n));
const six = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];

test("Shift-click from page 2 to page 6 covers 5 pages", () => eq(rangeKeys(six, "p2", "p6"), ["p2", "p3", "p4", "p5", "p6"]));
test("a range works backwards too", () => eq(rangeKeys(six, "p6", "p2"), ["p2", "p3", "p4", "p5", "p6"]));
test("with no earlier click, only the clicked page", () => eq(rangeKeys(six, undefined, "p4"), ["p4"]));
test("an anchor that has gone counts as no anchor", () => eq(rangeKeys(six, "gone", "p4"), ["p4"]));

test("interleaving two 3-page files gives A1, B1, A2, B2, A3, B3", () => eq(keys(interleave([...a, ...b])), ["A1", "B1", "A2", "B2", "A3", "B3"]));
test("a longer file's extra pages go at the end", () => eq(keys(interleave([...a, b[0]])), ["A1", "B1", "A2", "A3"]));
test("interleaving keeps each file's current order", () => eq(keys(interleave([a[2], a[0], b[1], a[1], b[0]])), ["A3", "B2", "A1", "B1", "A2"]));
test("one file is left as it is", () => eq(keys(interleave([a[1], a[0]])), ["A2", "A1"]));

test("reverse", () => eq(keys(reverse([...a, ...b])), ["B3", "B2", "B1", "A3", "A2", "A1"]));
test("reverse leaves the list it was given alone", () => {
  const list = [...a];
  reverse(list);
  eq(keys(list), ["A1", "A2", "A3"]);
});

test("sort puts pages back in file and page order", () => eq(keys(sortByOriginal([b[1], a[2], b[0], a[0], a[1], b[2]])), ["A1", "A2", "A3", "B1", "B2", "B3"]));
test("sort keeps a blank page after the page it was inserted from", () => {
  const blank = { key: "blank", file: 0, page: 1, rotate: 0, blank: true };
  eq(keys(sortByOriginal([a[2], a[1], blank, a[0]])), ["A1", "A2", "blank", "A3"]);
});

test("Rotate's pages are split by file, renumbered to that file alone", () => {
  const groups = byFile([...a, b[0], { ...b[1], rotate: 90 }], 2);
  eq(groups.map(keys), [["A1", "A2", "A3"], ["B1", "B2"]]);
  eq(groups[1].map((p) => p.file), [0, 0]);
  eq(groups[1][1].rotate, 90);
});
test("a file with no pages left gives an empty group", () => eq(byFile(a, 2).map(keys), [["A1", "A2", "A3"], []]));

const sizes = [[{ w: 600, h: 800 }, { w: 800, h: 600 }, { w: 500, h: 500 }], [{ w: 842, h: 595 }, { w: 595, h: 842 }, { w: 595, h: 842 }]];
test("portrait pages", () => eq(byOrientation([...a, ...b], sizes, "portrait"), ["A1", "B2", "B3"]));
test("landscape pages", () => eq(byOrientation([...a, ...b], sizes, "landscape"), ["A2", "B1"]));
test("a blank page takes the shape of the page it was inserted from", () =>
  eq(byOrientation([{ key: "blank", file: 1, page: 0, rotate: 0, blank: true }], sizes, "landscape"), ["blank"]));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
