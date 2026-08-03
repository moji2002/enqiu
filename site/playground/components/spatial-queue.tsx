import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import type { PointerEvent, ReactNode } from "react";
import { cn } from "../lib/utils";

export type SpatialToken = {
  id: string;
  label: string;
  status: "queued" | "scheduled" | "running" | "succeeded" | "failed" | "cancelled" | "expired" | "idle";
};

const tokenTone: Record<SpatialToken["status"], string> = {
  queued: "border-amber-300/50 bg-amber-300/10 text-amber-100",
  scheduled: "border-violet-300/50 bg-violet-300/10 text-violet-100",
  running: "border-blue-300/60 bg-blue-400/15 text-blue-100",
  succeeded: "border-emerald-300/50 bg-emerald-300/10 text-emerald-100",
  failed: "border-red-300/50 bg-red-300/10 text-red-100",
  cancelled: "border-neutral-500/70 bg-neutral-500/10 text-neutral-300",
  expired: "border-orange-300/50 bg-orange-300/10 text-orange-100",
  idle: "border-white/15 bg-white/[0.03] text-neutral-500",
};

const tokenDot: Record<SpatialToken["status"], string> = {
  queued: "bg-amber-300",
  scheduled: "bg-violet-400",
  running: "bg-blue-400",
  succeeded: "bg-emerald-400",
  failed: "bg-red-400",
  cancelled: "bg-neutral-500",
  expired: "bg-orange-400",
  idle: "bg-neutral-700",
};

function CubeFace({ transform, children }: { transform: string; children?: ReactNode }) {
  return (
    <span
      className="absolute inset-0 grid place-items-center border border-blue-300/35 bg-blue-500/10 shadow-[inset_0_0_30px_rgb(59_130_246/0.08)] backdrop-blur-sm"
      style={{ transform }}
    >
      {children}
    </span>
  );
}

function WorkerCore({ active, paused }: { active: number; paused: boolean }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className="absolute left-1/2 top-1/2 size-24 -translate-x-1/2 -translate-y-1/2"
      style={{ transformStyle: "preserve-3d" }}
      animate={reduceMotion ? undefined : { rotateX: [8, 15, 8], rotateY: paused ? 18 : [18, 378] }}
      transition={{ rotateX: { duration: 5, repeat: Infinity, ease: "easeInOut" }, rotateY: { duration: paused ? 0.4 : 18, repeat: paused ? 0 : Infinity, ease: "linear" } }}
      aria-hidden="true"
    >
      <CubeFace transform="translateZ(48px)"><strong className="font-mono text-[10px] tracking-[0.16em] text-blue-100">WORKER</strong></CubeFace>
      <CubeFace transform="rotateY(180deg) translateZ(48px)" />
      <CubeFace transform="rotateY(90deg) translateZ(48px)" />
      <CubeFace transform="rotateY(-90deg) translateZ(48px)" />
      <CubeFace transform="rotateX(90deg) translateZ(48px)" />
      <CubeFace transform="rotateX(-90deg) translateZ(48px)" />
      <span className="absolute left-1/2 top-1/2 size-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-400/20 blur-xl" />
      <span className="absolute -bottom-16 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/10 bg-black/70 px-2.5 py-1 font-mono text-[9px] text-neutral-400 backdrop-blur-md">{paused ? "gate closed" : `${active} active`}</span>
    </motion.div>
  );
}

