import type { BatchSettings } from './SettingsDrawer';
import type { BatchProgress } from '../lib/useBatch';

/**
 * Batch LLM panel.
 *
 * Collapsed it is a single action row; running it shows a determinate progress
 * bar, a cancel button and a per-item failure report, so a partially failed run
 * is still reviewable instead of silently half-applied.
 */

export interface BatchPanelProps {
  settings: BatchSettings;
  onSettingsChange: (next: BatchSettings) => void;
  progress: BatchProgress;
  targetCount: number;
  onStart: () => void;
  onCancel: () => void;
  onJumpTo: (sampleId: string) => void;
}

export function BatchPanel({
  settings,
  onSettingsChange,
  progress,
  targetCount,
  onStart,
  onCancel,
  onJumpTo,
}: BatchPanelProps) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const failures = progress.report.filter((r) => r.status === 'error');

  return (
    <section className="batch-panel">
      <div className="batch-row">
        <input
          type="text"
          className="batch-instruction"
          placeholder="给 LLM 的修改要求，留空则默认润色纠错…"
          value={settings.instruction}
          onChange={(e) => onSettingsChange({ ...settings, instruction: e.target.value })}
        />
        <button
          type="button"
          className="primary"
          onClick={onStart}
          disabled={progress.running || targetCount === 0}
        >
          {progress.running ? '处理中…' : `批量修改 (${targetCount})`}
        </button>
        {progress.running && (
          <button type="button" className="danger" onClick={onCancel}>
            停止
          </button>
        )}
      </div>

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
    </section>
  );
}
