// Adapted from beUI Button (MIT): https://beui.dev/components/motion/button
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface BeUiButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

const variants: Record<ButtonVariant, string> = {
  primary: "border border-black bg-black text-white hover:bg-neutral-800 dark:border-white dark:bg-white dark:text-black dark:hover:bg-neutral-200",
  secondary: "border border-neutral-300 bg-white text-black hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-white dark:hover:bg-neutral-900",
  ghost: "border border-transparent bg-transparent text-neutral-600 hover:bg-neutral-100 hover:text-black dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-white",
  outline: "border border-neutral-300 bg-transparent text-black hover:bg-neutral-100 dark:border-neutral-700 dark:text-white dark:hover:bg-neutral-900",
  danger: "border border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-neutral-950 dark:text-red-400 dark:hover:bg-red-950/40",
};

const sizes: Record<ButtonSize, string> = {
  sm: "min-h-9 rounded-md px-3 text-xs gap-1.5",
  md: "min-h-10 rounded-md px-3 text-sm gap-2",
  lg: "min-h-12 rounded-lg px-5 text-base gap-2",
  icon: "size-10 rounded-md",
};

export const BeUiButton = forwardRef<HTMLButtonElement, BeUiButtonProps>(function BeUiButton(
  { variant = "secondary", size = "md", className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex select-none items-center justify-center font-medium transition-colors duration-150 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
