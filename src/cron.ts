const monthNames = new Map([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

const weekdayNames = new Map([
  ["sun", 0],
  ["mon", 1],
  ["tue", 2],
  ["wed", 3],
  ["thu", 4],
  ["fri", 5],
  ["sat", 6],
]);

interface CronField {
  readonly wildcard: boolean;
  readonly values: ReadonlySet<number>;
}

export interface ParsedCron {
  readonly expression: string;
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export class CronExpressionError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CronExpressionError";
  }
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronExpressionError(
      "Cron expressions must contain five fields: minute hour day month weekday"
    );
  }
  return {
    expression,
    minute: parseField(fields[0] as string, 0, 59),
    hour: parseField(fields[1] as string, 0, 23),
    dayOfMonth: parseField(fields[2] as string, 1, 31),
    month: parseField(fields[3] as string, 1, 12, monthNames),
    dayOfWeek: parseField(
      fields[4] as string,
      0,
      7,
      weekdayNames,
      true
    ),
  };
}

export function validateTimeZone(timeZone: string): string {
  const normalized = timeZone.trim();
  if (!normalized) {
    throw new RangeError("timezone must not be empty");
  }
  try {
    getFormatter(normalized).format(0);
  } catch {
    throw new RangeError(`Invalid IANA timezone "${timeZone}"`);
  }
  return normalized;
}

export function nextCronOccurrence(
  cron: string | ParsedCron,
  timeZone: string,
  after: number
): number {
  if (!Number.isFinite(after)) {
    throw new RangeError("The cron cursor must be a finite timestamp");
  }
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const zone = validateTimeZone(timeZone);
  const current = zonedParts(after, zone);
  let localCursor = Date.UTC(
    current.year,
    current.month - 1,
    current.day,
    current.hour,
    current.minute
  );
  const finalCursor = localCursor + 366 * 24 * 60 * 60 * 1000 * 5;

  while (localCursor <= finalCursor) {
    const date = new Date(localCursor);
    const parts: DateParts = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      weekday: date.getUTCDay(),
    };
    if (matches(parsed, parts)) {
      const candidates = localPartsToEpochs(parts, zone);
      const next = candidates.find((candidate) => candidate > after);
      if (next !== undefined) {
        return next;
      }
    }
    localCursor += 60_000;
  }

  throw new CronExpressionError(
    `Cron expression "${parsed.expression}" has no occurrence within five years`
  );
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  names?: ReadonlyMap<string, number>,
  normalizeSunday = false
): CronField {
  const values = new Set<number>();
  const wildcard = source === "*" || source.startsWith("*/");
  for (const segment of source.toLowerCase().split(",")) {
    if (!segment) {
      throw new CronExpressionError(`Invalid empty cron field in "${source}"`);
    }
    const [rangeSource, stepSource, extra] = segment.split("/");
    if (extra !== undefined || rangeSource === undefined) {
      throw new CronExpressionError(`Invalid cron field "${source}"`);
    }
    const step = stepSource === undefined
      ? 1
      : parseInteger(stepSource, "step");
    if (step < 1) {
      throw new CronExpressionError("Cron steps must be positive");
    }

    let start: number;
    let end: number;
    if (rangeSource === "*") {
      start = minimum;
      end = maximum;
    } else {
      const range = rangeSource.split("-");
      if (range.length > 2) {
        throw new CronExpressionError(`Invalid cron range "${rangeSource}"`);
      }
      start = parseValue(range[0] as string, names);
      end =
        range[1] === undefined ? start : parseValue(range[1], names);
    }
    if (
      start < minimum ||
      start > maximum ||
      end < minimum ||
      end > maximum ||
      start > end
    ) {
      throw new CronExpressionError(
        `Cron value "${rangeSource}" must be between ${minimum} and ${maximum}`
      );
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }
  return { wildcard, values };
}

function parseValue(
  source: string,
  names?: ReadonlyMap<string, number>
): number {
  const named = names?.get(source);
  return named ?? parseInteger(source, "value");
}

function parseInteger(source: string, label: string): number {
  if (!/^\d+$/.test(source)) {
    throw new CronExpressionError(`Invalid cron ${label} "${source}"`);
  }
  return Number.parseInt(source, 10);
}

function matches(cron: ParsedCron, parts: DateParts): boolean {
  if (
    !cron.minute.values.has(parts.minute) ||
    !cron.hour.values.has(parts.hour) ||
    !cron.month.values.has(parts.month)
  ) {
    return false;
  }
  const dayOfMonth = cron.dayOfMonth.values.has(parts.day);
  const dayOfWeek = cron.dayOfWeek.values.has(parts.weekday);
  if (!cron.dayOfMonth.wildcard && !cron.dayOfWeek.wildcard) {
    return dayOfMonth || dayOfWeek;
  }
  return dayOfMonth && dayOfWeek;
}

function localPartsToEpochs(parts: DateParts, timeZone: string): number[] {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute
  );
  const guesses = new Set<number>();
  let candidate = naive;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = zonedParts(candidate, timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute
    );
    candidate += naive - represented;
    guesses.add(candidate);
  }
  for (const delta of [
    -3_600_000,
    3_600_000,
    -7_200_000,
    7_200_000,
  ]) {
    guesses.add(candidate + delta);
  }
  return [...guesses]
    .filter((value) => equalLocalParts(zonedParts(value, timeZone), parts))
    .sort((left, right) => left - right);
}

function equalLocalParts(left: DateParts, right: DateParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function zonedParts(timestamp: number, timeZone: string): DateParts {
  const parts = getFormatter(timeZone).formatToParts(timestamp);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const weekday = weekdayNames.get(
    (values.get("weekday") ?? "").toLowerCase()
  );
  if (weekday === undefined) {
    throw new RangeError(`Could not resolve timezone "${timeZone}"`);
  }
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    weekday,
  };
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}
