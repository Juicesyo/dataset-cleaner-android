/**
 * File access abstraction.
 *
 * Two backends behind one interface:
 *  - `capacitor`: native Android, uses the Storage Access Framework through the
 *    Capacitor Filesystem plugin so the user grants a folder once and we can
 *    read every dataset inside it and write the cleaned output back.
 *  - `browser`: plain web, uses <input type="file"> and a download.
 *
 * Keeping both means the same UI runs as an APK and as a desktop page.
 */

export interface PickedFile {
  /** Stable handle: a SAF URI on Android, or `${name}:${size}:${lastModified}` on web. */
  uri: string;
  name: string;
  /** Only populated for the web backend, which has no readable URI. */
  file?: File;
}

export interface FileBackend {
  readonly kind: 'capacitor' | 'browser';
  /** Lets the user pick one or more individual dataset files. */
  pickFiles(accept: string[]): Promise<PickedFile[]>;
  /** Lets the user pick a directory and returns every candidate file inside it. */
  pickDirectory(accept: string[]): Promise<PickedFile[]>;
  readText(file: PickedFile): Promise<string>;
  /** Writes text into a user-chosen directory. Returns the display path. */
  writeTextToDirectory(dirUri: string, fileName: string, text: string): Promise<string>;
  /** Asks the user to choose an output directory once. */
  pickOutputDirectory(): Promise<{ uri: string; label: string }>;
}

const DATASET_EXT = ['.json', '.jsonl', '.ndjson'];

export function isDatasetName(name: string): boolean {
  const lower = name.toLowerCase();
  return DATASET_EXT.some((ext) => lower.endsWith(ext));
}

/** 1-based-kind inference from the file name, defaulting to content sniffing. */
export function kindFromName(name: string): 'single' | 'jsonl' | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.json')) return undefined; // could be either; sniff instead
  return undefined;
}
