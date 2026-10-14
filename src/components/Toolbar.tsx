/**
 * Top toolbar: import/export, undo/redo, counters.
 *
 * Sticky on phones so the primary actions stay reachable while scrolling a
 * long dataset.
 */

export interface ToolbarProps {
  datasetCount: number;
  sampleCount: number;
  filteredCount: number;
  changedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onOpenImport: () => void;
  onOpenExport: () => void;
  onOpenSettings: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
}

export function Toolbar(props: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="toolbar-row">
        <button type="button" className="primary" onClick={props.onOpenImport}>
          导入
        </button>
        <button type="button" onClick={props.onOpenExport} disabled={props.sampleCount === 0}>
          导出
        </button>
        <button type="button" onClick={props.onUndo} disabled={!props.canUndo} title="Ctrl+Z">
          撤销
        </button>
        <button type="button" onClick={props.onRedo} disabled={!props.canRedo} title="Ctrl+Y">
          重做
        </button>
        <button type="button" onClick={props.onOpenSettings}>
          设置
        </button>
        <button
          type="button"
          className="danger"
          onClick={props.onReset}
          disabled={props.changedCount === 0}
          title="放弃本次所有改动"
        >
          还原
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
      </div>
    </header>
  );
}
