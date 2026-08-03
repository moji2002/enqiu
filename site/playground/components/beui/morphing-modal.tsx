// Adapted from beUI Morphing Modal (MIT): https://beui.dev/components/motion/morphing-modal
import { useEffect, type ReactNode } from "react";

export function BeUiMorphingModal({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }) {
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

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center p-4">
      <button className="absolute inset-0 bg-black/55" type="button" aria-label="Close modal" onClick={onClose} />
      <div className="relative w-full max-w-sm overflow-hidden rounded-xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}
