/**
 * Search / filter controls.
 *
 * Kept as a separate bar so it can collapse on narrow screens while the
 * toolbar above stays fixed.
 */

export interface FilterState {
  text: string;
  field: 'any' | 'human' | 'gpt' | 'changed' | 'line';
  role: 'any' | 'human' | 'gpt';
  status: 'any' | 'active' | 'deleted';
}

export interface SearchBarProps {
  filter: FilterState;
  onChange: (filter: FilterState) => void;
  onCollapseAll: () => void;
  onExpandVisible: () => void;
}

export function SearchBar({ filter, onChange, onCollapseAll, onExpandVisible }: SearchBarProps) {
  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    onChange({ ...filter, [key]: value });

  return (
    <div className="searchbar">
      <input
        type="search"
        className="search-input"
        placeholder="搜索内容 / 行号…"
        value={filter.text}
        enterKeyHint="search"
        onChange={(e) => set('text', e.target.value)}
      />
      <div className="search-filters">
        <select
          value={filter.field}
          onChange={(e) => set('field', e.target.value as FilterState['field'])}
          aria-label="搜索范围"
        >
          <option value="any">全文</option>
          <option value="human">仅用户输入</option>
          <option value="gpt">仅模型回复</option>
          <option value="changed">仅已修改</option>
          <option value="line">按源行号</option>
        </select>

        <select
          value={filter.role}
          onChange={(e) => set('role', e.target.value as FilterState['role'])}
          aria-label="角色筛选"
        >
          <option value="any">全部角色</option>
          <option value="human">含 human</option>
          <option value="gpt">含 gpt</option>
        </select>

        <select
          value={filter.status}
          onChange={(e) => set('status', e.target.value as FilterState['status'])}
          aria-label="状态筛选"
        >
          <option value="any">全部状态</option>
          <option value="active">仅未删除</option>
          <option value="deleted">仅已删除</option>
        </select>

        <button type="button" className="mini" onClick={onExpandVisible}>
          展开
        </button>
        <button type="button" className="mini" onClick={onCollapseAll}>
          收起
        </button>
        {filter.text && (
          <button type="button" className="mini" onClick={() => set('text', '')}>
            清空
          </button>
        )}
      </div>
    </div>
  );
}