export function SpatialQueue({
  tokens,
  running,
  queued,
  concurrency,
  paused = false,
  onSelect,
  className,
  compact = false,
}: {
  tokens: readonly SpatialToken[];
  running: number;
  queued: number;
  concurrency: number;
  paused?: boolean;
  onSelect?: (id: string) => void;
  className?: string;
  compact?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const springX = useSpring(pointerX, { stiffness: 120, damping: 22, mass: 0.7 });
  const springY = useSpring(pointerY, { stiffness: 120, damping: 22, mass: 0.7 });
  const rotateY = useTransform(springX, [-1, 1], [-8, 8]);
  const rotateX = useTransform(springY, [-1, 1], [7, -7]);
  const displayed = tokens.length > 0
    ? tokens.slice(0, compact ? 5 : 8)
    : Array.from({ length: compact ? 4 : 6 }, (_, index): SpatialToken => ({ id: `idle-${index}`, label: "awaiting job", status: "idle" }));

  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (reduceMotion) return;
    const rect = event.currentTarget.getBoundingClientRect();
    pointerX.set(((event.clientX - rect.left) / rect.width) * 2 - 1);
    pointerY.set(((event.clientY - rect.top) / rect.height) * 2 - 1);
  };

  return (
    <div
      className={cn(
        "relative isolate min-h-[360px] overflow-hidden rounded-[28px] border border-white/10 bg-[#07080b] text-white shadow-2xl shadow-black/25 [perspective:900px] sm:min-h-[430px]",
        compact && "min-h-[330px] sm:min-h-[390px]",
        className,
      )}
      onPointerMove={trackPointer}
      onPointerLeave={() => { pointerX.set(0); pointerY.set(0); }}
      aria-label={`${queued} waiting, ${running} running, concurrency ${concurrency}`}
    >
      <div className="absolute inset-0 bg-[linear-gradient(rgb(255_255_255/0.055)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.055)_1px,transparent_1px)] bg-[size:36px_36px] [mask-image:radial-gradient(circle_at_center,black,transparent_82%)]" aria-hidden="true" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,rgb(124_92_255/0.22),transparent_26%),radial-gradient(circle_at_82%_75%,rgb(255_91_122/0.15),transparent_26%),radial-gradient(circle_at_50%_48%,rgb(56_189_248/0.16),transparent_32%)]" aria-hidden="true" />
      <div className="absolute left-4 top-4 z-30 flex items-center gap-2 rounded-full border border-white/10 bg-black/45 px-3 py-1.5 font-mono text-[10px] text-neutral-400 backdrop-blur-md">
        <i className={cn("size-1.5 rounded-full", paused ? "bg-amber-400" : "bg-emerald-400")} />
        {paused ? "worker paused" : "queue live"}
      </div>
      <div className="absolute right-4 top-4 z-30 flex gap-1.5" aria-hidden="true">
        {Array.from({ length: concurrency }, (_, index) => <i className={cn("h-1.5 w-7 rounded-full", index < running ? "bg-blue-400" : "bg-neutral-800")} key={index} />)}
      </div>

      <motion.div
        className="absolute inset-0"
        style={{ rotateX: reduceMotion ? 0 : rotateX, rotateY: reduceMotion ? 0 : rotateY, transformStyle: "preserve-3d" }}
      >
        <motion.div
          className="absolute left-1/2 top-1/2 h-[70%] w-[70%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-blue-300/20"
          style={{ transform: "translate(-50%, -50%) rotateX(68deg) translateZ(-60px)", transformStyle: "preserve-3d" }}
          animate={reduceMotion || paused ? undefined : { rotateZ: 360 }}
          transition={{ duration: 26, repeat: Infinity, ease: "linear" }}
          aria-hidden="true"
        >
          <span className="absolute left-1/2 top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-300 shadow-[0_0_16px_rgb(147_197_253)]" />
          <span className="absolute bottom-0 left-1/2 size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-violet-400" />
        </motion.div>

        <WorkerCore active={running} paused={paused} />

        {displayed.map((token, index) => {
          const angle = (index / displayed.length) * Math.PI * 2 - Math.PI / 2;
          const radiusX = compact ? 132 : 165;
          const radiusY = compact ? 92 : 118;
          const x = Math.cos(angle) * radiusX;
          const y = Math.sin(angle) * radiusY;
          const z = Math.sin(angle + Math.PI / 3) * 90;
          const interactive = token.status !== "idle" && Boolean(onSelect);
          return (
            <motion.button
              key={token.id}
              type="button"
              disabled={!interactive}
              onClick={() => interactive && onSelect?.(token.id)}
              className={cn(
                "absolute left-1/2 top-1/2 z-20 w-28 rounded-lg border px-2.5 py-2 text-left shadow-lg backdrop-blur-md sm:w-32",
                tokenTone[token.status],
                interactive ? "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400" : "cursor-default",
              )}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.6, x: 0, y: 0, z: 0 }}
              animate={{ opacity: token.status === "idle" ? 0.45 : 1, scale: z > 0 ? 1 : 0.88, x, y, z, rotateY: -Math.cos(angle) * 8 }}
              whileHover={interactive && !reduceMotion ? { scale: 1.08, z: z + 24 } : undefined}
              transition={{ type: "spring", stiffness: 130, damping: 18, mass: 0.8, delay: reduceMotion ? 0 : index * 0.045 }}
              style={{ marginLeft: compact ? -56 : -64, marginTop: -30, transformStyle: "preserve-3d" }}
            >
              <span className="flex items-center justify-between gap-2">
                <i className={cn("size-1.5 shrink-0 rounded-full", tokenDot[token.status])} />
                <span className="truncate font-mono text-[9px] uppercase tracking-wider opacity-65">{token.status}</span>
              </span>
              <strong className="mt-1.5 block truncate font-mono text-[10px] font-medium sm:text-[11px]">{token.label}</strong>
            </motion.button>
          );
        })}
      </motion.div>

      <div className="absolute inset-x-4 bottom-4 z-30 flex items-end justify-between gap-4 font-mono text-[10px] text-neutral-500">
        <span>{queued} waiting</span>
        <span className="text-right">move to inspect depth<br />run jobs to change the field</span>
      </div>
    </div>
  );
}
