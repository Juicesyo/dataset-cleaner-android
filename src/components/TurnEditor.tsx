import { useMemo, useRef, useState } from 'react';
import type { Turn } from '../types';
import { diffText } from '../lib/diff';
import { AutoGrowTextarea } from './AutoGrowTextarea';
import { DiffHighlight, DiffStat } from './DiffHighlight';

/**
 * One conversational turn.
 *
 * The textarea is layered exactly on top of the coloured diff backdrop. The
 * two must share identical font metrics, padding and border width or the text
 * visibly misaligns, so both are styled by the same `.edit-surface` rule in
 * the stylesheet.
 */

export interface TurnEditorProps {
  turn: Turn;
  index: number;
  /** The turn's value as imported; `undefined` for a newly added turn. */
  originalValue?: string;
  onChange: (value: string) => void;
  onDelete: () => void;
  onInsertAfter: () => void;
  /** Highlighted when the user jumped here from search. */
  focused?: boolean;
  /** Read-only when the row is soft-deleted. */
  disabled?: boolean;
}

export function TurnEditor({
  turn,
  index,
  originalValue,
  onChange,
  onDelete,
  onInsertAfter,
  focused,
  disabled,
}: TurnEditorProps) {
  const [showDiff, setShowDiff] = useState(true);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const changed = originalValue !== undefined && originalValue !== turn.value;

  const segments = useMemo(
    () => (changed && showDiff ? diffText(originalValue ?? '', turn.value) : []),
    [changed, showDiff, originalValue, turn.value],
  );

  const isUser = turn.from === 'human' || turn.from === 'user';

  return (
    <div
      ref={wrapRef}
      className={`turn ${isUser ? 'turn-user' : 'turn-model'} ${focused ? 'turn-focused' : ''}`}
    >
      <div className="turn-head">
        <span className={`role-badge ${isUser ? 'role-user' : 'role-model'}`}>{turn.from}</span>
        <span className="turn-index">#{index + 1}</span>
        {changed && (
          <>
            <span className="changed-dot" title="已修改" />
            {segments.length > 0 && <DiffStat segments={segments} />}
          </>
        )}
        <div className="turn-actions">
          {changed && (
            <button
              type="button"
              className="mini"
              onClick={() => setShowDiff((v) => !v)}
              title="切换改动高亮"
            >
              {showDiff ? '高亮' : '纯文本'}
            </button>
          )}
          <button
            type="button"
            className="mini"
            onClick={() => onChange(originalValue ?? '')}
            disabled={!changed}
            title="还原这一轮"
          >
            还原
          </button>
          <button type="button" className="mini" onClick={onInsertAfter} title="在下方插入一轮">
            +
          </button>
          <button
            type="button"
            className="mini danger"
            onClick={onDelete}
            disabled={disabled}
            title="删除这一轮"
          >
            ×
          </button>
        </div>
      </div>

      <div className="edit-stack">
        {/* The coloured layer only exists when showing a diff, so the plain
            case costs nothing and renders with perfect default fidelity. */}
        {segments.length > 0 && <DiffHighlight segments={segments} />}
        <AutoGrowTextarea
          value={turn.value}
          onChange={onChange}
          readOnly={disabled}
          ariaLabel={`第 ${index + 1} 轮 ${turn.from} 内容`}
          className={`edit-surface ${segments.length > 0 ? 'overlay' : 'plain'}`}
          placeholder="（空）"
          minHeight={64}
        />
      </div>
    </div>
  );
}
