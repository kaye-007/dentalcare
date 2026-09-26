/**
 * A small PDF writer: text, lines, rectangles, one JPEG, a QR code.
 *
 * ── Why not a library ─────────────────────────────────────────────────────
 *
 * The API also runs as a Cloudflare Worker, where the bundle is size-capped
 * and the runtime is not quite Node. PDFKit wants fonts from disk and streams;
 * pdf-lib alone is several hundred kilobytes. An invoice needs none of what
 * they add. This file writes PDF 1.4 directly: the two standard Helvetica
 * faces (no embedding — every reader has them), WinAnsi text, which covers
 * Albanian (ë, ç) and €, and a JPEG passed through as-is.
 *
 * Coordinates are in points from the TOP-left, which is how a layout is
 * written; the page flips them to PDF's bottom-left origin.
 */

export const A4 = { width: 595.28, height: 841.89 } as const;

export type Rgb = [number, number, number];

/* ── fonts ───────────────────────────────────────────────────────────── */

// Advance widths, 1/1000 em, for ASCII 32..126 — from the standard AFM files.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Characters outside Latin-1 that WinAnsi places in 0x80..0x9F. */
const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88,
  '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93,
  '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

function winAnsiCode(ch: string): number {
  const extra = WIN_ANSI_EXTRA[ch];
  if (extra !== undefined) return extra;
  const code = ch.codePointAt(0)!;
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  if (code === 0x09 || code === 0x0a || code === 0x0d) return 0x20;
  return 0x3f; // '?': better a visible stand-in than a silently dropped letter
}

/** A PDF string literal, 8-bit bytes written as octal escapes. */
function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const code = winAnsiCode(ch);
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
    else if (code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

/** Width of `text` in points. Accented letters take their base letter's width. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (const ch of text.normalize('NFD').replace(/[\u0300-\u036F]/g, '')) {
    const code = ch.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? table[code - 32]! : 556;
  }
  return (units * size) / 1000;
}

/** Break text into lines no wider than `maxWidth`, on spaces where possible. */
export function wrapText(text: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/* ── images ──────────────────────────────────────────────────────────── */

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
}

/** Dimensions from the JPEG's start-of-frame marker, or null if it is not a JPEG. */
export function jpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[i + 5]! << 8) | bytes[i + 6]!,
        width: (bytes[i + 7]! << 8) | bytes[i + 8]!,
        components: bytes[i + 9]!,
      };
    }
    i += 2 + length;
  }
  return null;
}

export interface PdfImage {
  name: string;
  width: number;
  height: number;
}

/* ── pages ───────────────────────────────────────────────────────────── */

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((v) => num(v)).join(' ');

export interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: Rgb;
  align?: 'left' | 'right' | 'center';
}

export class PdfPage {
  readonly ops: string[] = [];
  readonly images = new Set<string>();

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  private y(top: number) {
    return this.height - top;
  }

  /** `y` is the text baseline, from the top of the page. */
  text(x: number, y: number, text: string, o: TextOptions = {}): void {
    const size = o.size ?? 10;
    const w = textWidth(text, size, o.bold);
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.ops.push(
      `BT /${o.bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(o.color ?? [0.07, 0.1, 0.17])} rg ` +
        `${num(left)} ${num(this.y(y))} Td ${pdfString(text)} Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, color: Rgb = [0.85, 0.87, 0.9]): void {
    this.ops.push(
      `${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.y(y1))} m ${num(x2)} ${num(this.y(y2))} l S`,
    );
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb): void {
    this.ops.push(`${rgb(fill)} rg ${num(x)} ${num(this.y(y + h))} ${num(w)} ${num(h)} re f`);
  }

  image(img: PdfImage, x: number, y: number, w: number, h: number): void {
    this.images.add(img.name);
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.y(y + h))} cm /${img.name} Do Q`);
  }

  /** A QR code from its module matrix, `size` points square, one filled path. */
  qr(modules: readonly (readonly boolean[])[], x: number, y: number, size: number): void {
    const n = modules.length;
    if (n === 0) return;
    const cell = size / n;
    const parts: string[] = ['0 0 0 rg'];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (modules[r]![c]) parts.push(`${num(x + c * cell)} ${num(this.y(y + (r + 1) * cell))} ${num(cell)} ${num(cell)} re`);
      }
    }
    parts.push('f');
    this.ops.push(parts.join('\n'));
  }
}

export class PdfDocument {
  private readonly pages: PdfPage[] = [];
  private readonly images: { info: PdfImage; bytes: Uint8Array; components: number }[] = [];

  constructor(private readonly title = 'Document') {}

  /** Every page so far, for work that needs the final count (page numbers). */
  get pageList(): readonly PdfPage[] {
    return this.pages;
  }

  addPage(width: number = A4.width, height: number = A4.height): PdfPage {
    const page = new PdfPage(width, height);
    this.pages.push(page);
    return page;
  }

  /** Register a JPEG for drawing. Null when the bytes are not a readable JPEG. */
  addJpeg(bytes: Uint8Array): PdfImage | null {
    const info = jpegInfo(bytes);
    if (!info || ![1, 3].includes(info.components)) return null;
    const image = { name: `Im${this.images.length + 1}`, width: info.width, height: info.height };
    this.images.push({ info: image, bytes, components: info.components });
    return image;
  }

  toBytes(): Uint8Array {
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let length = 0;
    const push = (data: Uint8Array | string) => {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
      chunks.push(bytes);
      length += bytes.length;
    };
    const object = (id: number, body: string | Uint8Array[], dict?: string) => {
      offsets[id] = length;
      push(`${id} 0 obj\n`);
      if (typeof body === 'string') {
        push(`${body}\nendobj\n`);
      } else {
        const size = body.reduce((s, b) => s + b.length, 0);
        push(`${dict!.replace('__LENGTH__', String(size))}\nstream\n`);
        body.forEach(push);
        push('\nendstream\nendobj\n');
      }
    };

    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

    const fontIds = { F1: 3, F2: 4 };
    const firstImageId = 5;
    const imageIds = new Map(this.images.map((img, i) => [img.info.name, firstImageId + i]));
    const firstPageId = firstImageId + this.images.length;
    const infoId = firstPageId + this.pages.length * 2;

    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    const kids = this.pages.map((_, i) => `${firstPageId + i * 2} 0 R`).join(' ');
    object(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    object(fontIds.F1, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    object(fontIds.F2, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    for (const img of this.images) {
      object(
        imageIds.get(img.info.name)!,
        [img.bytes],
        `<< /Type /XObject /Subtype /Image /Width ${img.info.width} /Height ${img.info.height} ` +
          `/ColorSpace /${img.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 ` +
          `/Filter /DCTDecode /Length __LENGTH__ >>`,
      );
    }

    this.pages.forEach((page, i) => {
      const pageId = firstPageId + i * 2;
      const xobjects = [...page.images].map((name) => `/${name} ${imageIds.get(name)} 0 R`).join(' ');
      object(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R >>` +
          `${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> /Contents ${pageId + 1} 0 R >>`,
      );
      object(pageId + 1, [Buffer.from(page.ops.join('\n'), 'latin1')], '<< /Length __LENGTH__ >>');
    });

    object(infoId, `<< /Title ${pdfString(this.title)} /Producer (DentalCare) >>`);

    const xrefAt = length;
    const count = infoId + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    push(xref);
    push(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}
