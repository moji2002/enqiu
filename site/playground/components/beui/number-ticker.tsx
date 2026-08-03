// Adapted from beUI Number Ticker (MIT): https://beui.dev/components/motion/number-ticker
export function NumberTicker({ value }: { value: number }) {
  return <span className="tabular-nums">{Math.max(0, Math.round(value))}</span>;
}
