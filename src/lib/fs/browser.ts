import type { FileBackend, PickedFile } from './types';
import { isDatasetName } from './types';

/**
 * Desktop/browser backend.
 *
 * Browsers cannot hand a page a writable directory without the File System
 * Access API, so saving degrades to a download. Reading a directory has two
 * paths, and which one is available matters a great deal:
 *
 *  1. `showDirectoryPicker()` (File System Access API) — real recursive
 *     traversal. Desktop Chrome/Edge only.
 *  2. `<input webkitdirectory>` — unsupported by most mobile browsers. Chrome
 *     for Android gained it only very recently, and Samsung Internet, iOS
 *     Safari before 18.4, UC, Baidu and Opera Mobile do not support it at all,
 *     because the OS file picker has no "select a folder" affordance.
 *
 * When neither is available the app must say so. Silently returning an empty
 * list made "选择目录" look like it did nothing, which is indistinguishable from
 * an empty folder.
 */

/** True when the browser can select a folder through a file input. */
export function supportsDirectoryInput(): boolean {
  return (
    typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype
  );
}

/** True when the File System Access API can pick a directory. */
export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as BrowserWindow).showDirectoryPicker === 'function'
  );
}

/** Whether any directory-import strategy exists on this platform. */
export function canImportDirectory(): boolean {
  return supportsDirectoryPicker() || supportsDirectoryInput();
}

/** Minimal typings for the File System Access API pieces we use. */
interface BrowserWindow extends Window {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandleLike>;
}

interface FileSystemDirectoryHandleLike {
  kind: 'directory';
  name: string;
  entries: () => AsyncIterableIterator<[string, FileSystemHandleLike]>;
}

interface FileSystemFileHandleLike {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
}

type FileSystemHandleLike = FileSystemDirectoryHandleLike | FileSystemFileHandleLike;

export class BrowserBackend implements FileBackend {
  readonly kind = 'browser' as const;
  /** Retained so `readText` can recover the File object behind a synthetic URI. */
  private registry = new Map<string, File>();

  async pickFiles(_accept: string[]): Promise<PickedFile[]> {
    const files = await openFileDialog(false);
    return files.filter((f) => isDatasetName(f.name)).map((f) => this.track(f));
  }

  async pickDirectory(_accept: string[]): Promise<PickedFile[]> {
    // Prefer the File System Access API: it recurses reliably and is the only
    // option on browsers whose file picker cannot select a folder.
    if (supportsDirectoryPicker()) {
      const files = await this.pickViaFileSystemAccess();
      if (files.length > 0) return files.map((f) => this.track(f));
      // Cancelled or empty: fall through to the input-based path.
    }

    if (!supportsDirectoryInput()) {
      throw new Error(
        '当前浏览器不支持选择目录（多数手机浏览器都不支持，系统文件选择器没有“选择文件夹”入口）。' +
          '请改用「选择文件（可多选）」；或安装 Android APK —— APK 走系统目录授权，可以递归导入整个文件夹。',
      );
    }

    const files = await openFileDialog(true);
    return files.filter((f) => isDatasetName(f.name)).map((f) => this.track(f));
  }

  /** Recursively reads a directory the user granted through the picker. */
  private async pickViaFileSystemAccess(): Promise<File[]> {
    const picker = (window as BrowserWindow).showDirectoryPicker;
    if (!picker) return [];

    let root: FileSystemDirectoryHandleLike;
    try {
      root = await picker({ mode: 'read' });
    } catch (err) {
      // AbortError means the user cancelled, which is not a failure.
      if ((err as Error).name === 'AbortError') return [];
      throw new Error(`选择目录失败: ${(err as Error).message}`);
    }

    const out: File[] = [];
    await walk(root, out, 0);
    return out;
  }

  private track(f: File): PickedFile {
    const uri = `${f.name}:${f.size}:${f.lastModified}:${Math.random().toString(36).slice(2, 6)}`;
    this.registry.set(uri, f);
    return { uri, name: f.name, file: f };
  }

  async readText(file: PickedFile): Promise<string> {
    const f = file.file ?? this.registry.get(file.uri);
    if (!f) throw new Error(`无法读取 ${file.name}`);
    return await f.text();
  }

  async writeTextToDirectory(dirUri: string, fileName: string, text: string): Promise<string> {
    // The web backend flattens "directory" to a download that the browser
    // routes into the user's downloads folder.
    void dirUri;
    const blob = new Blob([text], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return fileName;
  }

  async pickOutputDirectory(): Promise<{ uri: string; label: string }> {
    return { uri: 'download', label: '浏览器下载目录' };
  }
}

/**
 * Depth-first walk of a granted directory.
 *
 * Capped so that pointing the picker at a huge tree cannot hang the page.
 */
async function walk(
  dir: FileSystemDirectoryHandleLike,
  out: File[],
  depth: number,
): Promise<void> {
  if (depth > 6 || out.length > 5000) return;
  for await (const [, entry] of dir.entries()) {
    if (entry.kind === 'file') {
      const fileEntry = entry as FileSystemFileHandleLike;
      if (!isDatasetName(fileEntry.name)) continue;
      try {
        out.push(await fileEntry.getFile());
      } catch {
        // A file may vanish between listing and reading; skip it.
      }
    } else {
      await walk(entry as FileSystemDirectoryHandleLike, out, depth + 1);
    }
  }
}

function openFileDialog(directory: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,.jsonl,.ndjson,application/json';
    if (directory) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    // If the dialog is cancelled, `change` never fires; resolve on refocus.
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish(Array.from(input.files ?? [])), 500),
      { once: true },
    );

    input.click();
  });
}
