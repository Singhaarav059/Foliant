// Whole folders for workflows, through the File System Access API (Chromium
// on desktop): every PDF in a chosen folder and its subfolders is read, and
// each result is written to a second folder the user picks. Other browsers
// take several files at once instead and download the results as one ZIP.

type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
};
type Picker = (o?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;

const picker = () => (typeof window === "undefined" ? undefined : (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker);

export const canPickFolders = () => typeof picker() === "function";

export const pickFolder = (mode: "read" | "readwrite", id: string) => picker()!({ mode, id });

// The PDFs in a folder and its subfolders, sorted by path, each named by its
// path inside the folder ("2024/march.pdf"), at most `depth` folders deep.
export async function listPdfs(dir: FileSystemDirectoryHandle, depth = 8): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = [];
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, left: number) => {
    for await (const entry of (d as DirHandle).values()) {
      if (entry.kind === "directory") {
        if (left > 0) await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`, left - 1);
      } else if (/\.pdf$/i.test(entry.name)) {
        out.push({ path: prefix + entry.name, file: await (entry as FileSystemFileHandle).getFile() });
      }
    }
  };
  await walk(dir, "", depth);
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

// Writes `blob` into `dir` as `name`, or as "name-2.pdf", "name-3.pdf" … when
// that name was already written in this run (`used`), so no result overwrites another.
export async function writeUnique(dir: FileSystemDirectoryHandle, name: string, blob: Blob, used: Set<string>): Promise<string> {
  const clean = name.replace(/[\\/:*?"<>|]/g, "_");
  let final = clean;
  for (let k = 2; used.has(final.toLowerCase()); k++) final = clean.replace(/(\.[^.]+)?$/, (ext) => `-${k}${ext}`);
  used.add(final.toLowerCase());
  const handle = await dir.getFileHandle(final, { create: true });
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
  return final;
}
