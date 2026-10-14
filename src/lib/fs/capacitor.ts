import { Saf } from './saf';
import type { FileBackend, PickedFile } from './types';
import { isDatasetName } from './types';

/**
 * Android backend, built on the native SAF plugin (see `saf.ts`).
 *
 * The user grants a folder once via the system picker, and the content:// URI
 * it returns stays valid for the session, so dataset files inside that folder —
 * and any subfolder — can be read, and the cleaned JSONL written back beside
 * the originals without any storage permission in the manifest.
 */

export class CapacitorBackend implements FileBackend {
  readonly kind = 'capacitor' as const;

  /** Trees the user has granted, keyed by URI, so exports reuse the grant. */
  private grantedTrees = new Map<string, string>();

  async pickFiles(_accept: string[]): Promise<PickedFile[]> {
    const res = await Saf.pickFiles();
    return (res.files ?? [])
      .map((f) => ({ uri: f.uri, name: f.name }))
      .filter((f) => isDatasetName(f.name));
  }

  async pickDirectory(_accept: string[]): Promise<PickedFile[]> {
    const res = await Saf.pickDirectory({ recursive: true });
    if (res.uri && res.name) this.grantedTrees.set(res.uri, res.name);
    return (res.files ?? [])
      .map((f) => ({ uri: f.uri, name: f.name }))
      .filter((f) => isDatasetName(f.name));
  }

  async readText(file: PickedFile): Promise<string> {
    const res = await Saf.readFile({ uri: file.uri });
    return res.data;
  }

  async writeTextToDirectory(dirUri: string, fileName: string, text: string): Promise<string> {
    const res = await Saf.writeFile({ treeUri: dirUri, name: fileName, data: text });
    return res.uri;
  }

  async pickOutputDirectory(): Promise<{ uri: string; label: string }> {
    const res = await Saf.pickDirectory({ recursive: false });
    if (!res.uri) throw new Error('未选择输出目录');
    this.grantedTrees.set(res.uri, res.name);
    return { uri: res.uri, label: res.name || '已选目录' };
  }

  /** Reads every file in one bridge call — noticeably faster for a directory. */
  async readMany(files: PickedFile[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const res = await Saf.readManyFiles({ uris: files.map((f) => f.uri) });
    for (const f of res.files ?? []) out.set(f.uri, f.data);
    return out;
  }
}
