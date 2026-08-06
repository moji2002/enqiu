/** Parsing for the Redis stream that carries queue events between processes. */

export interface StreamEntry {
  id: string;
  fields: ReadonlyMap<string, string>;
}

/**
 * Stream replies arrive in two shapes. RESP2 clients (and Bun's) return the
 * nested-array form, while node-redis returns XREAD as an object keyed by
 * stream name — and a Map under RESP3. Treating only arrays as containers
 * silently yielded zero entries, so no queue event ever reached a listener.
 */
function streamContainerValues(value: unknown): unknown[] {
  if (value instanceof Map) {
    return [...value.values()];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>);
  }
  return [];
}

export function firstStreamEntryId(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    for (const nested of streamContainerValues(value)) {
      const id = firstStreamEntryId(nested);
      if (id) {
        return id;
      }
    }
    return undefined;
  }
  if (
    typeof value[0] === "string" &&
    /^\d+-\d+$/.test(value[0])
  ) {
    return value[0];
  }
  for (const entry of value) {
    const id = firstStreamEntryId(entry);
    if (id) {
      return id;
    }
  }
  return undefined;
}

export function streamEntries(value: unknown): StreamEntry[] {
  const entries: StreamEntry[] = [];
  visitStreamValue(value, entries);
  return entries;
}

function visitStreamValue(value: unknown, entries: StreamEntry[]): void {
  if (!Array.isArray(value)) {
    for (const nested of streamContainerValues(value)) {
      visitStreamValue(nested, entries);
    }
    return;
  }
  if (
    typeof value[0] === "string" &&
    /^\d+-\d+$/.test(value[0]) &&
    Array.isArray(value[1])
  ) {
    const fields = new Map<string, string>();
    const rawFields = value[1];
    for (let index = 0; index < rawFields.length; index += 2) {
      const key = rawFields[index];
      const fieldValue = rawFields[index + 1];
      if (key !== undefined && fieldValue !== undefined) {
        fields.set(String(key), String(fieldValue));
      }
    }
    entries.push({ id: value[0], fields });
    return;
  }
  for (const entry of value) {
    visitStreamValue(entry, entries);
  }
}
