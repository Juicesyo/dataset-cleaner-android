/**
 * Word/character-level diff used to colour edits in real time.
 *
 * The output is a list of segments tagged `same` | `add` | `del`, where `del`
 * segments belong to the original text and `add` segments to the new text.
 * The editor renders these inline so the user sees exactly what changed.
 */

export type DiffKind = 'same' | 'add' | 'del';

export interface DiffSegment {
  kind: DiffKind;
  text: string;
}

/**
 * Tokenises text for diffing. CJK characters are split per character (they are
 * dense but individually meaningful), while Latin runs are kept as words so
 * that prose edits do not shatter into letters.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      tokens.push(buf);
      buf = '';
    }
  };
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      flush();
      tokens.push(ch);
    } else if (/\s/.test(ch)) {
      flush();
      tokens.push(ch);
    } else {
      buf += ch;
    }
  }
  flush();
  return tokens;
}

/**
 * Computes a diff between two strings.
 *
 * Uses a common-prefix/suffix trim followed by an LCS DP over the middle
 * section. The trim keeps the DP table small for the common case (a short edit
 * inside a long passage), which matters on a phone.
 */
export function diffText(
  oldText: string,
  newText: string,
  maxCells = 400_000,
): DiffSegment[] {
  if (oldText === newText) {
    return oldText ? [{ kind: 'same', text: oldText }] : [];
  }

  const a = tokenize(oldText);
  const b = tokenize(newText);

  // Trim the common prefix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  // Trim the common suffix (without crossing the prefix).
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const segments: DiffSegment[] = [];
  push(segments, 'same', a.slice(0, start).join(''));

  // For very large middles, fall back to a coarse block replace rather than
  // allocating an enormous DP table on a memory-constrained device.
  if (midA.length * midB.length > maxCells) {
    push(segments, 'del', midA.join(''));
    push(segments, 'add', midB.join(''));
  } else {
    for (const op of lcsDiff(midA, midB)) {
      push(segments, op.kind, op.text);
    }
  }

  push(segments, 'same', a.slice(endA, a.length).join(''));
  return coalesce(segments);
}

/** Classic LCS DP with backtracking, emitting a flat edit script. */
function lcsDiff(a: string[], b: string[]): DiffSegment[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(out, 'same', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(out, 'del', a[i]);
      i++;
    } else {
      push(out, 'add', b[j]);
      j++;
    }
  }
  while (i < n) push(out, 'del', a[i++]);
  while (j < m) push(out, 'add', b[j++]);
  return out;
}

function push(list: DiffSegment[], kind: DiffKind, text: string): void {
  if (!text) return;
  list.push({ kind, text });
}

/** Merges adjacent segments of the same kind. */
function coalesce(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.kind === seg.kind) last.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}

/** True when the two strings differ at all. */
export function isChanged(a: string, b: string): boolean {
  return a !== b;
}

/** Indices of turns whose value differs from the pristine original. */
export function changedTurnIndices(original: string[], current: string[]): number[] {
  const out: number[] = [];
  const n = Math.max(original.length, current.length);
  for (let i = 0; i < n; i++) {
    if ((original[i] ?? '') !== (current[i] ?? '')) out.push(i);
  }
  return out;
}
