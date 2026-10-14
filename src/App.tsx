import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { suggestName, useDatasets } from './lib/useDatasets';
import { useBatch } from './lib/useBatch';
import { loadConfig, SettingsDrawer, type BatchSettings } from './components/SettingsDrawer';
import { SampleCard } from './components/SampleCard';
import { buildRewriteMessages, chat, listModels, type LlmConfig } from './lib/llm';
import type { Sample } from './types';
import { getBackend } from './lib/fs';
import { Toolbar } from './components/Toolbar';
import { BatchPanel } from './components/BatchPanel';
import { SearchBar, type FilterState } from './components/SearchBar';

/**
 * Application shell.
 *
 * Layout is a single scrolling column of sample cards. On a phone the toolbar
 * is sticky at the top and the batch panel slides up from the bottom; on a
 * wide screen the side panel is always visible.
 */

const PAGE_SIZE = 40;

export default function App() {
  const store = useDatasets();
  const batch = useBatch();

  const [config, setConfig] = useState<LlmConfig>(() => loadConfig());
  const [batchSettings, setBatchSettings] = useState<BatchSettings>({
    instruction: '',
    concurrency: 3,
    scope: 'filtered',
    targetRole: 'gpt',
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState<FilterState>({
    text: '',
    field: 'any',
    role: 'any',
    status: 'any',
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  /** Turn keys (`sampleId:turnIndex`) with an in-flight single-turn AI rewrite. */
  const [aiBusy, setAiBusy] = useState<Set<string>>(new Set());

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), kind === 'err' ? 8000 : 4000);
  }, []);

  /**
   * Filtering runs over the live sample list. Matching is case-insensitive
   * substring search across the chosen field.
   */
  const filtered = useMemo(() => {
    const q = filter.text.trim().toLowerCase();
    return store.allSamples.filter((s) => {
      if (filter.status === 'active' && s.deleted) return false;
      if (filter.status === 'deleted' && !s.deleted) return false;

      if (filter.role !== 'any') {
        const has = s.conversations.some((t) => t.from === filter.role);
        if (!has) return false;
      }

      if (!q) return true;

      const base = store.baselineFor(s.id);
      const matches = (text: string) => text.toLowerCase().includes(q);

      switch (filter.field) {
        case 'human':
          return s.conversations.some(
            (t) => (t.from === 'human' || t.from === 'user') && matches(t.value),
          );
        case 'gpt':
          return s.conversations.some(
            (t) => (t.from === 'gpt' || t.from === 'assistant') && matches(t.value),
          );
        case 'changed':
          return (
            base !== undefined &&
            s.conversations.some((t, i) => base[i] !== undefined && base[i] !== t.value)
          );
        case 'line':
          return String(s.sourceLine) === filter.text.trim();
        default:
          return s.conversations.some((t) => matches(t.value));
      }
    });
  }, [store, filter]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  /**
   * The set the batch operates on, resolved from the scope selector:
   * the filtered view, only already-edited rows, or only explicit selections.
   */
  const batchTargets = useMemo((): Sample[] => {
    switch (batchSettings.scope) {
      case 'changed':
        return store.allSamples.filter((s) => {
          if (s.deleted) return false;
          const base = store.baselineFor(s.id);
          return base !== undefined && s.conversations.some((t, i) => base[i] !== undefined && base[i] !== t.value);
        });
      case 'selected':
        return store.allSamples.filter((s) => selected.has(s.id) && !s.deleted);
      default:
        return filtered.filter((s) => !s.deleted);
    }
  }, [batchSettings.scope, store, selected, filtered]);

  /**
   * How many individual turns the batch would send to the model.
   *
   * Shown next to the button because "修改 N 条" alone hides the real cost: one
   * sample can hold several eligible turns, and the request count — not the
   * sample count — is what drives the time and the token spend.
   *
   * Mirrors the job selection in `useBatch.start`; if the two ever diverge the
   * preview would lie, so both filter on the same role and skip empty turns.
   */
  const batchTurnCount = useMemo(() => {
    let n = 0;
    for (const s of batchTargets) {
      if (s.deleted) continue;
      for (const turn of s.conversations) {
        const isGpt = turn.from === 'gpt' || turn.from === 'assistant';
        if (batchSettings.targetRole === 'gpt' && !isGpt) continue;
        if (batchSettings.targetRole === 'human' && isGpt) continue;
        if (turn.value.trim().length === 0) continue;
        n++;
      }
    }
    return n;
  }, [batchTargets, batchSettings.targetRole]);

  /**
   * Keyboard shortcuts, kept in a ref so the listener is registered once.
   *
   * `store` is a fresh object on every render, so listing it as a dependency
   * would tear down and re-add the listener on every keystroke. Reading the
   * latest handlers through a ref keeps the effect stable.
   */
  const shortcuts = useRef({ undo: store.undo, redo: store.redo, notify });
  shortcuts.current = { undo: store.undo, redo: store.redo, notify };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = Boolean(
        target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable),
      );

      const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z';
      const isRedo =
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'));

      if (isUndo) {
        // Inside a textarea the browser's own per-field undo is what the user
        // expects, so the global shortcut stands down while typing.
        if (target?.tagName === 'TEXTAREA') return;
        e.preventDefault();
        if (shortcuts.current.undo()) shortcuts.current.notify('ok', '已撤销');
      } else if (isRedo) {
        // Ctrl+Shift+Z must not be swallowed while typing in a field either.
        if (typing) return;
        e.preventDefault();
        if (shortcuts.current.redo()) shortcuts.current.notify('ok', '已重做');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const doImport = async (directory: boolean) => {
    setImportOpen(false);
    try {
      const report = directory ? await store.importDirectory() : await store.importFiles();
      if (report.files === 0) {
        notify('err', '没有导入任何数据集文件');
        return;
      }
      notify(
        'ok',
        `已导入 ${report.files} 个文件，共 ${report.samples} 条` +
          (report.warnings.length ? `（${report.warnings.length} 条警告）` : ''),
      );
      if (report.warnings.length) {
        console.warn('[导入警告]', report.warnings);
      }
    } catch (err) {
      notify('err', `导入失败: ${(err as Error).message}`);
    }
  };

  /**
   * Saves every pending change into the chosen JSONL file.
   *
   * The imported datasets are only ever read, never written back to, so this
   * always produces a new file. `store.save` additionally refuses a name that
   * matches an imported file, since the native writer would replace it.
   */
  const doSave = async (fileName: string): Promise<void> => {
    try {
      const path = await store.save(fileName);
      setSaveOpen(false);
      notify('ok', `已保存 ${store.liveSampleCount} 条到 ${path}`);
    } catch (err) {
      notify('err', `保存失败: ${(err as Error).message}`);
    }
  };

  /**
   * Saves the change log beside the data, for reviewing what a cleaning pass
   * altered. It is a separate file so it can never collide with the dataset.
   */
  const doSaveReport = async (fileName: string): Promise<void> => {
    try {
      const path = await store.exportDiffReport(fileName);
      notify('ok', `改动记录已保存到 ${path}`);
    } catch (err) {
      notify('err', `保存失败: ${(err as Error).message}`);
    }
  };

  /**
   * Rewrites a single turn with the model, using the same instruction as the
   * batch run so the two paths behave identically.
   */
  const rewriteTurn = async (sampleId: string, turnIndex: number): Promise<void> => {
    const found = store.sampleById(sampleId);
    if (!found) return;
    if (!config.apiKey.trim()) {
      notify('err', '请先在设置中填写 API Key');
      setSettingsOpen(true);
      return;
    }

    const key = `${sampleId}:${turnIndex}`;
    setAiBusy((prev) => new Set(prev).add(key));
    try {
      const before = found.sample.conversations[turnIndex]?.value ?? '';
      const messages = buildRewriteMessages(
        config,
        batchSettings.instruction,
        found.sample.conversations,
        turnIndex,
      );
      // Passing the original text lets the client tell the model's own reasoning
      // apart from a chain of thought that belongs to the dataset.
      const res = await chat(config, messages, { sourceText: before });

      if (res.truncated) {
        notify(
          'err',
          `AI 输出被 max_tokens (${config.maxTokens}) 截断，已放弃应用以免丢失原文。请调大 max_tokens。`,
        );
      } else if (res.content.trim().length === 0) {
        notify(
          'err',
          res.hadThinking
            ? '剥离思考内容后为空，请检查设置里的思考标签'
            : '模型返回空内容',
        );
      } else if (res.content.trim() === before.trim()) {
        notify('ok', 'AI 认为这一轮无需修改');
      } else {
        store.updateTurn(sampleId, turnIndex, res.content, undefined);
        notify(
          'ok',
          res.hadThinking ? 'AI 已改写这一轮（已剥离思考内容，可撤销）' : 'AI 已改写这一轮（可撤销）',
        );
      }
    } catch (err) {
      notify('err', `AI 改写失败: ${(err as Error).message}`);
    } finally {
      setAiBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const runBatch = async () => {
    if (batchTargets.length === 0) {
      notify('err', '当前范围内没有可处理的数据');
      return;
    }
    if (!config.apiKey.trim()) {
      notify('err', '请先在设置中填写 API Key');
      setSettingsOpen(true);
      return;
    }
    batch.reset();
    await batch.start(batchTargets, batchSettings, config, (sampleId, turnIndex, value) => {
      store.updateTurn(sampleId, turnIndex, value, undefined);
    });
    notify('ok', '批量修改完成，结果已应用（可 Ctrl+Z 撤销）');
  };

  const testConnection = async (): Promise<string> => {
    const res = await chat(config, [
      { role: 'system', content: '你是一个测试助手，只回复：连接正常' },
      { role: 'user', content: '测试' },
    ]);
    return res.content;
  };

  const fetchModels = async (): Promise<string[]> => listModels(config);

  const listRef = useRef<HTMLDivElement | null>(null);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const jumpTo = (id: string) => {
    setVisibleCount((c) => Math.max(c, 1));
    setExpanded((prev) => new Set(prev).add(id));
    setSpotlight(id);
    // Clear the spotlight flag so re-selecting the same row animates again.
    setTimeout(() => setSpotlight(null), 1700);
  };

  const collapsedAll = () => setExpanded(new Set());
  const expandVisible = () => setExpanded(new Set(visible.map((s) => s.id)));

  return (
    <div className="app">
      <Toolbar
        datasetCount={store.datasets.length}
        sampleCount={store.allSamples.length}
        filteredCount={filtered.length}
        changedCount={store.changedCount}
        liveSampleCount={store.liveSampleCount}
        saveTargetLabel={store.saveTarget?.label ?? null}
        canUndo={store.canUndo}
        canRedo={store.canRedo}
        onOpenImport={() => setImportOpen(true)}
        onSave={() => void doSave(defaultFileName())}
        onOpenSave={() => setSaveOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onUndo={() => store.undo() && notify('ok', '已撤销')}
        onRedo={() => store.redo() && notify('ok', '已重做')}
        onReset={() => {
          store.resetChanges();
          notify('ok', '已还原全部改动');
        }}
      />

      <SearchBar
        filter={filter}
        onChange={(f) => {
          setFilter(f);
          setVisibleCount(PAGE_SIZE);
        }}
        onCollapseAll={collapsedAll}
        onExpandVisible={expandVisible}
      />

      <BatchPanel
        settings={batchSettings}
        onSettingsChange={setBatchSettings}
        progress={batch.progress}
        targetCount={batchTargets.length}
        targetTurnCount={batchTurnCount}
        onStart={runBatch}
        onCancel={batch.cancel}
        onJumpTo={jumpTo}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="list" ref={listRef}>
        {store.datasets.length === 0 && (
          <div className="empty">
            <h2>还没有导入数据</h2>
            <p>
              点击上方 <b>导入</b> 选择数据集文件或多个目录。
              <br />
              支持 <code>.json</code>（单条）与 <code>.jsonl</code>（多条），
              字段格式为 ShareGPT（<code>conversations[].from/value</code>）。
            </p>
          </div>
        )}

        {store.datasets.length > 0 && filtered.length === 0 && (
          <div className="empty">
            <h2>没有匹配的数据</h2>
            <p>试着放宽筛选条件。</p>
          </div>
        )}

        {visible.map((sample, i) => (
          <div key={sample.id} className="row-wrap">
            <label className="row-check">
              <input
                type="checkbox"
                checked={selected.has(sample.id)}
                onChange={(e) => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(sample.id);
                    else next.delete(sample.id);
                    return next;
                  });
                }}
                aria-label={`选择第 ${i + 1} 条`}
              />
            </label>
            <SampleCard
              sample={sample}
              index={store.allSamples.indexOf(sample)}
              baseline={store.baselineFor(sample.id)}
              expanded={expanded.has(sample.id)}
              spotlight={spotlight === sample.id}
              onToggle={() => toggleExpand(sample.id)}
              onTurnChange={(turnIndex, value) =>
                store.updateTurn(sample.id, turnIndex, value, `${sample.id}:${turnIndex}`)
              }
              onAskAi={(turnIndex) => void rewriteTurn(sample.id, turnIndex)}
              aiBusyTurns={aiBusy}
              onDeleteTurn={(turnIndex) => store.deleteTurn(sample.id, turnIndex)}
              onInsertTurn={(afterIndex) => store.addTurn(sample.id, afterIndex)}
              onDuplicate={() => store.duplicateSample(sample.id)}
              onDelete={() => store.deleteSample(sample.id)}
              onRestore={() => store.restoreSample(sample.id)}
            />
          </div>
        ))}

        {visible.length < filtered.length && (
          <button
            type="button"
            className="load-more"
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE * 2)}
          >
            加载更多（还有 {filtered.length - visible.length} 条）
          </button>
        )}
      </main>

      <ImportSheet
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onPick={(dir) => doImport(dir)}
        datasets={store.datasets.map((d) => ({
          id: d.id,
          name: d.name,
          count: d.samples.length,
          warnings: d.warnings.length,
        }))}
        onRemove={(id) => store.removeDataset(id)}
      />

      <SaveSheet
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        defaultName={defaultFileName()}
        onSave={doSave}
        onSaveReport={doSaveReport}
        backendKind={getBackend().kind}
        targetLabel={store.saveTarget?.label ?? null}
        onChooseTarget={() => store.chooseSaveTarget()}
        liveSampleCount={store.liveSampleCount}
        changedCount={store.changedCount}
        findConflict={store.findSourceConflict}
        onNotify={notify}
      />

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        onChange={setConfig}
        batch={batchSettings}
        onBatchChange={setBatchSettings}
        onTest={testConnection}
        onFetchModels={fetchModels}
      />

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}

