import { useEffect, useState } from 'react';
import type { LlmConfig } from '../lib/llm';
import { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT, looksLikeReasoningModel } from '../lib/llm';

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
  /** Fetches the endpoint's model list for the picker. */
  onFetchModels: () => Promise<string[]>;
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
  onFetchModels,
}: SettingsDrawerProps) {
  const [testState, setTestState] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelState, setModelState] = useState<'idle' | 'loading' | 'ok' | 'fail'>('idle');
  const [modelMessage, setModelMessage] = useState('');

  // Persist on every change; the payload is tiny.
  useEffect(() => {
    saveConfig(config);
  }, [config]);

  /**
   * Applies a partial update.
   *
   * A merge, not a per-field setter: two setters called in one handler would
   * each spread the same render's `config`, so the second silently discarded
   * the first. That is exactly how "恢复默认" failed to restore the start tag.
   */
  const patch = (next: Partial<LlmConfig>) => onChange({ ...config, ...next });

  const runFetchModels = async () => {
    setModelState('loading');
    setModelMessage('');
    try {
      const ids = await onFetchModels();
      setModels(ids);
      if (ids.length === 0) {
        setModelState('fail');
        setModelMessage('接口没有返回任何模型，可继续手动填写模型名。');
      } else {
        setModelState('ok');
        setModelMessage(`获取到 ${ids.length} 个模型，点击下方列表选择。`);
        // Adopt the first model when the current value is clearly a placeholder.
        if (!ids.includes(config.model) && !config.model.trim()) {
          patch({ model: ids[0] });
        }
      }
    } catch (err) {
      setModelState('fail');
      setModelMessage((err as Error).message);
    }
  };

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
              onChange={(e) => patch({ baseUrl: e.target.value })}
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
              onChange={(e) => patch({ apiKey: e.target.value })}
              placeholder="sk-..."
            />
          </label>

          <label>
            模型
            <div className="model-row">
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={config.model}
                onChange={(e) => patch({ model: e.target.value })}
                placeholder="gpt-4o-mini"
              />
              <button
                type="button"
                className="mini"
                onClick={runFetchModels}
                disabled={modelState === 'loading'}
              >
                {modelState === 'loading' ? '获取中…' : '获取列表'}
              </button>
            </div>
          </label>

          {models.length > 0 && (
            <div className="model-picker">
              <div className="model-chips">
                {models.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`chip ${id === config.model ? 'chip-active' : ''}`}
                    onClick={() => {
                      // Pre-select the model type from the name, and say so, so
                      // a reasoning model is not left mis-configured.
                      const looksReasoning = looksLikeReasoningModel(id);
                      if (looksReasoning !== config.reasoningModel) {
                        patch({ model: id, reasoningModel: looksReasoning });
                        setModelMessage(
                          looksReasoning
                            ? `已根据模型名把「模型类型」自动设为思考模型（${id}）`
                            : `已根据模型名把「模型类型」自动设为普通模型（${id}）`,
                        );
                        setModelState('ok');
                      } else {
                        patch({ model: id });
                      }
                    }}
                    title={id}
                  >
                    {id}
                  </button>
                ))}
              </div>
            </div>
          )}

          {modelState !== 'idle' && modelState !== 'loading' && modelMessage && (
            <p className={`hint ${modelState === 'fail' ? 'hint-err' : ''}`}>{modelMessage}</p>
          )}
          <p className="hint">
            也可以直接手动输入模型名；「获取列表」会请求 <code>/models</code>。
          </p>

          <div className="row">
            <label>
              temperature
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={config.temperature}
                onChange={(e) => patch({ temperature: Number(e.target.value) })}
              />
            </label>
            <label>
              max_tokens
              <input
                type="number"
                step="128"
                min="1"
                value={config.maxTokens}
                onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
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
              onChange={(e) => patch({ extraBody: e.target.value })}
              placeholder='{"top_p": 0.9}'
            />
          </label>
        </section>

        <section className="field-group">
          <h3>思考模型</h3>
          <label>
            模型类型
            <select
              value={config.reasoningModel ? 'reasoning' : 'plain'}
              onChange={(e) => patch({ reasoningModel: e.target.value === 'reasoning' })}
            >
              <option value="plain">普通模型（不处理思考内容）</option>
              <option value="reasoning">思考模型 / 推理模型（剥离思考过程）</option>
            </select>
          </label>

          {!config.reasoningModel ? (
            <p className="hint">
              普通模型不会做任何思考内容处理。如果输出里出现了
              <code>{config.thinkingStartTag || '<think>'}</code> 这类标签，
              会被当作数据集本身的内容原样保留。改用推理模型（如 DeepSeek-R1、QwQ）时请切到上面第二项。
            </p>
          ) : (
            <>
              <p className="hint">
                推理模型（如 DeepSeek-R1、QwQ）会把思考过程直接写在回复里。
                这里设置包裹思考内容的标签，应用时会自动剥离，避免把思考过程写进数据集。
                留空则不做剥离。
              </p>

              <label>
                剥离方式
                <select
                  value={config.thinkingMode}
                  onChange={(e) =>
                    patch({ thinkingMode: e.target.value as LlmConfig['thinkingMode'] })
                  }
                >
                  <option value="auto">自动（推荐）：按原文是否含标签决定</option>
                  <option value="always">总是剥离全部思考块</option>
                  <option value="leading">只剥离开头那一段</option>
                  <option value="never">不剥离</option>
                </select>
              </label>
              <p className="hint">
                <b>如果你的数据集本身就含思维链</b>，请用「自动」：原文不含标签时剥离全部；
                原文含标签时，按「模型新增了几块」判断，只剥离模型自己加的部分，
                数据里的思维链原样保留。
              </p>

              <div className="row">
            <label>
              思考开始标签
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={config.thinkingStartTag}
                onChange={(e) => patch({ thinkingStartTag: e.target.value })}
                placeholder="<think>"
              />
            </label>
            <label>
              思考结束标签
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={config.thinkingEndTag}
                onChange={(e) => patch({ thinkingEndTag: e.target.value })}
                placeholder="</think>"
              />
            </label>
          </div>
          <button
            type="button"
            className="mini"
            onClick={() =>
              // One merged update: two separate calls would both spread this
              // render's `config`, so the second would undo the first and the
              // start tag would never be restored.
              patch({
                thinkingStartTag: DEFAULT_CONFIG.thinkingStartTag,
                thinkingEndTag: DEFAULT_CONFIG.thinkingEndTag,
                thinkingMode: DEFAULT_CONFIG.thinkingMode,
              })
            }
          >
            恢复默认 (&lt;think&gt; … &lt;/think&gt;)
          </button>
          <p className="hint">
            如果模型用了别的标记（例如 <code>&lt;thinking&gt;</code>、
            <code>&lt;reasoning&gt;</code>），改成对应标签即可。只有开始标签、
            没有结束标签时，会从开始标签处全部丢弃，并按「返回空内容」报错。
          </p>
            </>
          )}
        </section>

        <section className="field-group">
          <h3>系统提示词</h3>
          <textarea
            className="code"
            rows={8}
            spellCheck={false}
            value={config.systemPrompt}
            onChange={(e) => patch({ systemPrompt: e.target.value })}
          />
          <button
            type="button"
            className="mini"
            onClick={() => patch({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
          >
            恢复默认提示词
          </button>
        </section>

        <section className="field-group">
          <h3>批量修改</h3>
          <p className="hint">
            修改要求、作用范围与并发数已移到主界面的「用 AI 批量修改」面板，
            在那里可以直接看到会影响多少条数据。
          </p>
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
