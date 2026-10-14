import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A textarea that grows to fit its content.
 *
 * On a phone a fixed-height textarea makes long replies painful to review, so
 * the box expands to the content height and only then scrolls internally.
 *
 * Two details matter for correctness:
 *
 *  - The cap is relative to the viewport, not a fixed pixel count. A fixed
 *    2000px cap is roughly 2.4 phone screens tall, so the box swallowed the page
 *    while long text was still clipped below the fold. `maxViewportFraction`
 *    keeps the box within a fraction of the visible area instead.
 *
 *  - `scrollHeight` measures the content box plus padding but excludes the
 *    border, while `box-sizing: border-box` means a set `height` includes it.
 *    Setting `height = scrollHeight` therefore left the last line clipped by the
 *    border width, so the border is added back explicitly.
 */

export interface AutoGrowTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  placeholder?: string;
  minHeight?: number;
  /** Absolute pixel ceiling, applied on top of the viewport-relative cap. */
  maxHeight?: number;
  /** Share of the visible viewport the box may occupy before it scrolls. */
  maxViewportFraction?: number;
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Receives the underlying element so siblings can stay in sync. */
  textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  /**
   * Called after every fit with the textarea, so a mirrored layer can copy the
   * scroll offset and content width.
   */
  onFit?: (el: HTMLTextAreaElement) => void;
  /** Fired on user scroll of the textarea itself. */
  onScroll?: (el: HTMLTextAreaElement) => void;
}

/** Height of the usable viewport, preferring the visual viewport when present. */
function viewportHeight(): number {
  if (typeof window === 'undefined') return 800;
  return window.visualViewport?.height ?? window.innerHeight ?? 800;
}

export function AutoGrowTextarea({
  value,
  onChange,
  onFocus,
  placeholder,
  minHeight = 44,
  maxHeight = Number.POSITIVE_INFINITY,
  maxViewportFraction = 0.6,
  readOnly,
  className,
  ariaLabel,
  textareaRef,
  onFit,
  onScroll,
}: AutoGrowTextareaProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? localRef;

  /** Recomputed on resize/rotation because the usable height changes. */
  const [viewportCap, setViewportCap] = useState(() =>
    Math.round(viewportHeight() * maxViewportFraction),
  );

  useEffect(() => {
    const update = () =>
      setViewportCap(Math.round(viewportHeight() * maxViewportFraction));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [maxViewportFraction]);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // Reset first so the measured height is not clamped by the previous value.
    el.style.height = 'auto';

    const cs = getComputedStyle(el);
    const borderY =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);

    const ceiling = Math.max(minHeight, Math.min(maxHeight, viewportCap));
    const wanted = el.scrollHeight + borderY;
    const next = Math.min(Math.max(wanted, minHeight), ceiling);

    el.style.height = `${next}px`;

    // Only scroll once the ceiling is reached; below it the box fits exactly.
    el.style.overflowY = wanted > ceiling ? 'auto' : 'hidden';

    onFit?.(el);
  }, [ref, minHeight, maxHeight, viewportCap, onFit]);

  useLayoutEffect(fit, [value, fit]);

  useEffect(() => {
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [fit]);

  return (
    <textarea
      ref={ref}
      className={className}
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={onFocus}
      onScroll={(e) => onScroll?.(e.currentTarget)}
      onChange={(e) => {
        onChange(e.target.value);
        // Re-fit on the next frame so the caret stays anchored.
        requestAnimationFrame(fit);
      }}
      onInput={fit}
    />
  );
}
