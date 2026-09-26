import { detectDelimiter, parseCsv } from './csv';

describe('parseCsv', () => {
  it('reads a plain comma file', () => {
    expect(parseCsv('a,b\n1,2\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('detects the semicolon a European Excel writes', () => {
    const csv = 'Emri;Mbiemri;Balanca\nAna;Hoxha;1.200,50\r\n';
    expect(detectDelimiter(csv)).toBe(';');
    expect(parseCsv(csv).rows[1]).toEqual(['Ana', 'Hoxha', '1.200,50']);
  });

  it('keeps quoted delimiters, doubled quotes and line breaks inside a field', () => {
    const csv = 'name,address\n"Hoxha, Ana","Rruga ""Myslym Shyri""\nTiranë"\n';
    expect(parseCsv(csv).rows[1]).toEqual(['Hoxha, Ana', 'Rruga "Myslym Shyri"\nTiranë']);
  });

  it('strips a byte order mark and skips blank lines', () => {
    const { rows } = parseCsv('\uFEFFfirst,last\n\nAna,Hoxha');
    expect(rows).toEqual([
      ['first', 'last'],
      ['Ana', 'Hoxha'],
    ]);
  });

  it('accepts old Mac line endings and a trailing empty field', () => {
    expect(parseCsv('a,b,\rx,y,').rows).toEqual([
      ['a', 'b', ''],
      ['x', 'y', ''],
    ]);
  });

  it('does not count a delimiter inside quotes when detecting', () => {
    expect(detectDelimiter('"a;b;c",d,e\n')).toBe(',');
  });
});
