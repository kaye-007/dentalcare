import { webcrypto } from 'node:crypto';

/**
 * The clinic's signing certificate: reading it, checking it, signing with it.
 *
 * ── Why by hand ───────────────────────────────────────────────────────────
 *
 * The tax authority issues the certificate as a PKCS#12 file. Parsing that
 * needs a library the size of node-forge, and this API also runs as a
 * Cloudflare Worker with a bundle limit. So the clinic converts it once —
 *
 *     openssl pkcs12 -in certificate.p12 -nodes -out certificate.pem
 *
 * — and uploads the PEM, which holds the private key and the certificate as
 * base64 DER. What is needed from that DER is small: the key in PKCS#8 form,
 * the certificate's validity dates and subject, and its public key to prove
 * the two belong together. A few dozen lines of DER walking cover it.
 *
 * Signing uses WebCrypto (RSASSA-PKCS1-v1_5 with SHA-256), which Node 20 and
 * Workers both provide identically.
 */

const subtle = webcrypto.subtle;
type CryptoKey = webcrypto.CryptoKey;

/** A refusal written for the administrator uploading the certificate. */
export class FiscalCertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiscalCertificateError';
  }
}

export interface PemBlock {
  label: string;
  der: Buffer;
}

export function pemBlocks(text: string): PemBlock[] {
  const out: PemBlock[] = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  for (const m of text.matchAll(re)) {
    out.push({ label: m[1]!, der: Buffer.from(m[2]!.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64') });
  }
  return out;
}

/* ── DER ─────────────────────────────────────────────────────────────── */

interface Tlv {
  tag: number;
  /** Offset of the first content byte. */
  start: number;
  /** Offset one past the last content byte. */
  end: number;
  /** Offset of the tag byte. */
  offset: number;
}

function readTlv(buf: Buffer, offset: number): Tlv {
  if (offset + 2 > buf.length) throw new FiscalCertificateError('The certificate data is truncated.');
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let start = offset + 2;
  if (len & 0x80) {
    const bytes = len & 0x7f;
    if (bytes === 0 || bytes > 4) throw new FiscalCertificateError('The certificate data is malformed.');
    len = 0;
    for (let i = 0; i < bytes; i++) len = len * 256 + buf[start + i]!;
    start += bytes;
  }
  const end = start + len;
  if (end > buf.length) throw new FiscalCertificateError('The certificate data is truncated.');
  return { tag, start, end, offset };
}

function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end; ) {
    const child = readTlv(buf, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** rsaEncryption, 1.2.840.113549.1.1.1, with its NULL parameters. */
const RSA_ALGORITHM = Buffer.from('300d06092a864886f70d0101010500', 'hex');

/**
 * A private key as PKCS#8. OpenSSL writes "PRIVATE KEY" (already PKCS#8) or,
 * with -traditional and in older versions, "RSA PRIVATE KEY" (PKCS#1), which
 * is wrapped: version 0, the RSA algorithm, and the PKCS#1 key as an octet
 * string.
 */
export function toPkcs8(block: PemBlock): Buffer {
  if (block.label === 'PRIVATE KEY') return block.der;
  if (block.label === 'RSA PRIVATE KEY') {
    return der(0x30, Buffer.concat([Buffer.from('020100', 'hex'), RSA_ALGORITHM, der(0x04, block.der)]));
  }
  if (block.label === 'ENCRYPTED PRIVATE KEY') {
    throw new FiscalCertificateError(
      'The private key is protected by a passphrase. Export it without one (openssl … -nodes).',
    );
  }
  throw new FiscalCertificateError(`"${block.label}" is not a private key.`);
}

function parseTime(buf: Buffer, t: Tlv): Date {
  const s = buf.toString('ascii', t.start, t.end);
  const m =
    t.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new FiscalCertificateError('The certificate has a validity date this system cannot read.');
  let year = Number(m[1]);
  if (t.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

const NAME_OIDS: Readonly<Record<string, string>> = {
  '550403': 'CN',
  '55040a': 'O',
  '550405': 'serialNumber',
  '550461': 'organizationIdentifier',
  '550406': 'C',
};

function parseName(buf: Buffer, name: Tlv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const set of children(buf, name)) {
    for (const attr of children(buf, set)) {
      const [oid, value] = children(buf, attr);
      if (!oid || !value) continue;
      const key = NAME_OIDS[buf.toString('hex', oid.start, oid.end)];
      if (key) out[key] = buf.toString('utf8', value.start, value.end);
    }
  }
  return out;
}

export interface CertificateInfo {
  subject: Record<string, string>;
  notBefore: Date;
  notAfter: Date;
  /** SubjectPublicKeyInfo, whole — what WebCrypto imports as 'spki'. */
  spki: Buffer;
}

export function parseCertificate(certDer: Buffer): CertificateInfo {
  const cert = readTlv(certDer, 0);
  const [tbs] = children(certDer, cert);
  if (!tbs || cert.tag !== 0x30 || tbs.tag !== 0x30) {
    throw new FiscalCertificateError('That is not an X.509 certificate.');
  }
  const fields = children(certDer, tbs);
  // [0] version is optional; everything after it is positional.
  const f = fields[0]?.tag === 0xa0 ? fields.slice(1) : fields;
  const [, , , validity, subject, spki] = f;
  if (!validity || !subject || !spki) throw new FiscalCertificateError('That is not an X.509 certificate.');
  const [notBefore, notAfter] = children(certDer, validity);
  if (!notBefore || !notAfter) throw new FiscalCertificateError('The certificate has no validity period.');
  return {
    subject: parseName(certDer, subject),
    notBefore: parseTime(certDer, notBefore),
    notAfter: parseTime(certDer, notAfter),
    spki: certDer.subarray(spki.offset, spki.end),
  };
}

/* ── signing ─────────────────────────────────────────────────────────── */

const RSA_SHA256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export async function importSigningKey(pkcs8: Buffer): Promise<CryptoKey> {
  try {
    return await subtle.importKey('pkcs8', pkcs8, RSA_SHA256, false, ['sign']);
  } catch {
    throw new FiscalCertificateError('The private key is not an RSA key this system can sign with.');
  }
}

/** RSA-SHA256 over the UTF-8 bytes of `data`. */
export async function signRsaSha256(key: CryptoKey, data: string): Promise<Buffer> {
  return Buffer.from(await subtle.sign(RSA_SHA256.name, key, Buffer.from(data, 'utf8')));
}

export interface SigningMaterial {
  pkcs8: Buffer;
  certificateDer: Buffer;
  /** The certificate alone, re-armoured: safe to store and display. */
  certificatePem: string;
  info: CertificateInfo;
}

/**
 * Read an uploaded PEM and prove it is usable: exactly one private key, a
 * certificate, currently valid, and the key belonging to that certificate.
 * A mismatched pair would sign every invoice with a signature the authority
 * rejects, so it is refused here, once, rather than at the first sale.
 */
export async function parseSigningMaterial(pem: string, now = new Date()): Promise<SigningMaterial> {
  const blocks = pemBlocks(pem);
  const keys = blocks.filter((b) => /PRIVATE KEY$/.test(b.label));
  const certs = blocks.filter((b) => b.label === 'CERTIFICATE');
  if (keys.length !== 1) {
    throw new FiscalCertificateError(
      keys.length === 0
        ? 'No private key was found. Export the .p12 with its key: openssl pkcs12 -in file.p12 -nodes'
        : 'More than one private key was found. Upload one certificate at a time.',
    );
  }
  if (certs.length === 0) throw new FiscalCertificateError('No certificate was found in the file.');

  const pkcs8 = toPkcs8(keys[0]!);
  const signingKey = await importSigningKey(pkcs8);
  const challenge = `dentalcare-fiscal-pair-check:${now.toISOString()}`;
  const signature = await signRsaSha256(signingKey, challenge);

  // A .p12 export can carry the issuing CA certificates as well; the clinic's
  // own certificate is the one whose public key verifies the key's signature.
  for (const cert of certs) {
    const info = parseCertificate(cert.der);
    let matches = false;
    try {
      const pub = await subtle.importKey('spki', info.spki, RSA_SHA256, false, ['verify']);
      matches = await subtle.verify(RSA_SHA256.name, pub, signature, Buffer.from(challenge, 'utf8'));
    } catch {
      matches = false;
    }
    if (!matches) continue;
    if (info.notAfter.getTime() <= now.getTime()) {
      throw new FiscalCertificateError(`The certificate expired on ${info.notAfter.toISOString().slice(0, 10)}.`);
    }
    if (info.notBefore.getTime() > now.getTime()) {
      throw new FiscalCertificateError(`The certificate is not valid until ${info.notBefore.toISOString().slice(0, 10)}.`);
    }
    const base64 = cert.der.toString('base64').replace(/(.{64})/g, '$1\n').trim();
    return {
      pkcs8,
      certificateDer: cert.der,
      certificatePem: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
      info,
    };
  }
  throw new FiscalCertificateError('The private key does not belong to any certificate in the file.');
}

/** "CN=Klinika Test, O=Test Clinic" for the settings screen. */
export function describeSubject(subject: Record<string, string>): string {
  return Object.entries(subject)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}
