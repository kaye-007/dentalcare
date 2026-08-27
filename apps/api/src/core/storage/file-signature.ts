/**
 * Magic-byte sniffing for uploaded files.
 *
 * A browser-supplied Content-Type is a claim, not evidence: any client can
 * POST an executable labelled `image/png`. Before a byte reaches storage we
 * read its actual header and refuse anything whose real format is not on the
 * allowlist. Implemented directly rather than pulled from a dependency —
 * these are a handful of fixed byte sequences, and a parser we control is one
 * less supply-chain surface on an upload path that accepts patient data.
 */

export type DetectedType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/tiff'
  | 'application/pdf'
  | 'application/dicom';

interface Signature {
  type: DetectedType;
  offset: number;
  bytes: readonly number[];
  /** Extra structural check for containers whose prefix alone is ambiguous. */
  verify?: (buf: Buffer) => boolean;
}

const SIGNATURES: readonly Signature[] = [
  { type: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  // DICOM: 128-byte preamble, then the literal 'DICM'. This is the format an
  // intraoral or panoramic sensor actually writes.
  { type: 'application/dicom', offset: 128, bytes: [0x44, 0x49, 0x43, 0x4d] },
  // TIFF, both endiannesses — some older X-ray sensors still emit it.
  { type: 'image/tiff', offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
  { type: 'image/tiff', offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  // RIFF....WEBP — the 4 size bytes between the two markers are skipped.
  {
    type: 'image/webp',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46], // RIFF
    verify: (buf) => buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP',
  },
];

function matches(buf: Buffer, sig: Signature): boolean {
  const end = sig.offset + sig.bytes.length;
  if (buf.length < end) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buf[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return sig.verify ? sig.verify(buf) : true;
}

/** The file's real type, or null if it matches no known signature. */
export function detectFileType(buf: Buffer): DetectedType | null {
  for (const sig of SIGNATURES) {
    if (matches(buf, sig)) return sig.type;
  }
  return null;
}

/** Canonical extension for a detected type, used when building storage keys. */
export const EXTENSION_FOR: Readonly<Record<DetectedType, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'application/pdf': 'pdf',
  'application/dicom': 'dcm',
});

/** Types a clinic may upload. Everything else is refused at the door. */
export const ALLOWED_TYPES: readonly DetectedType[] = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'application/pdf',
  'application/dicom',
]);

export function isAllowedType(t: DetectedType | null): t is DetectedType {
  return t !== null && ALLOWED_TYPES.includes(t);
}

/** Human list for error messages, e.g. "JPEG, PNG, WEBP, TIFF, PDF, DICOM". */
export const ALLOWED_TYPES_LABEL = ALLOWED_TYPES.map((t) =>
  t.split('/')[1].toUpperCase(),
).join(', ');
