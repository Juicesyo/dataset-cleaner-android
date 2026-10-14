import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dataset, Sample, Turn } from '../types';
import { buildJsonl, makeDataset, parseDataset, validateForExport } from './sharegpt';
import { getBackend, kindFromName } from './fs';

/**
 * Central application state.
 *
 * Design notes:
 *  - Samples are immutable-ish: an edit replaces the sample object inside its
 *    dataset, so React re-renders reliably and undo can keep plain snapshots.
 *  - `baseline` holds the *complete turn list* each sample had when the dataset
 *    was imported (not after each edit). Diff colouring compares against it, so
 *    the user always sees the total delta from the original data.
 *
 *    It stores full turns rather than just text because "还原" has to undo
 *    structural edits too. Recording only values meant an added or removed turn
 *    shifted the indices, and restoring by index then wrote the wrong text into
 *    the wrong row — silently duplicating a reply instead of reverting.
 *
 *    Only samples present at import get an entry. Anything absent from the map
 *    was created this session (added or duplicated) and is therefore itself an
 *    edit, which is what lets "还原" remove it.
 */

export interface UndoEntry {
  sampleId: string;
  turnIndex: number;
  before: string;
  after: string;
  origin: 'manual' | 'llm';
  at: number;
  /** Absorb rapid typing so Ctrl+Z does not step back one character at a time. */
  coalesceKey?: string;
}

export interface ImportReport {
  files: number;
  samples: number;
  warnings: string[];
}

export interface UseDatasets {
  datasets: Dataset[];
  importFiles: () => Promise<ImportReport>;
  importDirectory: () => Promise<ImportReport>;
  removeDataset: (id: string) => void;
  allSamples: Sample[];
  sampleById: (id: string) => { sample: Sample; dataset: Dataset } | undefined;
  updateTurn: (sampleId: string, turnIndex: number, value: string, coalesce?: string) => void;
  updateSample: (
    sampleId: string,
    patch: { conversations?: { from: string; value: string }[]; deleted?: boolean },
    origin?: 'manual' | 'llm',
  ) => void;
  addTurn: (sampleId: string, afterIndex: number) => void;
  deleteTurn: (sampleId: string, turnIndex: number) => void;
  duplicateSample: (sampleId: string) => void;
  deleteSample: (sampleId: string) => void;
  restoreSample: (sampleId: string) => void;
  addSample: (datasetId: string) => string | undefined;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  baselineFor: (sampleId: string) => string[] | undefined;
  changedCount: number;
  resetChanges: () => void;
  exportJsonl: (fileName: string) => Promise<string>;
  exportDiffReport: (fileName: string) => Promise<string>;
}

/**
 * Appends an undo entry, merging it into the previous one when it continues the
 * same edit.
 *
 * Pure by construction: given the same `prev` and `entry` it always returns the
 * same result, which is required because React may call this twice.
 *
 * Two entries coalesce only when all of these hold:
 *  - they target the same cell (`coalesceKey`, which includes the sample id and
 *    turn index, so moving to another turn always starts a new step);
 *  - they are the same origin, so an LLM rewrite never merges into typing;
 *  - they are within the coalescing window, so a pause breaks the run.
 *
 * `min(entry.at, last.at + WINDOW)` would let a long typing burst extend
 * forever; anchoring on the original timestamp keeps the window bounded.
 */
export function appendUndo(prev: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const last = prev[prev.length - 1];
  const continues =
    last !== undefined &&
    entry.coalesceKey !== undefined &&
    last.coalesceKey === entry.coalesceKey &&
    last.origin === entry.origin &&
    entry.at - last.at < COALESCE_WINDOW_MS;

  if (continues) {
    // Keep the original `before` and this entry's `after`: the step then spans
    // the whole burst rather than just the last keystroke.
    const merged: UndoEntry = {
      ...last,
      after: entry.after,
      at: entry.at,
    };
    if (merged.before === merged.after) {
      // The burst ended where it started; there is nothing to undo.
      return prev.slice(0, -1);
    }
    return [...prev.slice(0, -1), merged];
  }

  // A no-op edit must not push a step, otherwise undo appears to do nothing.
  if (entry.before === entry.after) return prev;

  return [...prev, entry];
}

