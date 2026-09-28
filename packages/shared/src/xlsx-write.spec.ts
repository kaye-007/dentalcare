import { columnName, crc32, writeXlsx } from './xlsx-write';

/** The entries of a stored (uncompressed) zip, read back by hand. */
function unzip(bytes: Uint8Array): Map<string, { text: string; crcOk: boolean }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, { text: string; crcOk: boolean }>();
  let at = 0;
  const dec = new TextDecoder();
  while (view.getUint32(at, true) === 0x04034b50) {
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = dec.decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const data = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    out.set(name, { text: dec.decode(data), crcOk: crc32(data) === crc });
    at += 30 + nameLen + size;
  }
  return out;
}

describe('writing an Excel workbook', () => {
  const book = unzip(
    writeXlsx([
      {
        name: 'Paratë',
        rows: [
          ['Muaji', 'Arkëtuar'],
          ['Shtator', 2624000],
          ['Çelësi & <kodi>', null],
        ],
      },
      { name: 'TVSH: 20%/vit', rows: [['Norma'], [20]] },
    ]),
  );

  it('writes every part a spreadsheet needs, each with a correct checksum', () => {
    expect([...book.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    for (const [, part] of book) expect(part.crcOk).toBe(true);
  });

  it('keeps Albanian letters, escapes markup, and writes numbers as numbers', () => {
    const sheet = book.get('xl/worksheets/sheet1.xml')!.text;
    expect(sheet).toContain('<t xml:space="preserve">Arkëtuar</t>');
    expect(sheet).toContain('<c r="B2"><v>2624000</v></c>');
    expect(sheet).toContain('Çelësi &amp; &lt;kodi&gt;');
    // The header row is bold (style 1); an empty cell is left out.
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(sheet).not.toContain('r="B3"');
  });

  it('names sheets the way Excel allows', () => {
    expect(book.get('xl/workbook.xml')!.text).toContain('name="TVSH  20% vit"');
  });

  it('counts columns past Z', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'ZZ',
      'AAA',
    ]);
  });
});
