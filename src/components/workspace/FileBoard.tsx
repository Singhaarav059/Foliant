"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDownAZ, FileSpreadsheet, FileText, Presentation, X, Globe } from "lucide-react";
import { PdfThumb } from "../PdfThumb";
import { useI18n } from "../I18n";
import { fileExt, humanSize } from "@/lib/pdf/common";
import { pageCount } from "@/lib/pdf/thumbs";

export type Item = { id: string; file: File };

function Preview({ file }: { file: File }) {
  const ext = fileExt(file.name);
  const isImage = file.type.startsWith("image/");
  const url = useMemo(() => (isImage ? URL.createObjectURL(file) : null), [file, isImage]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  if (ext === "pdf") return <PdfThumb file={file} page={0} width={132} />;
  if (isImage && url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="max-h-[170px] w-[132px] object-contain" />;
  }
  const Icon = /xls|csv|ods/.test(ext) ? FileSpreadsheet : /ppt|odp/.test(ext) ? Presentation : /htm/.test(ext) ? Globe : FileText;
  return (
    <div className="grid h-[170px] w-[132px] place-items-center rounded bg-surface-2 text-muted">
      <div className="flex flex-col items-center gap-1">
        <Icon size={34} strokeWidth={1.6} />
        <span className="text-[12px] font-semibold uppercase">{ext}</span>
      </div>
    </div>
  );
}

function Pages({ file }: { file: File }) {
  const { t } = useI18n();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (fileExt(file.name) !== "pdf") return;
    pageCount(file).then(setN).catch(() => setN(null));
  }, [file]);
  return n ? <>{t("ws.pages", { n })} · </> : null;
}

function Card({ item, onRemove, sortable }: { item: Item; onRemove: () => void; sortable: boolean }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !sortable });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={`group relative flex w-[164px] flex-col items-center rounded-xl border bg-surface p-4 transition-[border-color,box-shadow] ${isDragging ? "border-brand shadow-card" : "border-line"} ${sortable ? "cursor-grab touch-none active:cursor-grabbing" : ""}`}
      {...attributes}
      {...listeners}
    >
      <button
        aria-label={`${t("ws.remove")} ${item.file.name}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        className="absolute end-2 top-2 z-10 grid h-7 w-7 place-items-center rounded-md border border-line bg-surface text-muted opacity-100 transition-opacity hover:text-danger sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
      >
        <X size={15} />
      </button>
      <div className="grid h-[178px] place-items-center"><Preview file={item.file} /></div>
      <p className="mt-3 w-full truncate text-center text-[14px] font-medium" title={item.file.name}>{item.file.name}</p>
      <p className="tabular text-[12px] text-muted">
        <Pages file={item.file} />
        {humanSize(item.file.size)}
      </p>
    </li>
  );
}

export function FileBoard({
  items, onChange, sortable, children,
}: { items: Item[]; onChange: (items: Item[]) => void; sortable: boolean; children?: React.ReactNode }) {
  const { t } = useI18n();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    onChange(arrayMove(items, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {children}
        {sortable && items.length > 1 && (
          <button
            className="btn btn-quiet btn-sm"
            onClick={() => onChange([...items].sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true })))}
          >
            <ArrowDownAZ size={16} /> {t("ws.sortAz")}
          </button>
        )}
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          <ul className="flex flex-wrap justify-center gap-4 sm:justify-start">
            {items.map((item) => (
              <Card key={item.id} item={item} sortable={sortable} onRemove={() => onChange(items.filter((i) => i.id !== item.id))} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}
