"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useI18n } from "../I18n";
import { defaultRanges, rangesPreview } from "@/lib/pdf/split-plan";
import { pageCount } from "@/lib/pdf/thumbs";
import { defaultOptions, type Tool } from "@/lib/tools";

type Values = Record<string, unknown>;

// Split PDF: once the file's page count is known, ranges the user hasn't
// typed are fitted to it ("1-2, 3" for three pages), and a line under the
// ranges or page count lists the files the split will make. Returns that
// line keyed by the option it goes under, for Options' `notes`.
export function useSplitHints(tool: Tool, file: File | undefined, values: Values, setValues: Dispatch<SetStateAction<Values>>) {
  const { t } = useI18n();
  const split = tool.id === "split";
  const [pages, setPages] = useState<{ file: File; n: number } | null>(null);
  // The ranges filled in for the user: the tool's default, then ones fitted to a file.
  const fitted = useRef(split ? String(defaultOptions(tool).ranges ?? "") : "");

  useEffect(() => {
    if (!split || !file) return;
    let live = true;
    pageCount(file).then((n) => {
      if (!live) return;
      setPages({ file, n });
      const before = fitted.current;
      const next = defaultRanges(n);
      fitted.current = next;
      setValues((o) => (o.ranges === before ? { ...o, ranges: next } : o));
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [split, file, setValues]);

  if (!split || !pages || pages.file !== file) return undefined;
  const list = rangesPreview(values, pages.n);
  if (!list) return undefined;
  const shown = list.length > 8 ? [...list.slice(0, 8), "…"] : list;
  const text = !list.length ? t("split.preview.none")
    : t(list.length === 1 ? "split.preview.one" : "split.preview.other", { n: list.length, list: shown.join(", ") });
  return { [values.splitMode === "every" ? "every" : "ranges"]: text };
}
