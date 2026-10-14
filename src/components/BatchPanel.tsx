import type { BatchSettings } from './SettingsDrawer';
import type { BatchProgress } from '../lib/useBatch';

/**
 * Batch AI rewrite panel.
 *
 * The controls that decide *what* gets sent live here rather than only in the
 * settings drawer: previously the panel was a bare input and a button, so there
 * was no way to tell which turns a run would touch before spending tokens on it.
 * The affected sample and turn counts are both shown for the same reason — one
 * sample can hold several eligible turns, so the sample count alone understates
 * the work.
 */

export interface BatchPanelProps {
  settings: BatchSettings;
  onSettingsChange: (next: BatchSettings) => void;
  progress: BatchProgress;
  /** Samples in scope. */
  targetCount: number;
  /** Individual turns that would be sent to the model. */
  targetTurnCount: number;
  onStart: () => void;
  onCancel: () => void;
  onJumpTo: (sampleId: string) => void;
  onOpenSettings: () => void;
}

const ROLE_LABEL: Record<BatchSettings['targetRole'], string> = {
  gpt: '仅模型回复',
  human: '仅用户输入',
  both: '两者都改',
};

const SCOPE_LABEL: Record<BatchSettings['scope'], string> = {
  filtered: '当前筛选结果',
  changed: '仅已手动改动',
  selected: '仅勾选的条目',
};

export function BatchPanel({
  settings,
  onSettingsChange,
  progress,
  targetCount,
  targetTurnCount,
  onStart,
  onCancel,
  onJumpTo,
  onOpenSettings,
}: BatchPanelProps) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const failures = progress.report.filter((r) => r.status === 'error');
  const idle = !progress.running;

  return (
    <section className="batch-panel">
      <div className="batch-title">
        <span className="batch-title-text">用 AI 批量修改</span>
        <button type="button" className="mini" onClick={onOpenSettings}>
          接口与提示词
        </button>
      </div>

      <label className="batch-label" htmlFor="batch-instruction">
        修改要求
      </label>
      <textarea
        id="batch-instruction"
        className="batch-instruction"
        rows={2}
        placeholder="例如：修正错别字与标点，去掉重复，保持原意。留空则默认润色纠错。"
        value={settings.instruction}
        onChange={(e) => onSettingsChange({ ...settings, instruction: e.target.value })}
      />

      <div className="batch-options">
        <label>
          范围
          <select
            value={settings.scope}
            onChange={(e) =>
              onSettingsChange({ ...settings, scope: e.target.value as BatchSettings['scope'] })
            }
          >
            <option value="filtered">{SCOPE_LABEL.filtered}</option>
            <option value="changed">{SCOPE_LABEL.changed}</option>
            <option value="selected">{SCOPE_LABEL.selected}</option>
          </select>
        </label>

        <label>
          改哪些轮次
          <select
            value={settings.targetRole}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                targetRole: e.target.value as BatchSettings['targetRole'],
              })
            }
          >
            <option value="gpt">{ROLE_LABEL.gpt}</option>
            <option value="human">{ROLE_LABEL.human}</option>
            <option value="both">{ROLE_LABEL.both}</option>
          </select>
        </label>

        <label>
          并发
          <input
            type="number"
            min={1}
            max={12}
            value={settings.concurrency}
            onChange={(e) =>
              onSettingsChange({ ...settings, concurrency: Number(e.target.value) })
            }
          />
        </label>
      </div>

      <div className="batch-row">
        <button
          type="button"
          className="primary batch-run"
          onClick={onStart}
          disabled={progress.running || targetTurnCount === 0}
        >
          {progress.running
            ? '处理中…'
            : `开始修改 ${targetTurnCount} 个轮次`}
        </button>
        {progress.running && (
          <button type="button" className="danger" onClick={onCancel}>
            停止
          </button>
        )}
      </div>

      <p className="hint batch-scope-hint">
        将处理「{SCOPE_LABEL[settings.scope]}」中的 <b>{targetCount}</b> 条样本、
        共 <b>{targetTurnCount}</b> 个{ROLE_LABEL[settings.targetRole]}轮次。
        {targetTurnCount > 0 && `约发出 ${targetTurnCount} 次请求。`}
      </p>

      {progress.running && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${pct}%` }} />
          <span className="progress-text">
            {progress.done}/{progress.total} · 成功 {progress.ok} · 失败 {progress.failed}
          </span>
        </div>
      )}

      {!progress.running && progress.total > 0 && (
        <div className="batch-summary">
          完成 {progress.total} 项：成功 {progress.ok}，失败 {progress.failed}
          {failures.length > 0 && <span className="warn">，详见下方</span>}
          {progress.ok > 0 && <span> · 结果已应用，可用「撤销」回退</span>}
        </div>
      )}

      {!progress.running && failures.length > 0 && (
        <details className="batch-errors">
          <summary>查看 {failures.length} 项失败原因</summary>
          <ul>
            {failures.slice(0, 50).map((f, i) => (
              <li key={i}>
                <button type="button" className="link" onClick={() => onJumpTo(f.sampleId)}>
                  第 {f.sourceLine || '?'} 行 / 第 {f.turnIndex + 1} 轮
                </button>
                <span className="err-msg">{f.message}</span>
              </li>
            ))}
          </ul>
          {failures.length > 50 && <p className="hint">仅显示前 50 项。</p>}
        </details>
      )}

      {idle && targetTurnCount === 0 && (
        <p className="hint">
          当前范围没有可处理的轮次。换个「范围」或「改哪些轮次」试试，或先展开某条数据
          用单轮的「AI 改写」。
        </p>
      )}
    </section>
  );
}
