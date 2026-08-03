// Adapted from beUI Input (MIT): https://beui.dev/components/motion/input
import { animate, motion, useReducedMotion } from "motion/react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";
import { cn } from "../../lib/utils";

export interface BeUiInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  label?: string;
  error?: string | boolean;
  success?: boolean;
  onValueChange?: (value: string) => void;
  onChange?: InputHTMLAttributes<HTMLInputElement>["onChange"];
  inputClassName?: string;
}

export const BeUiInput = forwardRef<HTMLInputElement, BeUiInputProps>(function BeUiInput(
  { label, error, success, onValueChange, onChange, className, inputClassName, id: idProp, onFocus, onBlur, ...props },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const reduceMotion = useReducedMotion();
  const field = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const hasError = Boolean(error);

  useEffect(() => {
    if (!field.current || reduceMotion || !hasError) return;
    animate(field.current, { x: [0, -5, 5, -3, 3, 0] }, { duration: 0.38 });
  }, [hasError, reduceMotion]);

  return (
    <label className={cn("block", className)} htmlFor={id}>
      {label ? <span className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span> : null}
      <div
        ref={field}
        className={cn(
          "relative min-h-10 overflow-hidden rounded-md border bg-white shadow-sm transition duration-200 dark:bg-neutral-950",
          focused && !hasError ? "border-black ring-2 ring-black/10 dark:border-white dark:ring-white/15" : "border-neutral-300 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-600",
          hasError && "border-red-500 ring-2 ring-red-500/15",
        )}
      >
        <input
          ref={ref}
          id={id}
          aria-invalid={hasError || undefined}
          {...props}
          onChange={(event) => {
            onChange?.(event);
            onValueChange?.(event.target.value);
          }}
          onFocus={(event) => { setFocused(true); onFocus?.(event); }}
          onBlur={(event) => { setFocused(false); onBlur?.(event); }}
          className={cn("min-h-10 w-full bg-transparent px-3 text-sm text-black outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:opacity-60 dark:text-white dark:placeholder:text-neutral-600", inputClassName)}
        />
        {success ? (
          <motion.svg className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-emerald-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <motion.path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" initial={reduceMotion ? { pathLength: 1 } : { pathLength: 0 }} animate={{ pathLength: 1 }} />
          </motion.svg>
        ) : null}
      </div>
      {typeof error === "string" ? <span className="mt-1.5 block text-xs text-red-600" role="alert">{error}</span> : null}
    </label>
  );
});
