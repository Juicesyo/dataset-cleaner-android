import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
 *
 * Actions carry text labels rather than bare symbols: a `+` glyph does not
 * convey "insert a new turn here" on a phone, where there is no hover tooltip
 * to explain it. "还原本轮" is named explicitly to distinguish it from the
 * toolbar's "还原全部".
 */

export interface TurnEditorProps {
  turn: Turn;
  index: number;
  /** The turn's value as imported; `undefined` for a newly added turn. */
  originalValue?: string;
  onChange: (value: string) => void;
  onDelete: () => void;
  onInsertAfter: () => void;
  /** Sends just this turn to the model. */
  onAskAi: () => void;
  /** True while this turn has an AI request in flight. */
  aiBusy?: boolean;
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
  onAskAi,
  aiBusy,
  focused,
  disabled,
}: TurnEditorProps) {
  const [showDiff, setShowDiff] = useState(true);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLPreElement | null>(null);

  const changed = originalValue !== undefined && originalValue !== turn.value;

  const segments = useMemo(
    () => (changed && showDiff ? diffText(originalValue ?? '', turn.value) : []),
    [changed, showDiff, originalValue, turn.value],
  );

  /**
   * Keeps the colour layer locked to the textarea.
   *
   * The mirror is absolutely positioned and never scrolls on its own, so once
   * the box caps out and scrolls internally the highlight would otherwise stay
   * pinned to the top and mark the wrong lines. A classic (space-taking)
   * scrollbar also narrows the textarea's content box, which would make the two
   * layers wrap differently, so the same width is reserved on the mirror.
   */
  const syncBackdrop = useCallback(() => {
    const ta = textareaRef.current;
    const pre = backdropRef.current;
    if (!ta || !pre) return;

    const cs = getComputedStyle(ta);
    const borderX =
      (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    const scrollbarW = Math.max(0, ta.offsetWidth - ta.clientWidth - borderX);

    pre.style.paddingRight = `calc(${cs.paddingRight} + ${scrollbarW}px)`;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  }, []);

  useLayoutEffect(() => {
    syncBackdrop();
  }, [segments, turn.value, syncBackdrop]);

  const isUser = turn.from === 'human' || turn.from === 'user';

  return (
    <div
      ref={wrapRef}
      className={`turn ${isUser ? 'turn-user' : 'turn-model'} ${focused ? 'turn-focused' : ''}`}
    >
      <div className="turn-head">
        <span className={`role-badge ${isUser ? 'role-user' : 'role-model'}`}>{turn.from}</span>
        <span className="turn-index">第 {index + 1} 轮</span>
        {changed && (
          <>
            <span className="changed-dot" title="已修改" />
            {segments.length > 0 && <DiffStat segments={segments} />}
          </>
        )}
        <div className="turn-actions">
          <button
            type="button"
            className="mini ai"
            onClick={onAskAi}
            disabled={disabled || aiBusy}
            title="只把这一个轮次发给 AI 按「修改要求」改写"
          >
            {aiBusy ? 'AI 改写中…' : 'AI 改写'}
          </button>
          {changed && (
            <button
              type="button"
              className="mini"
              onClick={() => setShowDiff((v) => !v)}
              title="切换改动高亮显示"
            >
              {showDiff ? '关闭高亮' : '显示改动'}
            </button>
          )}
          <button
            type="button"
            className="mini"
            onClick={() => onChange(originalValue ?? '')}
            disabled={!changed}
            title="把这一轮恢复成导入时的内容"
          >
            还原本轮
          </button>
          <button
            type="button"
            className="mini"
            onClick={onInsertAfter}
            disabled={disabled}
            title="在这一轮下方插入一个新的轮次"
          >
            ＋ 插入轮次
          </button>
          <button
            type="button"
            className="mini danger"
            onClick={onDelete}
            disabled={disabled}
            title="删除这一轮"
          >
            删除轮次
          </button>
        </div>
      </div>

      <div className="edit-stack">
        {/* The coloured layer only exists when showing a diff, so the plain
            case costs nothing and renders with perfect default fidelity. */}
        {segments.length > 0 && <DiffHighlight ref={backdropRef} segments={segments} />}
        <AutoGrowTextarea
          value={turn.value}
          onChange={onChange}
          readOnly={disabled}
          ariaLabel={`第 ${index + 1} 轮 ${turn.from} 内容`}
          className={`edit-surface ${segments.length > 0 ? 'overlay' : 'plain'}`}
          placeholder="（空）"
          minHeight={64}
          textareaRef={textareaRef}
          onFit={syncBackdrop}
          onScroll={syncBackdrop}
        />
      </div>
    </div>
  );
}
