import { createHash, createHmac, timingSafeEqual, webcrypto } from 'node:crypto';
import { FiscalCertificateError } from './fiscal-crypto';
import { PaddingError, desEde3Cbc, rc2Cbc } from './legacy-ciphers';

/**
 * Reading the .p12 / .pfx file the certificate authority issues, in place.
 *
 * Until this existed a clinic had to run `openssl pkcs12 -nodes` and upload a
 * PEM, which is a step no reception desk should be asked to take and which
 * leaves an unencrypted private key on somebody's laptop. This reads the file
 * as issued, with its password, and hands back the same private key and
 * certificates the PEM path produces — so everything after it (the pairing
 * check, the expiry check, sealing the key) is shared and already tested.
 *
 * ── What is supported ─────────────────────────────────────────────────────
 *
 *   integrity   HMAC-SHA1/-256/-384/-512 MAC with the PKCS#12 key derivation
 *               — checked first, so a wrong password is reported as such
 *   PBES2       PBKDF2 (HMAC-SHA1/-224/-256/-384/-512) with AES-128/192/256-
 *               CBC or DES-EDE3-CBC: OpenSSL 3 and current Windows exports
 *   PKCS#12 PBE SHA-1 with 3-key or 2-key Triple DES, or 40/128-bit RC2:
 *               OpenSSL 1.x, older Windows and Java keytool exports
 *   encoding    DER and BER (indefinite lengths, constructed octet strings),
 *               which some Java and .NET tooling writes
 *
 * Not supported, each with an error that says so: public-key (enveloped)
 * protection, RC4, and the PBMAC1 integrity scheme OpenSSL 3.4 can opt into.
 *
 * The password never leaves this function: it is not logged, not stored and
 * not returned.
 */

const subtle = webcrypto.subtle;

/* ── BER reading ─────────────────────────────────────────────────────── */

interface Node {
  tag: number;
  /** First content byte. */
  start: number;
  /** One past the last content byte (before an end-of-contents marker). */
  end: number;
  /** First byte of this element. */
  offset: number;
  /** First byte after this element, end-of-contents included. */
  next: number;
}

const malformed = () =>
  new FiscalCertificateError(
    'The certificate file is damaged or is not a .p12/.pfx file.',
  );

function read(buf: Buffer, offset: number, limit = buf.length): Node {
  if (offset + 2 > limit) throw malformed();
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw malformed();
  const first = buf[offset + 1]!;
  let start = offset + 2;
  if (first === 0x80) {
    // Indefinite length: children until 00 00. Only constructed forms may.
    if (!(tag & 0x20)) throw malformed();
    let at = start;
    while (true) {
      if (at + 2 > limit) throw malformed();
      if (buf[at] === 0 && buf[at + 1] === 0) break;
      at = read(buf, at, limit).next;
    }
    return { tag, start, end: at, offset, next: at + 2 };
  }
  let len = first;
  if (first & 0x80) {
    const n = first & 0x7f;
    if (n === 0 || n > 4) throw malformed();
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]!;
    start += n;
  }
  const end = start + len;
  if (end > limit) throw malformed();
  return { tag, start, end, offset, next: end };
}

function kids(buf: Buffer, node: Node): Node[] {
  const out: Node[] = [];
  for (let at = node.start; at < node.end;) {
    const child = read(buf, at, node.end);
    out.push(child);
    at = child.next;
  }
  return out;
}

function expectTag(node: Node | undefined, tag: number): Node {
  if (!node || node.tag !== tag) throw malformed();
  return node;
}

const SEQUENCE = 0x30;
const OCTETS = 0x04;
const OID = 0x06;
const INTEGER = 0x02;

/** The bytes of an OCTET STRING, primitive or constructed (BER). */
function octets(buf: Buffer, node: Node): Buffer {
  if (node.tag === OCTETS || node.tag === 0x80) return buf.subarray(node.start, node.end);
  if (node.tag === 0x24 || node.tag === 0xa0)
    return Buffer.concat(kids(buf, node).map((k) => octets(buf, k)));
  throw malformed();
}

