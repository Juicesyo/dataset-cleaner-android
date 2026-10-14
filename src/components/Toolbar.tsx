/**
 * Top toolbar.
 *
 * Sticky on phones so the primary actions stay reachable while scrolling a long
 * dataset. Actions are grouped into a data row and an edit row: at phone widths
 * a single row wraps unpredictably, which made it easy to tap the wrong control.
 */

export interface ToolbarProps {
  datasetCount: number;
  sampleCount: number;
  filteredCount: number;
  changedCount: number;
  liveSampleCount: number;
  /** Remembered save directory, or null when none has been chosen yet. */
  saveTargetLabel: string | null;
  canUndo: boolean;
  canRedo: boolean;
  onOpenImport: () => void;
  /** Saves to the remembered target, prompting for one the first time. */
  onSave: () => void;
  /** Opens the sheet to change directory or file name. */
  onOpenSave: () => void;
  onOpenSettings: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const nothingToSave = props.liveSampleCount === 0;

  return (
    <header className="toolbar">
      <div className="toolbar-row">
        <button type="button" onClick={props.onOpenImport}>
          导入
        </button>
        <button
          type="button"
          className="primary"
          onClick={props.onSave}
          disabled={nothingToSave}
          title={
            props.saveTargetLabel
              ? `保存到 ${props.saveTargetLabel}`
              : '首次保存会让你选择输出目录'
          }
        >
          保存
        </button>
        <button type="button" onClick={props.onOpenSave} disabled={nothingToSave}>
          另存为
        </button>
        <button type="button" onClick={props.onOpenSettings}>
          设置
        </button>
      </div>

      <div className="toolbar-row">
        <button type="button" onClick={props.onUndo} disabled={!props.canUndo} title="Ctrl+Z">
          撤销
        </button>
        <button type="button" onClick={props.onRedo} disabled={!props.canRedo} title="Ctrl+Y">
          重做
        </button>
        <button
          type="button"
          className="danger"
          onClick={props.onReset}
          disabled={props.changedCount === 0}
          title="放弃本次所有改动，回到刚导入的状态"
        >
          还原全部
        </button>
      </div>

      <div className="toolbar-stats">
        <span>{props.datasetCount} 个文件</span>
        <span className="dot">·</span>
        <span>{props.sampleCount} 条</span>
        {props.filteredCount !== props.sampleCount && (
          <>
            <span className="dot">·</span>
            <span className="hl">筛选出 {props.filteredCount}</span>
          </>
        )}
        {props.changedCount > 0 && (
          <>
            <span className="dot">·</span>
            <span className="hl-edit">已改动 {props.changedCount}</span>
          </>
        )}
        {props.saveTargetLabel && (
          <>
            <span className="dot">·</span>
            <span className="save-hint" title={props.saveTargetLabel}>
              保存到 {props.saveTargetLabel}
            </span>
          </>
        )}
      </div>
    </header>
  );
}
