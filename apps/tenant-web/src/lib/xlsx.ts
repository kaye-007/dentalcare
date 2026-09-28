/**
 * Read the first sheet of an Excel workbook (.xlsx) as rows of text.
 *
 * Clinics keep their patient lists in Excel. Asking them to "Save as CSV"
 * first is the step where switching software stops feeling easy, so the
 * import reads the workbook itself. No library: an .xlsx is a ZIP of XML
 * parts, the browser inflates with DecompressionStream and parses with
 * DOMParser, and only the parts a patient list needs are read (the sheet,
 * its shared strings, and which number formats are dates).
 *
 * Dates stored as Excel dates come out as "DD.MM.YYYY", which the import's
 * default date order (day, month, year) reads as written.
 *
 * The legacy binary .xls format is not supported; the caller says so.
 */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);

function zipEntries(buf: ArrayBuffer): Map<string, ZipEntry> {
  const view = new DataView(buf);
  // End of central directory: the last 0x06054b50, within the final 64 KiB.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_558); i--) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not-a-zip');
  const count = u16(view, eocd + 10);
  let p = u32(view, eocd + 16);
  const names = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (u32(view, p) !== 0x02014b50) throw new Error('not-a-zip');
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const name = names.decode(new Uint8Array(buf, p + 46, nameLen));
    entries.set(name, {
      name,
      method: u16(view, p + 10),
      compressedSize: u32(view, p + 20),
      localOffset: u32(view, p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(buf: ArrayBuffer, e: ZipEntry): Promise<string> {
  const view = new DataView(buf);
  const start =
    e.localOffset + 30 + u16(view, e.localOffset + 26) + u16(view, e.localOffset + 28);
  const bytes = new Uint8Array(buf, start, e.compressedSize);
  if (e.method === 0) return new TextDecoder().decode(bytes);
  if (e.method !== 8) throw new Error('unsupported-compression');
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

const xml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
/** Elements by local name, whatever namespace prefix the writer chose. */
const all = (root: Document | Element, name: string) =>
  Array.from(root.getElementsByTagNameNS('*', name));

/** "B12" → 1. Letters only; the row number is ignored. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** Built-in number formats that are dates (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57,
]);

function dateStyles(stylesXml: string | null): Set<number> {
  const dates = new Set<number>();
  if (!stylesXml) return dates;
  const doc = xml(stylesXml);
  const custom = new Map<number, string>();
  for (const f of all(doc, 'numFmt')) {
    custom.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '');
  }
  const cellXfs = all(doc, 'cellXfs')[0];
  if (!cellXfs) return dates;
  all(cellXfs, 'xf').forEach((xf, index) => {
    const id = Number(xf.getAttribute('numFmtId') ?? 0);
    // A custom code is a date when, outside quotes and brackets, it has d or y.
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
    if (BUILTIN_DATE_FORMATS.has(id) || /[dy]/i.test(code)) dates.add(index);
  });
  return dates;
}

/** Excel's day number (1900 system) → "DD.MM.YYYY". */
function serialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

function firstSheetPath(
  entries: Map<string, ZipEntry>,
  workbook: string,
  rels: string | null,
) {
  const sheet = all(xml(workbook), 'sheet')[0];
  const rid =
    sheet?.getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'id',
    ) ?? sheet?.getAttribute('r:id');
  if (rid && rels) {
    const rel = all(xml(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
    const target = rel?.getAttribute('Target');
    if (target) {
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      if (entries.has(path)) return path;
    }
  }
  return entries.has('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : null;
}

export async function readXlsx(file: Blob): Promise<string[][]> {
  const buf = await file.arrayBuffer();
  const entries = zipEntries(buf);
  const text = async (path: string) => {
    const e = entries.get(path);
    return e ? readEntry(buf, e) : null;
  };
  const workbook = await text('xl/workbook.xml');
  if (!workbook) throw new Error('not-a-workbook');
  const sheetPath = firstSheetPath(
    entries,
    workbook,
    await text('xl/_rels/workbook.xml.rels'),
  );
  const sheetXml = sheetPath ? await text(sheetPath) : null;
  if (!sheetXml) throw new Error('not-a-workbook');

  const shared: string[] = [];
  const sst = await text('xl/sharedStrings.xml');
  if (sst) {
    for (const si of all(xml(sst), 'si')) {
      // Rich text splits one string into runs; phonetic hints are not text.
      shared.push(
        all(si, 't')
          .filter((t) => t.parentElement?.localName !== 'rPh')
          .map((t) => t.textContent ?? '')
          .join(''),
      );
    }
  }
  const dates = dateStyles(await text('xl/styles.xml'));

  const rows: string[][] = [];
  for (const row of all(xml(sheetXml), 'row')) {
    const cells: string[] = [];
    let next = 0;
    for (const c of all(row, 'c')) {
      const ref = c.getAttribute('r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = c.getAttribute('t');
      const v = all(c, 'v')[0]?.textContent ?? '';
      let value: string;
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr')
        value = all(c, 't')
          .map((t) => t.textContent ?? '')
          .join('');
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') value = v;
      else if (v !== '' && dates.has(Number(c.getAttribute('s') ?? -1))) {
        value = serialToDate(Number(v));
      } else if (v !== '' && Number.isFinite(Number(v))) {
        // A phone typed as a number is stored as one; never show it as 3.5E+11.
        const n = Number(v);
        value = Number.isInteger(n) ? n.toFixed(0) : String(n);
      } else value = v;
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    rows.push(cells);
  }
  // Excel keeps formatted-but-empty rows; they are not patients.
  while (rows.length && rows[rows.length - 1]!.every((c) => c.trim() === '')) rows.pop();
  return rows.filter((r, i) => i === 0 || r.some((c) => c.trim() !== ''));
}
