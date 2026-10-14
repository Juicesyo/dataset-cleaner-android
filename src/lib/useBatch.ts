import { useCallback, useRef, useState } from 'react';
import type { LlmConfig } from './llm';
import { buildRewriteMessages, chat, mapWithConcurrency } from './llm';
import type { Sample } from '../types';
import type { BatchSettings } from '../components/SettingsDrawer';

/**
 * Batch rewrite orchestration.
 *
 * Walks the selected samples, calls the model once per eligible turn, and
 * applies successful results through the store so they land on the normal undo
 * stack and get the same diff colouring as manual edits.
 *
 * Failures are per-item: one bad turn never aborts the batch. Every outcome is
 * reported so the user can see exactly what was skipped and why.
 */

export interface BatchProgress {
  running: boolean;
  done: number;
  total: number;
  ok: number;
  failed: number;
  /** Set once the run finishes. */
  report: BatchItemResult[];
}

export interface BatchItemResult {
  sampleId: string;
  turnIndex: number;
  sourceLine: number;
  status: 'ok' | 'unchanged' | 'error';
  message?: string;
  before?: string;
  after?: string;
}

const EMPTY: BatchProgress = {
  running: false,
  done: 0,
  total: 0,
  ok: 0,
  failed: 0,
  report: [],
};

export interface UseBatch {
  progress: BatchProgress;
  start: (
    samples: Sample[],
    settings: BatchSettings,
    config: LlmConfig,
    apply: (sampleId: string, turnIndex: number, value: string) => void,
  ) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useBatch(): UseBatch {
  const [progress, setProgress] = useState<BatchProgress>(EMPTY);
  const controller = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setProgress((p) => ({ ...p, running: false }));
  }, []);

  const reset = useCallback(() => setProgress(EMPTY), []);

  const start = useCallback(
    async (
      samples: Sample[],
      settings: BatchSettings,
      config: LlmConfig,
      apply: (sampleId: string, turnIndex: number, value: string) => void,
    ) => {
      // Flatten to the list of (sample, turn) jobs the model will see.
      const jobs: { sample: Sample; turnIndex: number }[] = [];
      for (const sample of samples) {
        if (sample.deleted) continue;
        sample.conversations.forEach((turn, turnIndex) => {
          const isGpt = turn.from === 'gpt' || turn.from === 'assistant';
          if (settings.targetRole === 'gpt' && !isGpt) return;
          if (settings.targetRole === 'human' && isGpt) return;
          if (turn.value.trim().length === 0) return;
          jobs.push({ sample, turnIndex });
        });
      }

      if (jobs.length === 0) {
        setProgress({ ...EMPTY, report: [] });
        return;
      }

      const ac = new AbortController();
      controller.current = ac;
      setProgress({ running: true, done: 0, total: jobs.length, ok: 0, failed: 0, report: [] });

      let done = 0;
      let ok = 0;
      let failed = 0;
      const report: BatchItemResult[] = [];

      await mapWithConcurrency(jobs, settings.concurrency, async (job) => {
        const { sample, turnIndex } = job;
        const turn = sample.conversations[turnIndex];
        const result: BatchItemResult = {
          sampleId: sample.id,
          turnIndex,
          sourceLine: sample.sourceLine,
          status: 'error',
        };

        if (ac.signal.aborted) {
          result.message = '已取消';
          report.push(result);
          return;
        }

        try {
          const messages = buildRewriteMessages(
            config,
            settings.instruction,
            sample.conversations,
            turnIndex,
          );
          const res = await chat(config, messages, { signal: ac.signal });
          const out = res.content;

          if (res.truncated) {
            // Applying a cut-off rewrite would silently shorten the sample, so
            // it is reported instead of written.
            result.status = 'error';
            result.message =
              `输出被 max_tokens (${config.maxTokens}) 截断，已跳过以免丢失原文；` +
              '请调大 max_tokens 或缩短该条内容';
            failed++;
          } else if (out.trim().length === 0) {
            result.status = 'error';
            result.message = res.hadThinking
              ? '剥离思考内容后为空，已跳过（请检查思考标签设置）'
              : '模型返回空内容，已跳过';
            failed++;
          } else if (out.trim() === turn.value.trim()) {
            result.status = 'unchanged';
            result.before = turn.value;
            result.after = out;
          } else {
            result.status = 'ok';
            result.before = turn.value;
            result.after = out;
            apply(sample.id, turnIndex, out);
            ok++;
          }
        } catch (err) {
          const e = err as Error;
          if (e.name === 'AbortError') {
            result.message = '已取消';
          } else {
            result.message = e.message;
            failed++;
          }
        }

        report.push(result);
        done++;
        setProgress({
          running: !ac.signal.aborted && done < jobs.length,
          done,
          total: jobs.length,
          ok,
          failed,
          report: [...report],
        });
      });

      controller.current = null;
      setProgress({
        running: false,
        done,
        total: jobs.length,
        ok,
        failed,
        report,
      });
    },
    [],
  );

  return { progress, start, cancel, reset };
}
