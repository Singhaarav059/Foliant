"use client";

import { useMemo, useState } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, Copy, FilePlus2, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { PdfThumb } from "../PdfThumb";
import { useI18n } from "../I18n";
import { parseRanges } from "@/lib/pdf/common";
import type { ToolId } from "@/lib/tools";

export type PageItem = { key: string; file: number; page: number; rotate: number; blank?: boolean };

const FILE_TINTS = ["#cf4a24", "#3d6b8f", "#5a8a5c", "#b08a2e", "#7a5c8f", "#3f8a86", "#8f5a4a"];

function PageCard({
  item, files, index, mode, selected, onToggle, onRotate, onDelete, onDuplicate, onBlank, multiFile,
}: {
  item: PageItem; files: File[]; index: number; mode: ToolId; selected: boolean; multiFile: boolean;
  onToggle: () => void; onRotate: (d: number) => void; onDelete: () => void; onDuplicate: () => void; onBlank: () => void;
}) {
  const { t } = useI18n();
  const sortable = mode === "organize";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key, disabled: !sortable });
  const selectable = mode === "extract" || mode === "remove";
  const marked = selectable && selected;
  const tint = FILE_TINTS[item.file % FILE_TINTS.length];
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={`group relative flex flex-col items-center rounded-xl p-2 ${sortable ? "cursor-grab touch-none active:cursor-grabbing" : ""}`}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        onClick={selectable ? onToggle : undefined}
        tabIndex={selectable ? 0 : -1}
        aria-pressed={selectable ? selected : undefined}
        aria-label={t("ws.page", { n: index + 1 })}
        className={`relative grid h-[180px] w-[136px] place-items-center rounded-lg transition-[box-shadow] ${selectable ? "cursor-pointer" : "cursor-[inherit]"} ${marked ? (mode === "remove" ? "shadow-[0_0_0_3px_var(--danger)]" : "shadow-[0_0_0_3px_var(--accent)]") : "hover:shadow-[0_0_0_2px_var(--line-strong)]"} ${isDragging ? "shadow-card" : ""}`}
      >
        {item.blank ? (
          <div className="h-[170px] w-[120px] bg-white shadow-[0_0_0_1px_var(--line)]" style={{ transform: `rotate(${item.rotate}deg)` }} />
        ) : (
          <PdfThumb file={files[item.file]} page={item.page} width={120} rotate={item.rotate} />
        )}
        {marked && mode === "remove" && <span className="absolute inset-0 rounded-lg bg-[color-mix(in_oklab,var(--danger)_18%,transparent)]" />}
        {marked && (
          <span className={`absolute end-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full text-white ${mode === "remove" ? "bg-danger" : "bg-accent"}`}>
            {mode === "remove" ? <Trash2 size={13} /> : <Check size={14} strokeWidth={3} />}
          </span>
        )}
      </button>
      <p className="tabular mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
        {multiFile && <span className="h-2 w-2 rounded-full" style={{ background: tint }} />}
        {index + 1}
      </p>
      {(mode === "rotate" || mode === "organize") && (
        <div
          className="absolute left-1/2 top-[70px] flex -translate-x-1/2 gap-1 rounded-full border border-line bg-surface p-1 shadow-card opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button className="icon-btn h-8 w-8" aria-label={t("ws.rotateLeft")} title={t("ws.rotateLeft")} onClick={() => onRotate(-90)}><RotateCcw size={15} /></button>
          <button className="icon-btn h-8 w-8" aria-label={t("ws.rotateRight")} title={t("ws.rotateRight")} onClick={() => onRotate(90)}><RotateCw size={15} /></button>
          {mode === "organize" && (
            <>
              <button className="icon-btn h-8 w-8" aria-label={t("ws.duplicate")} title={t("ws.duplicate")} onClick={onDuplicate}><Copy size={15} /></button>
              <button className="icon-btn h-8 w-8" aria-label={t("ws.insertBlank")} title={t("ws.insertBlank")} onClick={onBlank}><FilePlus2 size={15} /></button>
              <button className="icon-btn h-8 w-8 hover:text-danger" aria-label={t("ws.delete")} title={t("ws.delete")} onClick={onDelete}><Trash2 size={15} /></button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function PageBoard({
  mode, files, pages, setPages, selected, setSelected, toolbar,
}: {
  mode: ToolId; files: File[]; pages: PageItem[]; setPages: React.Dispatch<React.SetStateAction<PageItem[]>>;
  selected: Set<string>; setSelected: React.Dispatch<React.SetStateAction<Set<string>>>; toolbar?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [range, setRange] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = useMemo(() => pages.map((p) => p.key), [pages]);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = String(e.active.id), to = String(e.over.id);
    setPages((list) => arrayMove(list, list.findIndex((p) => p.key === from), list.findIndex((p) => p.key === to)));
  };
  const selectable = mode === "extract" || mode === "remove";
  const update = (key: string, fn: (p: PageItem) => PageItem) => setPages((list) => list.map((p) => (p.key === key ? fn(p) : p)));
  const insertAfter = (key: string, item: PageItem) =>
    setPages((list) => {
      const i = list.findIndex((p) => p.key === key);
      return [...list.slice(0, i + 1), item, ...list.slice(i + 1)];
    });
  const applyRange = (value: string) => {
    setRange(value);
    const picked = new Set(parseRanges(value, pages.length).flat().map((i) => pages[i].key));
    setSelected(picked);
  };
  const hint = mode === "remove" ? t("ws.pickPagesRemove") : mode === "rotate" ? t("ws.pickPagesRotate") : mode === "organize" ? t("ws.dragToReorder") : t("ws.pickPages");

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {toolbar}
        {selectable && (
          <>
            <input
              className="field h-9 w-40 text-[14px]"
              placeholder="1-3, 7"
              aria-label={t("opt.pageRange")}
              value={range}
              onChange={(e) => applyRange(e.target.value)}
            />
            <button className="btn btn-quiet btn-sm" onClick={() => setSelected(new Set(ids))}>{t("ws.selectAll")}</button>
            <button className="btn btn-quiet btn-sm" onClick={() => setSelected((cur) => new Set(ids.filter((k) => !cur.has(k))))}>{t("ws.invert")}</button>
            <button className="btn btn-quiet btn-sm" onClick={() => { setSelected(new Set()); setRange(""); }}>{t("ws.selectNone")}</button>
            <span className="tabular text-[14px] text-muted">{t("ws.selected", { n: selected.size })}</span>
          </>
        )}
        {(mode === "rotate" || mode === "organize") && (
          <>
            <button className="btn btn-quiet btn-sm" onClick={() => setPages((list) => list.map((p) => ({ ...p, rotate: (p.rotate + 270) % 360 })))}>
              <RotateCcw size={16} /> {t("ws.rotateLeft")}
            </button>
            <button className="btn btn-quiet btn-sm" onClick={() => setPages((list) => list.map((p) => ({ ...p, rotate: (p.rotate + 90) % 360 })))}>
              <RotateCw size={16} /> {t("ws.rotateRight")}
            </button>
          </>
        )}
      </div>
      <p className="mb-3 text-[14px] text-muted">{hint}</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(152px,1fr))] gap-1">
            {pages.map((p, i) => (
              <PageCard
                key={p.key}
                item={p}
                index={i}
                files={files}
                mode={mode}
                multiFile={files.length > 1}
                selected={selected.has(p.key)}
                onToggle={() =>
                  setSelected((cur) => {
                    const next = new Set(cur);
                    if (next.has(p.key)) next.delete(p.key);
                    else next.add(p.key);
                    return next;
                  })
                }
                onRotate={(d) => update(p.key, (x) => ({ ...x, rotate: (x.rotate + d + 360) % 360 }))}
                onDelete={() => setPages((list) => list.filter((x) => x.key !== p.key))}
                onDuplicate={() => insertAfter(p.key, { ...p, key: crypto.randomUUID() })}
                onBlank={() => insertAfter(p.key, { key: crypto.randomUUID(), file: p.file, page: p.page, rotate: 0, blank: true })}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}
