import { Capacitor } from '@capacitor/core';
import { CapacitorBackend } from './capacitor';
import { BrowserBackend, canImportDirectory } from './browser';
import { hasSafPlugin } from './saf';
import type { FileBackend } from './types';

export * from './types';
export { canImportDirectory, supportsDirectoryInput, supportsDirectoryPicker } from './browser';

let cached: FileBackend | null = null;

/** True when running inside the Android WebView rather than a browser. */
export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Returns the backend for the current platform.
 *
 * The native path is only chosen when the `Saf` plugin is genuinely registered;
 * otherwise a Capacitor build without the plugin would offer pickers that
 * silently do nothing. In that case the browser behaviour takes over, which
 * still works through the file input and a download.
 */
export function getBackend(): FileBackend {
  if (!cached) {
    cached = isNativePlatform() && hasSafPlugin() ? new CapacitorBackend() : new BrowserBackend();
  }
  return cached;
}

/**
 * Whether "选择目录" can work right now.
 *
 * Reported to the UI so the limitation is visible before the user clicks,
 * instead of after an import that quietly produced nothing.
 */
export function directoryImportAvailable(): boolean {
  if (getBackend().kind === 'capacitor') return true;
  return canImportDirectory();
}
