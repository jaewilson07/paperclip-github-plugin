export const IMPORT_MAX_AGE_DAYS_MIN = 1;
export const IMPORT_MAX_AGE_DAYS_MAX = 3650;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ImportMaxAgeDaysValidation =
  | { valid: true; value: number | undefined }
  | { valid: false; error: string };

/**
 * Validates a user-supplied importMaxAgeDays. Unset (undefined, null, empty string) is valid and
 * means "no filter". Anything else must be an integer from 1 to 3650.
 */
export function validateImportMaxAgeDays(input: unknown): ImportMaxAgeDaysValidation {
  if (input === undefined || input === null) {
    return { valid: true, value: undefined };
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return { valid: true, value: undefined };
    }
    if (!/^\d+$/.test(trimmed)) {
      return { valid: false, error: invalidMessage(input) };
    }
    return validateNumber(Number(trimmed), input);
  }

  if (typeof input === 'number') {
    return validateNumber(input, input);
  }

  return { valid: false, error: invalidMessage(input) };
}

function validateNumber(value: number, original: unknown): ImportMaxAgeDaysValidation {
  if (
    !Number.isInteger(value)
    || value < IMPORT_MAX_AGE_DAYS_MIN
    || value > IMPORT_MAX_AGE_DAYS_MAX
  ) {
    return { valid: false, error: invalidMessage(original) };
  }
  return { valid: true, value };
}

function invalidMessage(input: unknown): string {
  return `importMaxAgeDays must be a whole number of days from ${IMPORT_MAX_AGE_DAYS_MIN} to ${IMPORT_MAX_AGE_DAYS_MAX} (got ${JSON.stringify(input)}).`;
}

/** Lenient form for persisted settings: an invalid stored value behaves as unset (no filter). */
export function normalizeImportMaxAgeDays(input: unknown): number | undefined {
  const result = validateImportMaxAgeDays(input);
  return result.valid ? result.value : undefined;
}

/** A per-mapping value overrides the company default. Unset at both levels means no filter. */
export function resolveImportMaxAgeDays(
  mappingValue: number | undefined,
  companyDefault: number | undefined
): number | undefined {
  return mappingValue ?? companyDefault;
}

export interface ImportAgeFilterIssue {
  state: string;
  updatedAt?: string;
}

export interface ImportAgeFilterResult<T> {
  eligible: T[];
  skippedByAge: T[];
}

/**
 * Keeps an open issue when it was updated within the last maxAgeDays days, or when it is exempt
 * (already imported or manually linked). Issues with no usable updated_at are kept rather than
 * dropped so a missing timestamp can never hide work.
 */
export function partitionIssuesByImportAge<T extends ImportAgeFilterIssue>(params: {
  issues: T[];
  maxAgeDays: number | undefined;
  now: Date;
  isExempt?: (issue: T) => boolean;
}): ImportAgeFilterResult<T> {
  const { issues, maxAgeDays, now, isExempt } = params;
  if (maxAgeDays === undefined) {
    return { eligible: [...issues], skippedByAge: [] };
  }

  const cutoff = now.getTime() - maxAgeDays * MS_PER_DAY;
  const eligible: T[] = [];
  const skippedByAge: T[] = [];
  for (const issue of issues) {
    const updatedAt = issue.updatedAt ? Date.parse(issue.updatedAt) : NaN;
    if (issue.state !== 'open' || Number.isNaN(updatedAt) || updatedAt >= cutoff || isExempt?.(issue)) {
      eligible.push(issue);
    } else {
      skippedByAge.push(issue);
    }
  }
  return { eligible, skippedByAge };
}

export function formatSkippedByAgeSummary(
  entries: Array<{ repositoryUrl: string; skippedCount: number; maxAgeDays: number }>
): string | undefined {
  const parts = entries
    .filter((entry) => entry.skippedCount > 0)
    .map((entry) => `${entry.repositoryUrl}: skipped ${entry.skippedCount} older than ${entry.maxAgeDays} days`);
  return parts.length > 0 ? parts.join('; ') : undefined;
}
