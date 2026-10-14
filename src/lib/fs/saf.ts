import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Native SAF bridge.
 *
 * Capacitor's stock Filesystem plugin cannot reach arbitrary user folders on
 * Android 10+ (scoped storage): it only addresses the app's own sandbox. To let
 * the user pick a dataset folder and write the cleaned file back into it, we
 * use the Storage Access Framework through a small custom plugin implemented in
 * `android/app/src/main/java/.../SafPlugin.java`.
 *
 * Implemented APIs:
 *   pickFiles()          -> ACTION_OPEN_DOCUMENT, multiple
 *   pickDirectory()      -> ACTION_OPEN_DOCUMENT_TREE, then recursive listing
 *   readFile({uri})      -> reads via ContentResolver
 *   writeFile({uri,name,data}) -> creates/replaces a file inside a granted tree
 *   readManyFiles({uris})-> batched read, avoiding a bridge round-trip per file
 */

export interface SafPickedFile {
  uri: string;
  name: string;
  size?: number;
}

export interface SafInterface {
  pickFiles(): Promise<{ files: SafPickedFile[] }>;
  pickDirectory(options: { recursive?: boolean }): Promise<{
    uri: string;
    name: string;
    files: SafPickedFile[];
  }>;
  readFile(options: { uri: string }): Promise<{ data: string }>;
  readManyFiles(options: { uris: string[] }): Promise<{ files: { uri: string; data: string }[] }>;
  writeFile(options: { treeUri: string; name: string; data: string }): Promise<{ uri: string }>;
}

export const Saf = registerPlugin<SafInterface>('Saf');

/**
 * True when the native plugin is actually present in this build.
 *
 * `Capacitor.Plugins['Saf']` cannot answer this: `registerPlugin('Saf')` assigns
 * a proxy into `Plugins` from JavaScript unconditionally, whether or not any
 * native implementation exists. `isPluginAvailable` consults `PluginHeaders`,
 * which the native bridge injects from the registered plugin classes, so it
 * reflects reality.
 */
export function hasSafPlugin(): boolean {
  try {
    if (!Capacitor.isNativePlatform()) return false;
    return Capacitor.isPluginAvailable('Saf');
  } catch {
    return false;
  }
}
