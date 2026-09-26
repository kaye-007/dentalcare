/**
 * CSV, as clinics actually export it.
 *
 * Shared because the clinic app parses the file to let staff map its columns,
 * and anything the API is later asked to check was read by this code — two
 * parsers that disagree about a quoted comma would show one row and import
 * another.
 *
 * What real exports do that a split(',') does not survive:
 *
 *   - Excel in an Albanian or German locale writes ';' because ',' is the
 *     decimal mark. The delimiter is detected, not assumed.
 *   - Fields are quoted, contain the delimiter, contain "" for a quote, and
 *     contain line breaks (an address, a note).
 *   - The file starts with a UTF-8 byte order mark, which otherwise ends up
 *     glued to the first header name.
 *   - Lines end in \r\n, \n, or — from old legacy systems — \r.
 */

export type CsvDelimiter = ',' | ';' | '\t';

const CANDIDATES: readonly CsvDelimiter[] = [',', ';', '\t'];

/** The delimiter that splits the first line into the most fields, outside quotes. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(CANDIDATES.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch as CsvDelimiter)) {
      counts.set(ch as CsvDelimiter, counts.get(ch as CsvDelimiter)! + 1);
    }
  }
  let best: CsvDelimiter = ',';
  for (const d of CANDIDATES) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/**
 * Parse CSV text into rows of fields. Blank lines are dropped; a trailing
 * delimiter produces a trailing empty field, as it does in the spreadsheet.
 */
export function parseCsv(input: string, delimiter?: CsvDelimiter): {
  rows: string[][];
  delimiter: CsvDelimiter;
} {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0]!.trim() === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return { rows, delimiter: sep };
}