/** How long two edits on the same cell merge into one undo step. */
const COALESCE_WINDOW_MS = 1500;

export function useDatasets(): UseDatasets {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);

  /**
   * Mirror of the stacks, kept in sync so undo/redo can read the current top
   * synchronously without threading the mutation through a state updater.
   */
  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);
  undoRef.current = undoStack;
  redoRef.current = redoStack;

  /**
   * Undo steps produced inside a `setDatasets` updater, awaiting the commit.
   * See `updateTurn` for why they cannot be recorded inline.
   */
  const pendingUndo = useRef<UndoEntry[]>([]);

  /** sampleId -> original turn values captured at import time. */
  const baseline = useRef(new Map<string, Turn[]>());
  /** sampleId -> dataset id, rebuilt whenever the sample set changes. */
  const index = useRef(new Map<string, { sample: Sample; dataset: Dataset }>());
  const outputDir = useRef<{ uri: string; label: string } | null>(null);

  // Rebuild the lookup index whenever datasets change.
  index.current = useMemo(() => {
    const map = new Map<string, { sample: Sample; dataset: Dataset }>();
    for (const d of datasets) for (const s of d.samples) map.set(s.id, { sample: s, dataset: d });
    return map;
  }, [datasets]);

  const allSamples = useMemo(
    () => datasets.flatMap((d) => d.samples),
    [datasets],
  );

  /** Applies a mutation to one sample, immutably. */
  const patchSample = useCallback(
    (sampleId: string, fn: (s: Sample) => Sample) => {
      setDatasets((prev) => {
        const next = prev.slice();
        for (let di = 0; di < next.length; di++) {
          const si = next[di].samples.findIndex((s) => s.id === sampleId);
          if (si >= 0) {
            const samples = next[di].samples.slice();
            samples[si] = fn(samples[si]);
            next[di] = { ...next[di], samples };
            return next;
          }
        }
        return prev;
      });
    },
    [],
  );

  /**
   * Records an undo step.
   *
   * The updater must be pure: React 18 StrictMode invokes state updaters twice
   * in development, so any logic that depends on side effects or on mutating
   * captured state would run twice and drop or duplicate entries. The previous
   * implementation read `prev` and refreshed timestamps, which let a blur-triggered
   * change collapse the stack to empty — the undo button then appeared dead.
   */
  const pushUndo = useCallback((entry: UndoEntry) => {
    setUndoStack((prev) => appendUndo(prev, entry));
    setRedoStack((prev) => (prev.length === 0 ? prev : []));
  }, []);

  const importFiles = useCallback(async (): Promise<ImportReport> => importInto(false), []);
  const importDirectory = useCallback(async (): Promise<ImportReport> => importInto(true), []);

  const importInto = useCallback(
    async (directory: boolean): Promise<ImportReport> => {
      const backend = getBackend();
      const picked = directory
        ? await backend.pickDirectory([])
        : await backend.pickFiles([]);

      const warnings: string[] = [];
      let fileCount = 0;
      let sampleCount = 0;
      const added: Dataset[] = [];

      for (const pf of picked) {
        try {
          const text = await backend.readText(pf);
          const ds = makeDataset(pf.name, pf.uri, kindFromName(pf.name) ?? 'jsonl');
          const res = parseDataset(text, ds.id, kindFromName(pf.name));
          if (res.samples.length === 0) {
            warnings.push(`${pf.name}: 没有解析到任何样本`);
            continue;
          }
          ds.samples = res.samples;
          ds.warnings = res.warnings;
          warnings.push(...res.warnings.map((w) => `${pf.name}: ${w}`));
          for (const s of res.samples) {
            // Deep copy: the sample's own array is mutated by later edits.
            baseline.current.set(
              s.id,
              s.conversations.map((t) => ({ from: t.from, value: t.value })),
            );
          }
          added.push(ds);
          fileCount++;
          sampleCount += res.samples.length;
        } catch (err) {
          warnings.push(`${pf.name}: 读取失败 - ${(err as Error).message}`);
        }
      }

      if (added.length) setDatasets((prev) => [...prev, ...added]);
      setUndoStack([]);
      setRedoStack([]);

      return { files: fileCount, samples: sampleCount, warnings };
    },
    [],
  );

  const updateTurn = useCallback(
    (sampleId: string, turnIndex: number, value: string, coalesce?: string) => {
      // Read and write inside one updater so `before` always reflects the
      // committed state rather than a possibly-stale render snapshot, and so a
      // re-entrant call cannot resurrect an older value.
      //
      // The undo entry cannot be captured in a variable here: React may invoke
      // the updater asynchronously or more than once, so anything assigned
      // inside it is unreliable by the time this function returns. Instead the
      // entry is computed inside the updater and handed to a queue that an
      // effect drains once the commit has happened.
      setDatasets((prev) => {
        for (let di = 0; di < prev.length; di++) {
          const si = prev[di].samples.findIndex((s) => s.id === sampleId);
          if (si < 0) continue;

          const sample = prev[di].samples[si];
          const current = sample.conversations[turnIndex];
          if (!current || current.value === value) return prev; // no change

          pendingUndo.current.push({
            sampleId,
            turnIndex,
            before: current.value,
            after: value,
            origin: 'manual',
            at: Date.now(),
            coalesceKey: coalesce,
          });

          const conversations = sample.conversations.slice();
          conversations[turnIndex] = { ...current, value };

          const samples = prev[di].samples.slice();
          samples[si] = { ...sample, conversations };

          const next = prev.slice();
          next[di] = { ...prev[di], samples };
          return next;
        }
        return prev;
      });
    },
    [],
  );

  /**
   * Drains undo entries queued by state updaters.
   *
   * Runs after each commit. Entries are de-duplicated because a double-invoked
   * updater can push the same logical step twice, and duplicate steps would
   * otherwise require two Ctrl+Z presses to undo one edit.
   */
  useEffect(() => {
    const queued = pendingUndo.current;
    if (queued.length === 0) return;
    pendingUndo.current = [];

    setUndoStack((prev) => {
      let next = prev;
      for (const entry of queued) {
        const last = next[next.length - 1];
        // Skip an exact repeat of the step already on top.
        if (
          last &&
          last.sampleId === entry.sampleId &&
          last.turnIndex === entry.turnIndex &&
          last.before === entry.before &&
          last.after === entry.after
        ) {
          continue;
        }
        next = appendUndo(next, entry);
      }
      return next;
    });
    setRedoStack((prev) => (prev.length === 0 ? prev : []));
  }, [datasets]);

  const updateSample = useCallback(
    (
      sampleId: string,
      patch: { conversations?: { from: string; value: string }[]; deleted?: boolean },
      origin: 'manual' | 'llm' = 'manual',
    ) => {
      patchSample(sampleId, (s) => ({
        ...s,
        conversations: patch.conversations ?? s.conversations,
        deleted: patch.deleted ?? s.deleted,
      }));
      // Record an undo entry for the whole-row replacement.
      const found = index.current.get(sampleId);
      if (found && patch.conversations) {
        const before = found.sample.conversations;
        const changed = patch.conversations.findIndex(
          (t, i) => (before[i]?.value ?? '') !== t.value,
        );
        if (changed >= 0) {
          pushUndo({
            sampleId,
            turnIndex: changed,
            before: before[changed]?.value ?? '',
            after: patch.conversations[changed].value,
            origin,
            at: Date.now(),
          });
        }
      }
    },
    [patchSample, pushUndo],
  );

  const addTurn = useCallback(
    (sampleId: string, afterIndex: number) => {
      patchSample(sampleId, (s) => {
        const conversations = s.conversations.slice();
        const role = afterIndex >= 0 && conversations[afterIndex]?.from === 'gpt' ? 'human' : 'gpt';
        conversations.splice(afterIndex + 1, 0, { from: role, value: '' });
        return { ...s, conversations };
      });
    },
    [patchSample],
  );

  const deleteTurn = useCallback(
    (sampleId: string, turnIndex: number) => {
      patchSample(sampleId, (s) => {
        const conversations = s.conversations.filter((_, i) => i !== turnIndex);
        return { ...s, conversations };
      });
    },
    [patchSample],
  );

  const duplicateSample = useCallback(
    (sampleId: string) => {
      setDatasets((prev) => {
        const next = prev.slice();
        for (let di = 0; di < next.length; di++) {
          const si = next[di].samples.findIndex((s) => s.id === sampleId);
          if (si >= 0) {
            const samples = next[di].samples.slice();
            const src = samples[si];
            const copy: Sample = {
              ...src,
              id: `${src.id}-copy-${Math.random().toString(36).slice(2, 6)}`,
              conversations: src.conversations.map((t) => ({ ...t })),
              extra: { ...src.extra },
              // `sourceLine === 0` is the app's marker for a row that was not in
              // the imported file, which drives the "新增" badge.
              sourceLine: 0,
            };
            samples.splice(si + 1, 0, copy);
            next[di] = { ...next[di], samples };
            // Deliberately not registered in `baseline`: a duplicate did not
            // exist at import time, so it is itself an edit and "还原" removes it.
            return next;
          }
        }
        return prev;
      });
    },
    [],
  );

  const deleteSample = useCallback(
    (sampleId: string) => {
      patchSample(sampleId, (s) => ({ ...s, deleted: true }));
    },
    [patchSample],
  );

  const restoreSample = useCallback(
    (sampleId: string) => {
      patchSample(sampleId, (s) => ({ ...s, deleted: false }));
    },
    [patchSample],
  );

  const addSample = useCallback(
    (datasetId: string): string | undefined => {
      const id = `${datasetId}:new-${Math.random().toString(36).slice(2, 8)}`;
      const sample: Sample = {
        id,
        conversations: [
          { from: 'human', value: '' },
          { from: 'gpt', value: '' },
        ],
        extra: {},
        sourceId: datasetId,
        sourceLine: 0,
      };
      setDatasets((prev) =>
        prev.map((d) => (d.id === datasetId ? { ...d, samples: [...d.samples, sample] } : d)),
      );
      // Deliberately not registered in `baseline`: this row did not exist at
      // import time, so it is itself an edit and "还原" removes it.
      return id;
    },
    [],
  );

  /**
   * Steps one entry through the history.
   *
   * The stack is read from a ref rather than from inside a state updater,
   * because a state updater must be pure: React 18 StrictMode calls it twice,
   * which previously applied each undo twice and left the sample value wrong.
   * Reading the ref keeps the mutation and the stack in one consistent pass.
   */
  const step = useCallback(
    (direction: 'undo' | 'redo'): boolean => {
      const stack = direction === 'undo' ? undoRef.current : redoRef.current;
      const entry = stack[stack.length - 1];
      if (!entry) return false;

      const target = direction === 'undo' ? entry.before : entry.after;
      patchSample(entry.sampleId, (s) => {
        const conversations = s.conversations.slice();
        if (conversations[entry.turnIndex]) {
          conversations[entry.turnIndex] = { ...conversations[entry.turnIndex], value: target };
        }
        return { ...s, conversations };
      });

      if (direction === 'undo') {
        setUndoStack((s) => s.slice(0, -1));
        setRedoStack((r) => [...r, entry]);
      } else {
        setRedoStack((r) => r.slice(0, -1));
        setUndoStack((s) => [...s, entry]);
      }
      return true;
    },
    [patchSample],
  );

  const undo = useCallback((): boolean => step('undo'), [step]);
  const redo = useCallback((): boolean => step('redo'), [step]);

  /**
   * The imported turn values for a sample, or `undefined` when the sample was
   * created this session. The UI needs only the text, so the roles recorded in
   * the baseline map are projected away here.
   */
  const baselineFor = useCallback(
    (sampleId: string): string[] | undefined => baseline.current.get(sampleId)?.map((t) => t.value),
    [],
  );

  /**
   * Number of samples that differ from the imported data in any way: edited
   * text, changed roles, added or removed turns, marked deleted, or created
   * this session.
   *
   * Deletions and additions must be counted, otherwise "还原" would look
   * unavailable while there is still something to revert.
   */
  const changedCount = useMemo(() => {
    let n = 0;
    for (const s of allSamples) {
      const base = baseline.current.get(s.id);
      // Created this session (added or duplicated).
      if (!base) {
        n++;
        continue;
      }
      if (s.deleted) {
        n++;
        continue;
      }
      if (base.length !== s.conversations.length) {
        n++;
        continue;
      }
      if (
        s.conversations.some(
          (t, i) => t.value !== base[i].value || t.from !== base[i].from,
        )
      ) {
        n++;
      }
    }
    return n;
  }, [allSamples]);

  /**
   * Discards every change made this session, returning the data to exactly what
   * was imported.
   *
   * This restores the whole turn list rather than patching values by index, so
   * added and removed turns are undone correctly. Restoring by index previously
   * misaligned the baseline whenever the turn count changed, writing one reply's
   * text into another row and duplicating it.
   *
   * Rows created this session have no baseline entry and are dropped, and the
   * `deleted` flag is cleared — otherwise a marked-for-deletion row would stay
   * deleted and "还原" would appear to do nothing.
   */
  const resetChanges = useCallback(() => {
    setDatasets((prev) =>
      prev.map((d) => ({
        ...d,
        samples: d.samples
          .filter((s) => baseline.current.has(s.id))
          .map((s) => {
            const base = baseline.current.get(s.id) as Turn[];
            return {
              ...s,
              deleted: false,
              conversations: base.map((t) => ({ from: t.from, value: t.value })),
            };
          }),
      })),
    );
    // Any queued steps belong to edits that no longer exist.
    pendingUndo.current = [];
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  const ensureOutputDir = useCallback(async () => {
    if (!outputDir.current) {
      outputDir.current = await getBackend().pickOutputDirectory();
    }
    return outputDir.current;
  }, []);

  const exportJsonl = useCallback(
    async (fileName: string): Promise<string> => {
      const live = allSamples.filter((s) => !s.deleted);
      if (live.length === 0) throw new Error('没有可导出的数据');
      const problems = validateForExport(live);
      if (problems.length) {
        throw new Error(`导出前校验失败：\n${problems.slice(0, 8).join('\n')}`);
      }
      const dir = await ensureOutputDir();
      const text = buildJsonl(live);
      return await getBackend().writeTextToDirectory(dir.uri, fileName, text);
    },
    [allSamples, ensureOutputDir],
  );

  const exportDiffReport = useCallback(
    async (fileName: string): Promise<string> => {
      const lines: string[] = [];
      lines.push(
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          totalSamples: allSamples.filter((s) => !s.deleted).length,
          changedSamples: changedCount,
        }),
      );
      for (const s of allSamples) {
        const base = baseline.current.get(s.id);
        const header = { id: s.id, source: s.sourceId, sourceLine: s.sourceLine };

        // A row created this session has no baseline entry.
        if (!base) {
          lines.push(JSON.stringify({ ...header, created: true, conversations: s.conversations }));
          if (s.deleted) lines.push(JSON.stringify({ ...header, deleted: true }));
          continue;
        }

        if (s.deleted) {
          lines.push(JSON.stringify({ ...header, deleted: true }));
          continue;
        }

        // Turn-by-turn changes, including role changes.
        s.conversations.forEach((t, i) => {
          const before = base[i];
          if (before === undefined) {
            lines.push(
              JSON.stringify({ ...header, turn: i, role: t.from, added: true, after: t.value }),
            );
            return;
          }
          if (before.value === t.value && before.from === t.from) return;
          lines.push(
            JSON.stringify({
              ...header,
              turn: i,
              role: t.from,
              ...(before.from !== t.from ? { beforeRole: before.from } : {}),
              before: before.value,
              after: t.value,
            }),
          );
        });

        // Turns that no longer exist.
        for (let i = s.conversations.length; i < base.length; i++) {
          lines.push(
            JSON.stringify({
              ...header,
              turn: i,
              role: base[i].from,
              removed: true,
              before: base[i].value,
            }),
          );
        }
      }
      const dir = await ensureOutputDir();
      return await getBackend().writeTextToDirectory(dir.uri, fileName, lines.join('\n') + '\n');
    },
    [allSamples, changedCount, ensureOutputDir],
  );

  return {
    datasets,
    importFiles,
    importDirectory,
    removeDataset: (id: string) => setDatasets((prev) => prev.filter((d) => d.id !== id)),
    allSamples,
    sampleById: (id: string) => index.current.get(id),
    updateTurn,
    updateSample,
    addTurn,
    deleteTurn,
    duplicateSample,
    deleteSample,
    restoreSample,
    addSample,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    baselineFor,
    changedCount,
    resetChanges,
    exportJsonl,
    exportDiffReport,
  };
}
