import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * A textarea that grows to fit its content.
 *
 * On a phone a fixed-height textarea makes long replies painful to review, so
 * the box expands to the content height (capped by `maxHeight`) and only then
 * scrolls internally. Height is recomputed on value change and on resize,
 * because soft-keyboard orientation changes alter available width.
 */
export interface AutoGrowTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function AutoGrowTextarea({
  value,
  onChange,
  onFocus,
  placeholder,
  minHeight = 44,
  maxHeight = 2000,
  readOnly,
  className,
  ariaLabel,
}: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Reset first so the measured height is not clamped by the previous value.
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [minHeight, maxHeight]);

  useLayoutEffect(fit, [value, fit]);

  useEffect(() => {
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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
      onChange={(e) => {
        onChange(e.target.value);
        // Re-fit on the next frame so the caret stays anchored.
        requestAnimationFrame(fit);
      }}
      onInput={fit}
    />
  );
}
