/**
 * T-040 — CSV rendering, and the one thing implementation note 6 exists for: neutralising CSV
 * injection.
 *
 * A cell whose *rendered* text begins with `=`, `+`, `-` or `@` is a formula to Excel, Numbers
 * and Google Sheets the moment the file is opened — `=HYPERLINK("https://evil","click")` sitting
 * in an exported audit log is a real attack chain (attacker performs an audited action whose
 * `detail`/`comment` is attacker-controlled → an investigator exports the trail → the formula
 * runs at whatever privilege their spreadsheet has). The fix is prefixing the cell with `'`
 * (TC-19): every spreadsheet application treats a leading apostrophe as "this is text", and the
 * character itself is not shown.
 *
 * The check runs on every cell, string or not, and — critically — checks the character the
 * value *renders as* first, before quoting: quoting alone does not defuse this (Excel still
 * evaluates `"=1+1"` as a formula once the surrounding quotes are stripped for display), so the
 * `'` prefix must survive into the unquoted field, and quoting is applied to the *result*.
 */

const DANGEROUS_LEADING_CHARS = new Set(['=', '+', '-', '@']);

/** One row of an export, in column order — decided by the caller, not derived from an object. */
export type CsvRow = readonly (string | number | boolean | null)[];

function cellToString(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** TC-19. Neutralises formula injection; a no-op for every ordinary cell. */
export function neutraliseFormulaInjection(cell: string): string {
  if (cell.length === 0) return cell;
  return DANGEROUS_LEADING_CHARS.has(cell[0]) ? `'${cell}` : cell;
}

/** RFC 4180 quoting: only when the cell needs it, doubling embedded quotes. */
function quoteIfNeeded(cell: string): string {
  if (!/[",\n\r]/.test(cell)) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}

export function toCsvLine(row: CsvRow): string {
  return (
    row.map((value) => quoteIfNeeded(neutraliseFormulaInjection(cellToString(value)))).join(',') +
    '\r\n'
  );
}

export function toCsvHeader(columns: readonly string[]): string {
  return toCsvLine(columns);
}
