import type { FileBackend, PickedFile } from './types';
import { isDatasetName } from './types';

/**
 * Desktop/browser backend.
 *
 * Browsers cannot hand a page a writable directory without the File System
 * Access API, which is unavailable on many mobile browsers, so this backend
 * degrades to: pick files via <input>, save via a download. It exists so the
 * same bundle can be used on a PC for bulk cleanup work.
 */
export class BrowserBackend implements FileBackend {
  readonly kind = 'browser' as const;
  /** Retained so `readText` can recover the File object behind a synthetic URI. */
  private registry = new Map<string, File>();

  async pickFiles(_accept: string[]): Promise<PickedFile[]> {
    const files = await openFileDialog(false);
    return files.filter((f) => isDatasetName(f.name)).map((f) => this.track(f));
  }

  async pickDirectory(_accept: string[]): Promise<PickedFile[]> {
    const files = await openFileDialog(true);
    return files.filter((f) => isDatasetName(f.name)).map((f) => this.track(f));
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

function openFileDialog(directory: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,.jsonl,.ndjson,application/json';
    if (directory) {
      // Non-standard but widely supported; falls back to multi-select.
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
