// Adapted from beUI Checkbox (MIT): https://beui.dev/components/motion/checkbox
import { useId } from "react";
import { cn } from "../../lib/utils";

export function BeUiCheckbox({ checked, onCheckedChange, label, disabled, className }: {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <label className={cn("inline-flex min-h-11 items-center gap-3", disabled ? "cursor-not-allowed" : "cursor-pointer", className)} htmlFor={id}>
      <button
        id={id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded border-2 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50", checked ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black" : "border-neutral-400 bg-white dark:border-neutral-600 dark:bg-neutral-950")}
      >
        {checked ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg> : null}
      </button>
      <span className="text-sm text-black dark:text-white">{label}</span>
    </label>
  );
}
