/**
 * Drop keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, so `{ name: undefined }` is not a valid
 * `{ name?: string }`. Options assembled from partial input have to have their
 * absent keys removed rather than set to `undefined`.
 */

type Compact<T> = {
  [Key in keyof T as undefined extends T[Key] ? never : Key]: T[Key];
} & {
  [Key in keyof T as undefined extends T[Key] ? Key : never]?:
    Exclude<T[Key], undefined>;
};

export function compact<T extends Record<PropertyKey, unknown>>(
  value: T
): Compact<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Compact<T>;
}
