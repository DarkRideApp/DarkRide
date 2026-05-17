/**
 * Parse and match a crontab expression against a date.
 * Format: minute hour dayOfMonth month dayOfWeek
 * Supports: *, specific values, ranges (1-5), step values (asterisk/5), comma-separated (1,3,5)
 */
export function matchesCrontab(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  return (
    matchCronField(parts[0], minute, 0, 59) &&
    matchCronField(parts[1], hour, 0, 23) &&
    matchCronField(parts[2], dayOfMonth, 1, 31) &&
    matchCronField(parts[3], month, 1, 12) &&
    matchCronField(parts[4], dayOfWeek, 0, 6)
  );
}

function matchCronField(field: string, value: number, _min: number, max: number): boolean {
  if (field === '*') return true;

  // Handle step values: */5
  if (field.includes('/')) {
    const [range, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;

    if (range === '*') {
      return value % step === 0;
    }

    // range/step like 1-30/5
    const [start, end] = range.split('-').map(Number);
    if (value < start || value > (end ?? max)) return false;
    return (value - start) % step === 0;
  }

  // Handle ranges: 1-5
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(Number);
    return value >= start && value <= end;
  }

  // Handle comma-separated values: 1,3,5
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }

  // Exact match
  return parseInt(field, 10) === value;
}
