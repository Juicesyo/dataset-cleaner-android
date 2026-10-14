import { useEffect, useState } from 'react';
import type { LlmConfig } from '../lib/llm';
import { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT } from '../lib/llm';

/**
 * Settings drawer: API endpoint, system prompt and batch options.
 *
 * The API key is persisted in localStorage on the device only. It is never
 * written into a dataset file nor into the exported diff report.
 */

const STORAGE_KEY = 'apk-evaluator.llm-config.v1';

export function loadConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<LlmConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: LlmConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* storage may be unavailable in private mode; non-fatal */
  }
}

export interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  config: LlmConfig;
  onChange: (config: LlmConfig) => void;
  /** Batch controls. */
  batch: BatchSettings;
  onBatchChange: (next: BatchSettings) => void;
  onTest: () => Promise<string>;
}

export interface BatchSettings {
  instruction: string;
  concurrency: number;
  /** "all" | "changed" | "selected" | "filtered" */
  scope: 'filtered' | 'changed' | 'selected';
  targetRole: 'gpt' | 'human' | 'both';
}

export function SettingsDrawer({
  open,
  onClose,
  config,
  onChange,
  batch,
  onBatchChange,
  onTest,
}: SettingsDrawerProps) {
  const [testState, setTestState] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [testMessage, setTestMessage] = useState('');

  // Persist on every change; the payload is tiny.
  useEffect(() => {
    saveConfig(config);
  }, [config]);

  const set = <K extends keyof LlmConfig>(key: K, value: LlmConfig[K]) =>
    onChange({ ...config, [key]: value });

  const runTest = async () => {
    setTestState('running');
    setTestMessage('');
    try {
      const reply = await onTest();
      setTestState('ok');
      setTestMessage(reply.slice(0, 200));
    } catch (err) {
      setTestState('fail');
      setTestMessage((err as Error).message);
    }
  };

  if (!open) return null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>设置</h2>
          <button type="button" className="mini" onClick={onClose}>
            关闭
          </button>
        </header>

        <section className="field-group">
          <h3>LLM 接口（OpenAI 兼容）</h3>
          <label>
            Base URL
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={config.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <p className="hint">
            填到 <code>/v1</code> 即可，会自动补 <code>/chat/completions</code>。
          </p>

          <label>
            API Key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={config.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder="sk-..."
            />
          </label>

          <label>
            模型
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={config.model}
              onChange={(e) => set('model', e.target.value)}
              placeholder="gpt-4o-mini"
            />
          </label>

          <div className="row">
            <label>
              temperature
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={config.temperature}
                onChange={(e) => set('temperature', Number(e.target.value))}
              />
            </label>
            <label>
              max_tokens
              <input
                type="number"
                step="128"
                min="1"
                value={config.maxTokens}
                onChange={(e) => set('maxTokens', Number(e.target.value))}
              />
            </label>
          </div>

          <label>
            附加请求体 (JSON，可空)
            <textarea
              className="code"
              rows={3}
              spellCheck={false}
              value={config.extraBody}
              onChange={(e) => set('extraBody', e.target.value)}
              placeholder='{"top_p": 0.9}'
            />
          </label>
        </section>

        <section className="field-group">
          <h3>系统提示词</h3>
          <textarea
            className="code"
            rows={8}
            spellCheck={false}
            value={config.systemPrompt}
            onChange={(e) => set('systemPrompt', e.target.value)}
          />
          <button
            type="button"
            className="mini"
            onClick={() => set('systemPrompt', DEFAULT_SYSTEM_PROMPT)}
          >
            恢复默认提示词
          </button>
        </section>

        <section className="field-group">
          <h3>批量修改</h3>
          <label>
            修改要求（用户指令）
            <textarea
              rows={3}
              value={batch.instruction}
              onChange={(e) => onBatchChange({ ...batch, instruction: e.target.value })}
              placeholder="例如：修正错别字与标点，去掉无意义的重复，保持原意。"
            />
          </label>

          <label>
            作用范围
            <select
              value={batch.scope}
              onChange={(e) =>
                onBatchChange({ ...batch, scope: e.target.value as BatchSettings['scope'] })
              }
            >
              <option value="filtered">当前筛选结果</option>
              <option value="changed">仅已被手动改动的条目</option>
              <option value="selected">仅勾选的条目</option>
            </select>
          </label>

          <label>
            修改哪些轮次
            <select
              value={batch.targetRole}
              onChange={(e) =>
                onBatchChange({ ...batch, targetRole: e.target.value as BatchSettings['targetRole'] })
              }
            >
              <option value="gpt">仅模型回复 (gpt)</option>
              <option value="human">仅用户输入 (human)</option>
              <option value="both">两者都改</option>
            </select>
          </label>

          <label>
            并发数
            <input
              type="number"
              min="1"
              max="12"
              value={batch.concurrency}
              onChange={(e) =>
                onBatchChange({ ...batch, concurrency: Number(e.target.value) })
              }
            />
          </label>
          <p className="hint">并发过高容易被服务端限流，建议 2–4。</p>
        </section>

        <section className="field-group">
          <h3>连通性测试</h3>
          <button type="button" className="primary" onClick={runTest} disabled={testState === 'running'}>
            {testState === 'running' ? '测试中…' : '测试连接'}
          </button>
          {testState !== 'idle' && testState !== 'running' && (
            <pre className={`test-result ${testState}`}>{testMessage}</pre>
          )}
        </section>
      </aside>
    </div>
  );
}
