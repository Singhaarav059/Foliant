// Layer order of the items added in the editor. They are drawn in list order,
// so later ones are on top. Kept apart from edit.ts so the editor can use it
// without loading pdf-lib.

// Moves `id` one step up (1) or down (-1), past the next item on its page.
// Changes to the page's own text (textEdit) aren't layers and are skipped.
export function moveLayer<T extends { id: string; page: number; kind?: string }>(list: T[], id: string, step: 1 | -1): T[] {
  const at = list.findIndex((i) => i.id === id);
  if (at < 0 || list[at].kind === "textEdit") return list;
  let other = at + step;
  while (other >= 0 && other < list.length && (list[other].page !== list[at].page || list[other].kind === "textEdit")) other += step;
  if (other < 0 || other >= list.length) return list;
  const out = [...list];
  [out[at], out[other]] = [out[other], out[at]];
  return out;
}
