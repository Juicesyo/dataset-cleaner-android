import { Capacitor } from '@capacitor/core';
import { CapacitorBackend } from './capacitor';
import { BrowserBackend } from './browser';
import { hasSafPlugin } from './saf';
import type { FileBackend } from './types';

export * from './types';

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
 * The native path is only chosen when the `Saf` plugin is actually registered;
 * otherwise a Capacitor build without the plugin would show pickers that
 * silently do nothing. In that case we fall back to the browser behaviour,
 * which still works via the file input and a download.
 */
export function getBackend(): FileBackend {
  if (!cached) {
    cached = isNativePlatform() && hasSafPlugin() ? new CapacitorBackend() : new BrowserBackend();
  }
  return cached;
}
