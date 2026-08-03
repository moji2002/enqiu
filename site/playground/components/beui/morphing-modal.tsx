// Adapted from beUI Morphing Modal (MIT): https://beui.dev/components/motion/morphing-modal
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { EASE_OUT, SPRING_PANEL } from "../../lib/ease";

export function BeUiMorphingModal({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-[80] grid place-items-center p-4">
          <motion.button className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-label="Close modal" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: EASE_OUT }} />
          <motion.div className="relative w-full max-w-sm overflow-hidden rounded-xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950" role="dialog" aria-modal="true" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }} transition={SPRING_PANEL}>
            {children}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
