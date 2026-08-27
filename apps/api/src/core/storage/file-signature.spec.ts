import {
  ALLOWED_TYPES,
  ALLOWED_TYPES_LABEL,
  EXTENSION_FOR,
  detectFileType,
  isAllowedType,
} from './file-signature';

/** Build a buffer whose first bytes are `head`, padded to `size`. */
const withHeader = (head: number[], size = 64): Buffer => {
  const buf = Buffer.alloc(size);
  Buffer.from(head).copy(buf, 0);
  return buf;
};

const JPEG = withHeader([0xff, 0xd8, 0xff, 0xe0]);
const PNG = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = withHeader([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const TIFF_LE = withHeader([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BE = withHeader([0x4d, 0x4d, 0x00, 0x2a]);

function webp(): Buffer {
  const buf = Buffer.alloc(64);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(56, 4);
  buf.write('WEBP', 8, 'ascii');
  return buf;
}

/** DICOM: 128-byte preamble, then 'DICM' at offset 128. */
function dicom(): Buffer {
  const buf = Buffer.alloc(160);
  buf.write('DICM', 128, 'ascii');
  return buf;
}

describe('detectFileType', () => {
  it('identifies every accepted format from its bytes', () => {
    expect(detectFileType(JPEG)).toBe('image/jpeg');
    expect(detectFileType(PNG)).toBe('image/png');
    expect(detectFileType(PDF)).toBe('application/pdf');
    expect(detectFileType(webp())).toBe('image/webp');
    expect(detectFileType(dicom())).toBe('application/dicom');
    expect(detectFileType(TIFF_LE)).toBe('image/tiff');
    expect(detectFileType(TIFF_BE)).toBe('image/tiff');
  });

  it('rejects an executable no matter what it is named', () => {
    // ELF — the classic "rename it to .jpg and upload" case.
    expect(detectFileType(withHeader([0x7f, 0x45, 0x4c, 0x46]))).toBeNull();
    // Windows PE / DOS MZ.
    expect(detectFileType(withHeader([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
    // #!/bin/sh
    expect(detectFileType(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toBeNull();
  });

  it('rejects archives and office containers', () => {
    // ZIP / DOCX / XLSX all start PK\x03\x04.
    expect(detectFileType(withHeader([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    // GZIP
    expect(detectFileType(withHeader([0x1f, 0x8b, 0x08]))).toBeNull();
  });

  it('rejects HTML, which browsers would happily execute', () => {
    expect(detectFileType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectFileType(Buffer.from('<!DOCTYPE html>'))).toBeNull();
  });

  it('rejects a RIFF container that is not WEBP', () => {
    // A WAV file is RIFF....WAVE — the prefix alone must not be enough.
    const wav = Buffer.alloc(64);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(56, 4);
    wav.write('WAVE', 8, 'ascii');
    expect(detectFileType(wav)).toBeNull();
  });

  it('does not read past the end of a short buffer', () => {
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
    expect(detectFileType(Buffer.from([0xff]))).toBeNull();
    expect(detectFileType(Buffer.from([0xff, 0xd8]))).toBeNull();
    // 'DICM' needs 132 bytes; 100 must not throw or match.
    expect(detectFileType(Buffer.alloc(100))).toBeNull();
    // RIFF present but truncated before the WEBP marker.
    const short = Buffer.alloc(8);
    short.write('RIFF', 0, 'ascii');
    expect(detectFileType(short)).toBeNull();
  });

  it('ignores a correct signature that appears at the wrong offset', () => {
    const buf = Buffer.alloc(64);
    Buffer.from([0xff, 0xd8, 0xff]).copy(buf, 10); // JPEG magic, but not at 0
    expect(detectFileType(buf)).toBeNull();
  });

  it('is not fooled by a benign header on a malicious payload', () => {
    // Real JPEG magic, script body: we accept the FORMAT, and the object is
    // only ever served back with its detected content type, never as HTML.
    const polyglot = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('<script>alert(1)</script>'),
    ]);
    expect(detectFileType(polyglot)).toBe('image/jpeg');
  });
});

describe('allowlist', () => {
  it('accepts exactly the declared types', () => {
    for (const t of ALLOWED_TYPES) expect(isAllowedType(t)).toBe(true);
    expect(isAllowedType(null)).toBe(false);
  });

  it('maps every allowed type to an extension', () => {
    for (const t of ALLOWED_TYPES) {
      expect(EXTENSION_FOR[t]).toMatch(/^[a-z0-9]+$/);
    }
    expect(new Set(Object.values(EXTENSION_FOR)).size).toBe(ALLOWED_TYPES.length);
  });

  it('produces a readable label for error messages', () => {
    expect(ALLOWED_TYPES_LABEL).toContain('JPEG');
    expect(ALLOWED_TYPES_LABEL).toContain('DICOM');
    expect(ALLOWED_TYPES_LABEL).not.toContain('/');
  });
});