function oid(buf: Buffer, node: Node): string {
  expectTag(node, OID);
  const bytes = buf.subarray(node.start, node.end);
  if (bytes.length === 0) throw malformed();
  const parts = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let v = 0;
  for (let i = 1; i < bytes.length; i++) {
    v = v * 128 + (bytes[i]! & 0x7f);
    if (!(bytes[i]! & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

function integer(buf: Buffer, node: Node): number {
  expectTag(node, INTEGER);
  let v = 0;
  for (let i = node.start; i < node.end; i++) v = v * 256 + buf[i]!;
  if (!Number.isSafeInteger(v)) throw malformed();
  return v;
}

/** [0] EXPLICIT: the single element inside. */
function explicit(buf: Buffer, node: Node | undefined): Node {
  if (!node || node.tag !== 0xa0) throw malformed();
  const inner = kids(buf, node)[0];
  if (!inner) throw malformed();
  return inner;
}

/** The whole encoding of an element, as bytes another parser can take. */
function encoding(buf: Buffer, node: Node): Buffer {
  return buf.subarray(node.offset, node.next);
}

/* ── object identifiers ──────────────────────────────────────────────── */

const OIDS = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  envelopedData: '1.2.840.113549.1.7.3',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  safeContentsBag: '1.2.840.113549.1.12.10.1.6',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  pbmac1: '1.2.840.113549.1.5.14',
  pbeSha1Rc4_128: '1.2.840.113549.1.12.1.1',
  pbeSha1Rc4_40: '1.2.840.113549.1.12.1.2',
  pbeSha1Des3: '1.2.840.113549.1.12.1.3',
  pbeSha1Des2: '1.2.840.113549.1.12.1.4',
  pbeSha1Rc2_128: '1.2.840.113549.1.12.1.5',
  pbeSha1Rc2_40: '1.2.840.113549.1.12.1.6',
  desEde3Cbc: '1.2.840.113549.3.7',
} as const;

type HashName = 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512';

const DIGESTS: Readonly<Record<string, HashName>> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

const HMACS: Readonly<Record<string, HashName>> = {
  '1.2.840.113549.2.7': 'sha1',
  '1.2.840.113549.2.8': 'sha224',
  '1.2.840.113549.2.9': 'sha256',
  '1.2.840.113549.2.10': 'sha384',
  '1.2.840.113549.2.11': 'sha512',
};

const AES: Readonly<Record<string, number>> = {
  '2.16.840.1.101.3.4.1.2': 128,
  '2.16.840.1.101.3.4.1.22': 192,
  '2.16.840.1.101.3.4.1.42': 256,
};

const HASH_BYTES: Record<HashName, number> = {
  sha1: 20,
  sha224: 28,
  sha256: 32,
  sha384: 48,
  sha512: 64,
};
const HASH_BLOCK: Record<HashName, number> = {
  sha1: 64,
  sha224: 64,
  sha256: 64,
  sha384: 128,
  sha512: 128,
};
const WEBCRYPTO_HASH: Record<HashName, string> = {
  sha1: 'SHA-1',
  sha224: 'SHA-224',
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
};

/* ── key derivation ──────────────────────────────────────────────────── */

/**
 * The password as PKCS#12's own derivation takes it: UTF-16 big-endian with a
 * terminating zero. OpenSSL reads the typed password as UTF-8 first, which is
 * what JavaScript strings already are, so "Çelës" means the same thing here.
 */
function bmpPassword(password: string): Buffer {
  const out = Buffer.alloc((password.length + 1) * 2);
  for (let i = 0; i < password.length; i++)
    out.writeUInt16BE(password.charCodeAt(i), i * 2);
  return out;
}

/** RFC 7292, appendix B.2. `id` 1 derives a key, 2 an IV, 3 a MAC key. */
export function pkcs12Kdf(
  hash: HashName,
  password: Buffer,
  salt: Buffer,
  id: 1 | 2 | 3,
  iterations: number,
  length: number,
): Buffer {
  const u = HASH_BYTES[hash];
  const v = HASH_BLOCK[hash];
  const fill = (src: Buffer) => {
    if (src.length === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(v * Math.ceil(src.length / v));
    for (let i = 0; i < out.length; i++) out[i] = src[i % src.length]!;
    return out;
  };
  const d = Buffer.alloc(v, id);
  const i = Buffer.concat([fill(salt), fill(password)]);
  const blocks: Buffer[] = [];
  for (let n = 0; n < Math.ceil(length / u); n++) {
    let a = createHash(hash).update(d).update(i).digest();
    for (let r = 1; r < iterations; r++) a = createHash(hash).update(a).digest();
    blocks.push(a);
    const b = Buffer.alloc(v);
    for (let k = 0; k < v; k++) b[k] = a[k % u]!;
    // I_j = (I_j + B + 1) mod 2^(v·8), for each v-byte block of I.
    for (let off = 0; off < i.length; off += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = i[off + k]! + b[k]! + carry;
        i[off + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/* ── decryption ──────────────────────────────────────────────────────── */

class WrongPassword extends Error {}

async function decryptWith(
  buf: Buffer,
  algorithm: Node,
  data: Buffer,
  password: string,
): Promise<Buffer> {
  const [algOid, params] = kids(buf, expectTag(algorithm, SEQUENCE));
  const alg = oid(buf, algOid!);
  try {
    if (alg === OIDS.pbes2) return await pbes2(buf, params, data, password);
    const pbe = PKCS12_PBE[alg];
    if (pbe) {
      const [saltNode, iterNode] = kids(buf, expectTag(params, SEQUENCE));
      const salt = octets(buf, expectTag(saltNode, OCTETS));
      const iterations = integer(buf, iterNode!);
      const pwd = bmpPassword(password);
      const key = pkcs12Kdf('sha1', pwd, salt, 1, iterations, pbe.keyBytes);
      const iv = pkcs12Kdf('sha1', pwd, salt, 2, iterations, 8);
      return pbe.kind === 'des3'
        ? desEde3Cbc.decrypt(key, iv, data)
        : rc2Cbc.decrypt(key, pbe.keyBytes * 8, iv, data);
    }
    if (alg === OIDS.pbeSha1Rc4_128 || alg === OIDS.pbeSha1Rc4_40) {
      throw new FiscalCertificateError(
        'This certificate file uses RC4 encryption, which is not supported. Export it again from the certificate store with AES or Triple DES.',
      );
    }
    throw new FiscalCertificateError(
      `This certificate file is encrypted with an algorithm this system does not support (${alg}).`,
    );
  } catch (err) {
    if (err instanceof PaddingError) throw new WrongPassword();
    // WebCrypto reports AES padding failures as a generic OperationError.
    if ((err as { name?: string }).name === 'OperationError') throw new WrongPassword();
    throw err;
  }
}

const PKCS12_PBE: Readonly<Record<string, { kind: 'des3' | 'rc2'; keyBytes: number }>> = {
  [OIDS.pbeSha1Des3]: { kind: 'des3', keyBytes: 24 },
  [OIDS.pbeSha1Des2]: { kind: 'des3', keyBytes: 16 },
  [OIDS.pbeSha1Rc2_128]: { kind: 'rc2', keyBytes: 16 },
  [OIDS.pbeSha1Rc2_40]: { kind: 'rc2', keyBytes: 5 },
};

async function pbes2(
  buf: Buffer,
  params: Node | undefined,
  data: Buffer,
  password: string,
): Promise<Buffer> {
  const [kdf, scheme] = kids(buf, expectTag(params, SEQUENCE));
  const [kdfOid, kdfParams] = kids(buf, expectTag(kdf, SEQUENCE));
  if (oid(buf, kdfOid!) !== OIDS.pbkdf2) {
    throw new FiscalCertificateError(
      'This certificate file uses a key derivation this system does not support.',
    );
  }
  const p = kids(buf, expectTag(kdfParams, SEQUENCE));
  const salt = octets(buf, expectTag(p[0], OCTETS));
  const iterations = integer(buf, p[1]!);
  let prf: HashName = 'sha1';
  for (const extra of p.slice(2)) {
    if (extra.tag !== SEQUENCE) continue; // keyLength; the cipher fixes it anyway
    const name = HMACS[oid(buf, kids(buf, extra)[0]!)];
    if (!name)
      throw new FiscalCertificateError(
        'This certificate file uses a key derivation this system does not support.',
      );
    prf = name;
  }

  const [schemeOid, ivNode] = kids(buf, expectTag(scheme, SEQUENCE));
  const cipher = oid(buf, schemeOid!);
  const iv = octets(buf, expectTag(ivNode, OCTETS));
  const aesBits = AES[cipher];
  const keyBytes = aesBits ? aesBits / 8 : cipher === OIDS.desEde3Cbc ? 24 : 0;
  if (!keyBytes) {
    throw new FiscalCertificateError(
      `This certificate file is encrypted with an algorithm this system does not support (${cipher}).`,
    );
  }

  // PBES2 takes the password as its UTF-8 bytes, not the BMP form above.
  const base = await subtle.importKey(
    'raw',
    Buffer.from(password, 'utf8'),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const key = Buffer.from(
    await subtle.deriveBits(
      { name: 'PBKDF2', hash: WEBCRYPTO_HASH[prf], salt, iterations },
      base,
      keyBytes * 8,
    ),
  );
  if (!aesBits) return desEde3Cbc.decrypt(key, iv, data);
  const aesKey = await subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  return Buffer.from(await subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, data));
}

/* ── the file ────────────────────────────────────────────────────────── */

export interface Pkcs12Contents {
  /** PKCS#8 DER, one per key in the file. */
  keys: Buffer[];
  /** X.509 DER, the clinic's certificate and any issuing CA certificates. */
  certificates: Buffer[];
}

function verifyMac(
  buf: Buffer,
  macData: Node,
  authSafe: Buffer,
  password: Buffer,
): boolean {
  const [digestInfo, saltNode, iterNode] = kids(buf, expectTag(macData, SEQUENCE));
  const [algId, digestNode] = kids(buf, expectTag(digestInfo, SEQUENCE));
  const algOid = oid(buf, kids(buf, expectTag(algId, SEQUENCE))[0]!);
  if (algOid === OIDS.pbmac1) {
    throw new FiscalCertificateError(
      'This certificate file uses the PBMAC1 integrity check, which is not supported. Export it without -pbmac1_pbkdf2.',
    );
  }
  const hash = DIGESTS[algOid];
  if (!hash)
    throw new FiscalCertificateError(
      'This certificate file uses an integrity check this system does not support.',
    );
  const expected = octets(buf, expectTag(digestNode, OCTETS));
  const salt = octets(buf, expectTag(saltNode, OCTETS));
  const iterations = iterNode ? integer(buf, iterNode) : 1;
  const key = pkcs12Kdf(hash, password, salt, 3, iterations, HASH_BYTES[hash]);
  const actual = createHmac(hash, key).update(authSafe).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readSafeContents(
  buf: Buffer,
  password: string,
  out: Pkcs12Contents,
): Promise<void> {
  const root = read(buf, 0);
  for (const bag of kids(buf, expectTag(root, SEQUENCE))) {
    const [idNode, valueWrap] = kids(buf, expectTag(bag, SEQUENCE));
    const id = oid(buf, idNode!);
    if (id === OIDS.keyBag) {
      out.keys.push(Buffer.from(encoding(buf, explicit(buf, valueWrap))));
    } else if (id === OIDS.shroudedKeyBag) {
      const [alg, enc] = kids(buf, expectTag(explicit(buf, valueWrap), SEQUENCE));
      out.keys.push(await decryptWith(buf, alg!, octets(buf, enc!), password));
    } else if (id === OIDS.certBag) {
      const [certType, certValue] = kids(
        buf,
        expectTag(explicit(buf, valueWrap), SEQUENCE),
      );
      if (oid(buf, certType!) !== OIDS.x509Certificate) continue; // SDSI certificates: not ours
      out.certificates.push(Buffer.from(octets(buf, explicit(buf, certValue))));
    } else if (id === OIDS.safeContentsBag) {
      await readSafeContents(
        Buffer.from(encoding(buf, explicit(buf, valueWrap))),
        password,
        out,
      );
    }
    // CRL and secret bags carry nothing a signature needs.
  }
}

/**
 * Open a PKCS#12 file with its password. Throws FiscalCertificateError with a
 * sentence an administrator can act on: wrong password, damaged file, or an
 * encryption this reader does not support.
 */
export async function readPkcs12(
  file: Buffer,
  password: string,
): Promise<Pkcs12Contents> {
  if (file.length < 32 || file[0] !== SEQUENCE) {
    throw new FiscalCertificateError('That is not a .p12/.pfx certificate file.');
  }
  const pfx = read(file, 0);
  const [version, authSafe, macData] = kids(file, pfx);
  if (integer(file, version!) !== 3) throw malformed();
  const [ctype, content] = kids(file, expectTag(authSafe, SEQUENCE));
  if (oid(file, ctype!) !== OIDS.data) {
    throw new FiscalCertificateError(
      'This certificate file is signed with a public key rather than a password, which is not supported.',
    );
  }
  const authSafeBytes = octets(file, explicit(file, content));

  // A wrong password is caught here, by the MAC, before anything is decrypted.
  // An empty password is written by some tools with its terminator and by
  // others without, so both are tried.
  if (macData) {
    const candidates =
      password === '' ? [bmpPassword(''), Buffer.alloc(0)] : [bmpPassword(password)];
    if (!candidates.some((pwd) => verifyMac(file, macData, authSafeBytes, pwd))) {
      throw new FiscalCertificateError('The certificate password is not correct.');
    }
  }

  const out: Pkcs12Contents = { keys: [], certificates: [] };
  try {
    const safes = read(authSafeBytes, 0);
    for (const info of kids(authSafeBytes, expectTag(safes, SEQUENCE))) {
      const [typeNode, wrapped] = kids(authSafeBytes, expectTag(info, SEQUENCE));
      const type = oid(authSafeBytes, typeNode!);
      if (type === OIDS.data) {
        const inner = octets(authSafeBytes, explicit(authSafeBytes, wrapped));
        await readSafeContents(Buffer.from(inner), password, out);
      } else if (type === OIDS.encryptedData) {
        const encryptedData = explicit(authSafeBytes, wrapped);
        const [, eci] = kids(authSafeBytes, expectTag(encryptedData, SEQUENCE));
        const [, alg, encrypted] = kids(authSafeBytes, expectTag(eci, SEQUENCE));
        if (!encrypted) continue;
        const plain = await decryptWith(
          authSafeBytes,
          alg!,
          octets(authSafeBytes, encrypted),
          password,
        );
        await readSafeContents(plain, password, out);
      } else if (type === OIDS.envelopedData) {
        throw new FiscalCertificateError(
          'This certificate file is protected with a public key rather than a password, which is not supported.',
        );
      }
    }
  } catch (err) {
    if (err instanceof WrongPassword)
      throw new FiscalCertificateError('The certificate password is not correct.');
    throw err;
  }
  return out;
}

const armour = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()}\n-----END ${label}-----\n`;

/**
 * The file's contents as the PEM text the existing certificate path reads,
 * so both ways in go through one set of checks. Held in memory only.
 */
export async function pkcs12ToPem(file: Buffer, password: string): Promise<string> {
  const { keys, certificates } = await readPkcs12(file, password);
  if (keys.length === 0) {
    throw new FiscalCertificateError(
      'The certificate file holds no private key. Export it again with the private key included.',
    );
  }
  return [
    ...keys.map((k) => armour('PRIVATE KEY', k)),
    ...certificates.map((c) => armour('CERTIFICATE', c)),
  ].join('');
}
