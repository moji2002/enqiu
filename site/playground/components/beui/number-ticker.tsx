// Adapted from beUI NumberTicker (MIT): https://beui.dev/components/motion/number-ticker
import { motion, useReducedMotion } from "motion/react";

const DIGIT_HEIGHT_EM = 1.1;
const DIGITS = Array.from({ length: 10 }, (_, digit) => digit);
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export function NumberTicker({ value }: { value: number }) {
  const text = Math.max(0, Math.round(value)).toString();

  return (
    <span className="inline-flex items-center tabular-nums">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex items-center tabular-nums">
        {text.split("").map((character, index, characters) => (
          <Digit
            key={`place-${characters.length - index}`}
            digit={Number(character)}
          />
        ))}
      </span>
    </span>
  );
}

function Digit({ digit }: { digit: number }) {
  const reduceMotion = useReducedMotion();

  return (
    <span
      className="relative inline-block overflow-hidden"
      style={{ height: `${DIGIT_HEIGHT_EM}em`, width: "1ch" }}
    >
      <motion.span
        initial={false}
        animate={{ y: `-${digit * DIGIT_HEIGHT_EM}em` }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { duration: 0.48, ease: EASE_OUT }
        }
        className="absolute inset-x-0 top-0 flex flex-col items-center will-change-transform [&>span]:flex [&>span]:h-[1.1em] [&>span]:items-center [&>span]:justify-center [&>span]:leading-none"
      >
        {DIGITS.map((value) => <span key={value}>{value}</span>)}
      </motion.span>
    </span>
  );
}
