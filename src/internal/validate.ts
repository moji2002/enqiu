/**
 * Option validators shared by every driver.
 *
 * Each takes the caller-facing option name so the thrown message names the
 * field the user actually passed, rather than the field this module happens
 * to check.
 */

export function positiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

export function nonNegativeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

export function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export function positiveIntegerOrInfinity(name: string, value: number): void {
  if (value === Number.POSITIVE_INFINITY) {
    return;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer or Infinity`);
  }
}

export function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

export function nonNegativeIntegerOrInfinity(
  name: string,
  value: number
): void {
  if (value === Number.POSITIVE_INFINITY) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer or Infinity`);
  }
}

export function nonEmptyString(name: string, value: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must not be empty`);
  }
}
