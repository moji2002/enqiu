import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Panel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-xl border border-neutral-200 bg-white shadow-[0_1px_2px_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-neutral-950",
        className,
      )}
      {...props}
    />
  );
}

export function PanelHeader({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-neutral-200 px-4 py-4 dark:border-neutral-800">
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-[-0.015em] text-black dark:text-white">{title}</h2>
        <p className="mt-1 text-sm leading-5 text-neutral-500 dark:text-neutral-400">{description}</p>
      </div>
      <span className="font-mono text-xs text-neutral-400 dark:text-neutral-600">{number}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
      <span className="mb-4 grid size-10 place-items-center rounded-full border border-dashed border-neutral-300 font-mono text-sm text-neutral-400 dark:border-neutral-700">Q</span>
      <strong className="text-sm font-semibold text-black dark:text-white">{title}</strong>
      <p className="mt-1 max-w-64 text-sm leading-5 text-neutral-500 dark:text-neutral-400">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export const fieldClass = "min-h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-black shadow-sm outline-none transition duration-200 placeholder:text-neutral-400 hover:border-neutral-400 focus:border-black focus:ring-2 focus:ring-black/10 dark:border-neutral-700 dark:bg-neutral-950 dark:text-white dark:placeholder:text-neutral-600 dark:hover:border-neutral-600 dark:focus:border-white dark:focus:ring-white/15";
export const fieldLabelClass = "mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-400";
export const monoLabelClass = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-500";
