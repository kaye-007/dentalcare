import { PdfDocument, jpegInfo, textWidth, wrapText } from './pdf-writer';

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

/** A JPEG header with only a start-of-frame: enough for jpegInfo and the PDF dictionary. */
function fakeJpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00, // APP0, empty
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9, // EOI
  ]);
}

describe('PdfDocument', () => {
  it('writes a PDF whose cross-reference table points at every object', () => {
    const doc = new PdfDocument('Test');
    const page = doc.addPage();
    page.text(48, 60, 'Hello');
    page.line(48, 70, 200, 70);
    doc.addPage().rect(10, 10, 20, 20, [1, 0, 0]);
    const pdf = latin1(doc.toBytes());

    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');

    const entries = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(entries.length).toBeGreaterThan(5);
    entries.forEach((offset, i) => {
      expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(pdf).toContain('/Count 2');
  });

  it('declares each content stream at its true length', () => {
    const doc = new PdfDocument();
    doc.addPage().text(10, 10, 'Përshëndetje (Tiranë) \\ 100€');
    const pdf = latin1(doc.toBytes());
    const m = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(pdf)!;
    expect(Buffer.byteLength(m[2]!, 'latin1')).toBe(Number(m[1]));
    // ë as WinAnsi octal, parentheses and backslash escaped, € at 0x80.
    expect(m[2]).toContain('(P\\353rsh\\353ndetje \\(Tiran\\353\\) \\\\ 100\\200)');
  });

  it('embeds a JPEG as-is, with its own dimensions', () => {
    const doc = new PdfDocument();
    const img = doc.addJpeg(fakeJpeg(320, 120))!;
    expect(img).toMatchObject({ width: 320, height: 120 });
    doc.addPage().image(img, 48, 40, 160, 60);
    const pdf = latin1(doc.toBytes());
    expect(pdf).toContain('/Width 320 /Height 120 /ColorSpace /DeviceRGB');
    expect(pdf).toContain('/XObject << /Im1 5 0 R >>');
  });

  it('refuses bytes that are not a JPEG', () => {
    expect(
      new PdfDocument().addJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])),
    ).toBeNull();
    expect(jpegInfo(Uint8Array.from([0xff, 0xd8]))).toBeNull();
  });
});

describe('text metrics', () => {
  it('measures with the Helvetica widths and treats accents as their base letter', () => {
    expect(textWidth('A', 10)).toBeCloseTo(6.67, 2);
    expect(textWidth('Ë', 10)).toBeCloseTo(textWidth('E', 10), 5);
    expect(textWidth('m', 10, true)).toBeGreaterThan(textWidth('m', 10));
  });

  it('wraps on spaces and never loses a word', () => {
    const text = 'Rehabilitim protetik i plotë i nofullës së sipërme me kurora zirkoni';
    const lines = wrapText(text, 10, 120);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(text);
    for (const l of lines) expect(textWidth(l, 10) <= 120 || !l.includes(' ')).toBe(true);
  });
});
