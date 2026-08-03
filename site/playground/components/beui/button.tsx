// Adapted from beUI Button (MIT): https://beui.dev/components/motion/button
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type HTMLMotionProps,
} from "motion/react";
import {
  forwardRef,
  useCallback,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { EASE_OUT, SPRING_PRESS } from "../../lib/ease";
import { useHoverCapable } from "../../lib/use-hover-capable";
import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface BeUiButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pressScale?: number;
  ripple?: boolean;
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

type Ripple = { id: number; x: number; y: number; size: number };

export const BeUiButton = forwardRef<HTMLButtonElement, BeUiButtonProps>(
  function BeUiButton(
    {
      variant = "secondary",
      size = "md",
      pressScale = 0.96,
      ripple = false,
      className,
      children,
      onPointerDown,
      ...rest
    },
    ref,
  ) {
    const reduceMotion = useReducedMotion();
    const canHover = useHoverCapable();
    const [ripples, setRipples] = useState<Ripple[]>([]);
    const nextId = useRef(0);

    const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
      if (ripple && !reduceMotion) {
        const rect = event.currentTarget.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 2;
        setRipples((current) => [...current, {
          id: nextId.current++,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          size,
        }]);
      }
      onPointerDown?.(event);
    }, [onPointerDown, reduceMotion, ripple]);

    return (
      <motion.button
        ref={ref}
        type="button"
        whileTap={reduceMotion ? undefined : { scale: pressScale }}
        whileHover={reduceMotion || !canHover ? undefined : { y: -1 }}
        transition={SPRING_PRESS}
        onPointerDown={handlePointerDown}
        className={cn(
          "inline-flex select-none items-center justify-center font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:pointer-events-none disabled:opacity-50",
          ripple && "relative overflow-hidden",
          variants[variant],
          sizes[size],
          className,
        )}
        {...rest}
      >
        {ripple && !reduceMotion ? (
          <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
            <AnimatePresence>
              {ripples.map((item) => (
                <motion.span
                  key={item.id}
                  className="absolute rounded-full bg-current"
                  style={{ left: item.x, top: item.y, width: item.size, height: item.size, x: "-50%", y: "-50%" }}
                  initial={{ scale: 0.05, opacity: 0.25 }}
                  animate={{ scale: 1, opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 1, ease: EASE_OUT }}
                  onAnimationComplete={() => setRipples((current) => current.filter(({ id }) => id !== item.id))}
                />
              ))}
            </AnimatePresence>
          </span>
        ) : null}
        {children}
      </motion.button>
    );
  },
);