/**
 * Default output file name, derived from the imported files when possible so
 * the result is recognisable next to its source.
 *
 * The name never equals a source name: it carries a `.cleaned` marker, which is
 * what keeps a careless save from overwriting the imported dataset.
 */
function defaultFileName(): string {
  return 'dataset.cleaned.jsonl';
}

/* ------------------------------------------------------------------ */
/* Import / save sheets                                                */
/* ------------------------------------------------------------------ */

interface ImportSheetProps {
  open: boolean;
  onClose: () => void;
  onPick: (directory: boolean) => void;
  datasets: { id: string; name: string; count: number; warnings: number }[];
  onRemove: (id: string) => void;
}

function ImportSheet({ open, onClose, onPick, datasets, onRemove }: ImportSheetProps) {
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer sheet" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>导入数据集</h2>
          <button type="button" className="mini" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="sheet-actions">
          <button type="button" className="primary big" onClick={() => onPick(false)}>
            选择文件（可多选）
          </button>
          <button type="button" className="primary big" onClick={() => onPick(true)}>
            选择目录（递归导入）
          </button>
        </div>

        <p className="hint">
          单个文件会按内容自动判断是 JSON 还是 JSONL；扩展名 <code>.jsonl</code>/
          <code>.ndjson</code> 直接按行解析。
        </p>

        <section className="field-group">
          <h3>已导入（{datasets.length}）</h3>
          {datasets.length === 0 && <p className="hint">暂无。</p>}
          <ul className="file-list">
            {datasets.map((d) => (
              <li key={d.id}>
                <span className="file-name" title={d.name}>
                  {d.name}
                </span>
                <span className="file-meta">
                  {d.count} 条{d.warnings > 0 ? ` · ${d.warnings} 警告` : ''}
                </span>
                <button type="button" className="mini danger" onClick={() => onRemove(d.id)}>
                  移除
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}

interface SaveSheetProps {
  open: boolean;
  onClose: () => void;
  defaultName: string;
  onSave: (fileName: string) => Promise<void>;
  onSaveReport: (fileName: string) => Promise<void>;
  backendKind: 'capacitor' | 'browser';
  /** Remembered destination label, or null when none chosen yet. */
  targetLabel: string | null;
  onChooseTarget: () => Promise<{ label: string }>;
  liveSampleCount: number;
  changedCount: number;
  /** Returns the imported file name that `fileName` would overwrite. */
  findConflict: (fileName: string) => string | null;
  onNotify: (kind: 'ok' | 'err', text: string) => void;
}

/**
 * Save destination sheet.
 *
 * Shows where the file will go and how much will be written before committing,
 * and refuses a name that matches an imported dataset: the native writer
 * replaces a same-named file, so allowing it would destroy the input the user is
 * still working from.
 */
function SaveSheet({
  open,
  onClose,
  defaultName,
  onSave,
  onSaveReport,
  backendKind,
  targetLabel,
  onChooseTarget,
  liveSampleCount,
  changedCount,
  findConflict,
  onNotify,
}: SaveSheetProps) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  if (!open) return null;

  const rawName = name.trim();
  const finalName = !rawName ? defaultName : rawName.endsWith('.jsonl') ? rawName : `${rawName}.jsonl`;
  const conflict = findConflict(finalName);
  const reportName = finalName.replace(/\.jsonl$/, '.diff.jsonl');

  const pickTarget = async () => {
    try {
      const t = await onChooseTarget();
      onNotify('ok', `保存目录已设为 ${t.label}`);
    } catch (err) {
      onNotify('err', `选择目录失败: ${(err as Error).message}`);
    }
  };

  const runSave = async () => {
    setBusy(true);
    try {
      await onSave(finalName);
    } finally {
      setBusy(false);
    }
  };

  const runReport = async () => {
    setBusy(true);
    try {
      await onSaveReport(reportName);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer sheet" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>保存</h2>
          <button type="button" className="mini" onClick={onClose}>
            关闭
          </button>
        </header>

        <section className="field-group">
          <h3>保存位置</h3>
          <div className="target-row">
            <span className="target-path" title={targetLabel ?? undefined}>
              {backendKind === 'browser'
                ? '浏览器下载目录'
                : targetLabel ?? '尚未选择目录'}
            </span>
            {backendKind === 'capacitor' && (
              <button type="button" className="mini" onClick={pickTarget}>
                {targetLabel ? '更改' : '选择目录'}
              </button>
            )}
          </div>
          <p className="hint">
            {backendKind === 'capacitor'
              ? '只写入你选择的目录，导入的原始文件不会被修改。'
              : '浏览器会下载到默认下载目录；导入的原始文件不会被修改。'}
          </p>
        </section>

        <label className="field-group">
          文件名
          <input
            type="text"
            value={name}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {conflict && (
          <div className="warn-box">
            <strong>「{conflict}」是你导入的原始文件，不能覆盖。</strong>
            <p>
              保存会写到新文件，原始数据始终保持不变。建议改用：
              <code>{suggestName(finalName)}</code>
            </p>
            <button
              type="button"
              className="mini"
              onClick={() => setName(suggestName(finalName))}
            >
              使用这个文件名
            </button>
          </div>
        )}

        <div className="save-summary">
          将写入 <b>{liveSampleCount}</b> 条（已改动 {changedCount} 条）；
          标记删除的条目不会写入。
        </div>

        <div className="sheet-actions">
          <button
            type="button"
            className="primary big"
            onClick={runSave}
            disabled={busy || Boolean(conflict) || liveSampleCount === 0}
          >
            {busy ? '保存中…' : `保存到 ${finalName}`}
          </button>
          <button
            type="button"
            className="mini big"
            onClick={runReport}
            disabled={busy || changedCount === 0}
          >
            另存改动记录 ({reportName})
          </button>
        </div>

        <p className="hint">
          保存为 UTF-8 JSONL，每行一条 ShareGPT 记录；<code>_input_fingerprint</code>
          与其他未知字段原样保留。
        </p>
      </aside>
    </div>
  );
}
