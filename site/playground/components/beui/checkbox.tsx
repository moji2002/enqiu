// Adapted from beUI Checkbox (MIT): https://beui.dev/components/motion/checkbox
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import { EASE_OUT, SPRING_PRESS } from "../../lib/ease";
import { cn } from "../../lib/utils";

export function BeUiCheckbox({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const reduceMotion = useReducedMotion();
  return (
    <label className={cn("inline-flex min-h-11 items-center gap-3", disabled ? "cursor-not-allowed" : "cursor-pointer", className)} htmlFor={id}>
      <motion.button
        id={id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        whileTap={reduceMotion || disabled ? undefined : { scale: 0.92 }}
        transition={SPRING_PRESS}
        className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded border-2 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50", checked ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black" : "border-neutral-400 bg-white dark:border-neutral-600 dark:bg-neutral-950")}
      >
        <AnimatePresence initial={false}>
          {checked ? (
            <motion.svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" initial={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ duration: 0.16, ease: EASE_OUT }} aria-hidden="true">
              <motion.path d="M5 13l4 4L19 7" initial={reduceMotion ? { pathLength: 1 } : { pathLength: 0 }} animate={{ pathLength: 1 }} />
            </motion.svg>
          ) : null}
        </AnimatePresence>
      </motion.button>
      <span className="text-sm text-black dark:text-white">{label}</span>
    </label>
  );
}
