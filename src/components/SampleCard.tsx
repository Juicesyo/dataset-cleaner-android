import { useEffect, useRef, useState } from 'react';
import type { Sample } from '../types';
import { TurnEditor } from './TurnEditor';

/**
 * A single dataset row: a collapsible card holding every turn.
 *
 * Collapsed cards render only a one-line preview, because a list of thousands
 * of full textareas will not scroll on a phone. Expansion is what mounts the
 * editors.
 */

export interface SampleCardProps {
  sample: Sample;
  index: number;
  /** Turn values as imported, for diff colouring and per-turn revert. */
  baseline?: string[];
  expanded: boolean;
  onToggle: () => void;
  onTurnChange: (turnIndex: number, value: string) => void;
  /** Sends a single turn to the model. */
  onAskAi: (turnIndex: number) => void;
  /** Turn keys (`sampleId:turnIndex`) with an in-flight AI request. */
  aiBusyTurns: Set<string>;
  onDeleteTurn: (turnIndex: number) => void;
  onInsertTurn: (afterIndex: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRestore: () => void;
  /** When true the card scrolls itself into view (search jump target). */
  spotlight?: boolean;
}

export function SampleCard({
  sample,
  index,
  baseline,
  expanded,
  onToggle,
  onTurnChange,
  onAskAi,
  aiBusyTurns,
  onDeleteTurn,
  onInsertTurn,
  onDuplicate,
  onDelete,
  onRestore,
  spotlight,
}: SampleCardProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (spotlight && ref.current) {
      ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1600);
      return () => clearTimeout(t);
    }
  }, [spotlight]);

  const changedTurns = baseline
    ? sample.conversations.reduce(
        (acc, t, i) => (baseline[i] !== undefined && baseline[i] !== t.value ? acc + 1 : acc),
        0,
      )
    : 0;
  const structChanged = baseline ? baseline.length !== sample.conversations.length : false;

  return (
    <div
      ref={ref}
      className={[
        'sample-card',
        expanded ? 'expanded' : '',
        sample.deleted ? 'deleted' : '',
        flash ? 'flash' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="sample-head" onClick={onToggle}>
        <span className="caret">{expanded ? '▾' : '▸'}</span>
        <span className="sample-no">#{index + 1}</span>
        <span className="sample-preview">{preview(sample)}</span>
        <span className="sample-badges">
          {sample.sourceLine === 0 && <span className="badge new">新增</span>}
          {(changedTurns > 0 || structChanged) && (
            <span className="badge edited">改 {changedTurns + (structChanged ? 1 : 0)}</span>
          )}
          {sample.deleted && <span className="badge del">已删除</span>}
          <span className="badge turns">{sample.conversations.length} 轮</span>
        </span>
      </div>

      {expanded && (
        <div className="sample-body">
          <div className="sample-toolbar">
            <button type="button" className="mini" onClick={onDuplicate}>
              复制此条
            </button>
            {sample.deleted ? (
              <button type="button" className="mini" onClick={onRestore}>
                恢复
              </button>
            ) : (
              <button type="button" className="mini danger" onClick={onDelete}>
                标记删除
              </button>
            )}
            {sample.fingerprint && (
              <span className="fp" title={sample.fingerprint}>
                fp: {sample.fingerprint.slice(0, 12)}…
              </span>
            )}
          </div>

          {sample.conversations.map((turn, i) => (
            <TurnEditor
              key={i}
              turn={turn}
              index={i}
              originalValue={baseline?.[i]}
              disabled={sample.deleted}
              aiBusy={aiBusyTurns.has(`${sample.id}:${i}`)}
              onChange={(v) => onTurnChange(i, v)}
              onAskAi={() => onAskAi(i)}
              onDelete={() => onDeleteTurn(i)}
              onInsertAfter={() => onInsertTurn(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** First line of the first turn, trimmed to fit one row. */
function preview(sample: Sample): string {
  const first = sample.conversations.find((t) => t.value.trim().length > 0);
  if (!first) return '（空样本）';
  const line = first.value.replace(/\s+/g, ' ').trim();
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}
