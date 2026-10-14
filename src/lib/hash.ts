/**
 * A small, dependency-free non-cryptographic hash used only to build stable
 * React keys / identity suffixes — never for integrity or security purposes.
 *
 * Uses FNV-1a (32-bit), which is fast and has adequate dispersion for keys.
 */
export function createHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts, kept in uint32 range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
