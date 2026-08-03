// Adapted from beUI Tabs (MIT): https://beui.dev/components/motion/tabs
import { createContext, useCallback, useContext, useMemo, type KeyboardEvent, type ReactNode } from "react";

interface TabsContextValue { value: string; setValue(value: string): void; }
const TabsContext = createContext<TabsContextValue | undefined>(undefined);

function useTabs() {
  const context = useContext(TabsContext);
  if (!context) throw new Error("BeUiTabs components must be nested inside BeUiTabs.");
  return context;
}

export function BeUiTabs({ value, onValueChange, children, className }: { value: string; onValueChange(value: string): void; children: ReactNode; className?: string }) {
  const setValue = useCallback((next: string) => onValueChange(next), [onValueChange]);
  const context = useMemo(() => ({ value, setValue }), [setValue, value]);
  return <TabsContext.Provider value={context}><div className={className}>{children}</div></TabsContext.Provider>;
}

export function BeUiTabsList({ children, className, ariaLabel }: { children: ReactNode; className?: string; ariaLabel: string }) {
  return <div role="tablist" aria-label={ariaLabel} className={className}>{children}</div>;
}

export function BeUiTabsTrigger({ value, children, disabled = false, className }: { value: string; children: ReactNode; disabled?: boolean; className?: string }) {
  const tabs = useTabs();
  const active = tabs.value === value;
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabList = event.currentTarget.closest('[role="tablist"]');
    const triggers = Array.from(tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? []);
    const currentIndex = triggers.indexOf(event.currentTarget);
    if (currentIndex < 0 || triggers.length === 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? triggers.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + triggers.length) % triggers.length;
    const next = triggers[nextIndex];
    tabs.setValue(next.dataset.value ?? value);
    next.focus();
  };

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-value={value}
      tabIndex={active ? 0 : -1}
      disabled={disabled}
      onClick={() => tabs.setValue(value)}
      onKeyDown={handleKeyDown}
      className={`relative min-w-0 flex-1 min-h-11 rounded-md px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 ${active ? "bg-black text-white shadow-sm dark:bg-white dark:text-black" : "text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white"} ${className ?? ""}`}
    >
      {children}
    </button>
  );
}
