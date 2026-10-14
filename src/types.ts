/**
 * Domain model.
 *
 * The dataset format is a ShareGPT-style record:
 *
 *   {"conversations": [{"from": "human", "value": ""}, {"from": "gpt", "value": ""}],
 *    "_input_fingerprint": ""}
 *
 * `_input_fingerprint` is an opaque field as far as this tool is concerned: it is
 * preserved verbatim on load and on save, and never regenerated, because it is
 * produced by an upstream pipeline that we do not own.
 */

/** A single conversational turn, in ShareGPT shape. */
export interface Turn {
  from: string;
  value: string;
}

/** One dataset sample. Extra top-level keys are preserved in `extra`. */
export interface Sample {
  /** Stable identity for React keys and for diff/undo bookkeeping. */
  id: string;
  conversations: Turn[];
  /** e.g. `_input_fingerprint` — preserved through every edit. */
  fingerprint?: string;
  /** Any other top-level keys found in the source record. */
  extra: Record<string, unknown>;
  /** Which imported dataset this came from. */
  sourceId: string;
  /** 1-based line number within its source file, for error reporting. */
  sourceLine: number;
  /** Set when the row was deleted by the user (soft delete, so undo works). */
  deleted?: boolean;
}

/** A loaded dataset file. */
export interface Dataset {
  id: string;
  /** File name as shown in the UI. */
  name: string;
  /** SAF/DocumentFile URI, or the browser File handle key. */
  uri?: string;
  /** "single" = one JSON object, "jsonl" = one object per line. */
  kind: 'single' | 'jsonl';
  samples: Sample[];
  /** Non-fatal problems encountered while parsing. */
  warnings: string[];
}

/** The mutable slice of a sample that the editor works on. */
export interface SampleEdit {
  id: string;
  sourceId: string;
  sourceLine: number;
  conversations: Turn[];
  fingerprint?: string;
  extra: Record<string, unknown>;
}

/**
 * Per-turn edit state. `undoStack` holds previous values of the turn, newest
 * last, so Ctrl+Z is a pop.
 */
export interface TurnHistoryEntry {
  before: string;
  after: string;
  at: number;
  origin: 'manual' | 'llm';
}
