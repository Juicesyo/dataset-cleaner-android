import { useMemo } from 'react';
import type { DiffSegment } from '../lib/diff';

/**
 * Renders a diff inline with colour, on top of a transparent textarea.
 *
 * We use the "backdrop" technique: a <pre> mirror sits exactly behind the
 * textarea and paints the coloured spans, while the textarea itself is
 * transparent. This keeps a real, native editing experience (caret, selection,
 * IME composition, soft-keyboard behaviour) while still showing live colour,
 * which a contenteditable-based approach would break on Android.
 */

export interface DiffHighlightProps {
  segments: DiffSegment[];
  className?: string;
}

export function DiffHighlight({ segments, className }: DiffHighlightProps) {
  const spans = useMemo(
    () =>
      segments.map((seg, i) => (
        <span key={i} className={`seg seg-${seg.kind}`}>
          {seg.text}
        </span>
      )),
    [segments],
  );

  return (
    <pre className={`diff-backdrop ${className ?? ''}`} aria-hidden="true">
      {spans}
      {/* Trailing newline keeps the last line's height equal to the textarea's. */}
      {'\n'}
    </pre>
  );
}

/** Small chip summarising how much a turn changed. */
export function DiffStat({ segments }: { segments: DiffSegment[] }) {
  const { added, removed } = useMemo(() => {
    let a = 0;
    let r = 0;
    for (const s of segments) {
      if (s.kind === 'add') a += s.text.length;
      else if (s.kind === 'del') r += s.text.length;
    }
    return { added: a, removed: r };
  }, [segments]);

  if (added === 0 && removed === 0) return null;
  return (
    <span className="diff-stat">
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">-{removed}</span>}
    </span>
  );
}
