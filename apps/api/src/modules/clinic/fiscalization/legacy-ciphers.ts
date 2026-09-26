/**
 * The two block ciphers a PKCS#12 file from before 2020 is encrypted with:
 * Triple DES (the key) and 40-bit RC2 (the certificates).
 *
 * ── Why these are written out here ────────────────────────────────────────
 *
 * Neither is in WebCrypto. Node's OpenSSL 3 still has DES-EDE3 but moved RC2
 * to the "legacy" provider, which Node does not load — `createDecipheriv(
 * 'rc2-40-cbc', …)` throws "unsupported" — and the Workers runtime makes no
 * promise about either. Certificates issued for Albanian fiscalization are
 * exactly the kind of file that still uses them.
 *
 * They are used to DECRYPT a file the clinic uploads, once, and never to
 * protect anything. Speed does not matter (a certificate file is a few
 * kilobytes) and neither does constant time (the password is the clinic's
 * own, typed into its own session), so both are written for readability.
 *
 * Encryption is included only so the specs can round-trip; the proof that
 * these are right is that they agree with OpenSSL-generated files and with
 * the published test vectors.
 */

/* ── DES ─────────────────────────────────────────────────────────────── */

// FIPS 46-3. Tables list 1-based bit positions, most significant bit first.
// prettier-ignore
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
// prettier-ignore
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
// prettier-ignore
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6,
  64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
/** The final permutation is the inverse of IP; derived, so it cannot be mistyped. */
const FP = (() => {
  const out = new Array<number>(64);
  IP.forEach((from, to) => (out[from - 1] = to + 1));
  return out;
})();
// prettier-ignore
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
// prettier-ignore
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];

// prettier-ignore
export const DES_SBOXES: readonly (readonly number[])[] = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

type Bits = Uint8Array;

function toBits(bytes: Uint8Array): Bits {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < out.length; i++) out[i] = (bytes[i >> 3]! >> (7 - (i & 7))) & 1;
  return out;
}

function fromBits(bits: Bits): Uint8Array {
  const out = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < bits.length; i++) out[i >> 3]! |= bits[i]! << (7 - (i & 7));
  return out;
}

function permute(bits: Bits, table: readonly number[]): Bits {
  const out = new Uint8Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = bits[table[i]! - 1]!;
  return out;
}

function rotateLeft(bits: Bits, n: number): Bits {
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = bits[(i + n) % bits.length]!;
  return out;
}

/** The sixteen 48-bit round keys of one 8-byte DES key. */
function desSubkeys(key: Uint8Array): Bits[] {
  const cd = permute(toBits(key), PC1);
  let c = cd.subarray(0, 28);
  let d = cd.subarray(28, 56);
  const keys: Bits[] = [];
  for (const shift of SHIFTS) {
    c = rotateLeft(c, shift);
    d = rotateLeft(d, shift);
    const joined = new Uint8Array(56);
    joined.set(c, 0);
    joined.set(d, 28);
    keys.push(permute(joined, PC2));
  }
  return keys;
}

function feistel(r: Bits, k: Bits): Bits {
  const x = permute(r, E);
  for (let i = 0; i < 48; i++) x[i]! ^= k[i]!;
  const out = new Uint8Array(32);
  for (let s = 0; s < 8; s++) {
    const b = x.subarray(s * 6, s * 6 + 6);
    const row = (b[0]! << 1) | b[5]!;
    const col = (b[1]! << 3) | (b[2]! << 2) | (b[3]! << 1) | b[4]!;
    const v = DES_SBOXES[s]![row * 16 + col]!;
    for (let j = 0; j < 4; j++) out[s * 4 + j] = (v >> (3 - j)) & 1;
  }
  return permute(out, P);
}

function desBlock(block: Uint8Array, subkeys: readonly Bits[]): Uint8Array {
  const b = permute(toBits(block), IP);
  let l: Bits = b.slice(0, 32);
  let r: Bits = b.slice(32, 64);
  for (const k of subkeys) {
    const f = feistel(r, k);
    const next = new Uint8Array(32);
    for (let i = 0; i < 32; i++) next[i] = l[i]! ^ f[i]!;
    l = r;
    r = next;
  }
  const joined = new Uint8Array(64);
  joined.set(r, 0);
  joined.set(l, 32);
  return fromBits(permute(joined, FP));
}

/** One DES key, both directions. Exported for the known-answer test. */
export function desKey(key: Uint8Array) {
  if (key.length !== 8) throw new RangeError('A DES key is 8 bytes');
  const enc = desSubkeys(key);
  const dec = [...enc].reverse();
  return {
    encrypt: (block: Uint8Array) => desBlock(block, enc),
    decrypt: (block: Uint8Array) => desBlock(block, dec),
  };
}

/** Triple DES, encrypt-decrypt-encrypt. A 16-byte key is two-key 3DES (K3 = K1). */
function tripleDes(key: Uint8Array) {
  if (key.length !== 24 && key.length !== 16)
    throw new RangeError('A Triple DES key is 16 or 24 bytes');
  const k1 = desKey(key.subarray(0, 8));
  const k2 = desKey(key.subarray(8, 16));
  const k3 = key.length === 24 ? desKey(key.subarray(16, 24)) : k1;
  return {
    encrypt: (b: Uint8Array) => k3.encrypt(k2.decrypt(k1.encrypt(b))),
    decrypt: (b: Uint8Array) => k1.decrypt(k2.encrypt(k3.decrypt(b))),
  };
}

/* ── RC2 (RFC 2268) ──────────────────────────────────────────────────── */

export const RC2_PITABLE = Uint8Array.from(
  (
    'd978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2179a59f587b34f1361456d8d09817d32bd8f40eb86b77b0bf09521225c6b4e82' +
    '54d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb6266fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed7' +
    '08e8eade8052eef784aa72ac354d6a2a961ad2715a1549744b9fd05e0418a4ecc2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731' +
    '2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a90d38341bab33ffb0bb480c5fb9b1cd2ec5f3db47e5a59c770aa62068fe7fc1ad'
  )
    .match(/../g)!
    .map((h) => parseInt(h, 16)),
);

function rc2Key(key: Uint8Array, effectiveBits: number): Uint16Array {
  const t = key.length;
  if (t < 1 || t > 128) throw new RangeError('An RC2 key is 1 to 128 bytes');
  const l = new Uint8Array(256);
  l.set(key);
  for (let i = t; i < 256; i++) l[i] = RC2_PITABLE[(l[i - 1]! + l[i - t]!) & 0xff]!;
  const t8 = (effectiveBits + 7) >> 3;
  const tm = 0xff >> (8 * t8 - effectiveBits);
  l[128 - t8] = RC2_PITABLE[l[128 - t8]! & tm]!;
  for (let i = 127 - t8; i >= 0; i--) l[i] = RC2_PITABLE[l[i + 1]! ^ l[i + t8]!]!;
  const k = new Uint16Array(64);
  for (let i = 0; i < 64; i++) k[i] = l[2 * i]! | (l[2 * i + 1]! << 8);
  return k;
}

const RC2_SHIFT = [1, 2, 3, 5];
const m16 = (x: number) => x & 0xffff;

export function rc2(key: Uint8Array, effectiveBits: number) {
  const k = rc2Key(key, effectiveBits);
  const words = (b: Uint8Array) => [
    b[0]! | (b[1]! << 8),
    b[2]! | (b[3]! << 8),
    b[4]! | (b[5]! << 8),
    b[6]! | (b[7]! << 8),
  ];
  const bytes = (r: number[]) => Uint8Array.from(r.flatMap((w) => [w & 0xff, w >> 8]));

  function encrypt(block: Uint8Array): Uint8Array {
    const r = words(block);
    let j = 0;
    const mix = () => {
      for (let i = 0; i < 4; i++) {
        const a = r[(i + 3) % 4]!;
        const b = r[(i + 2) % 4]!;
        const c = r[(i + 1) % 4]!;
        const v = m16(r[i]! + k[j++]! + (a & b) + (~a & c));
        r[i] = m16((v << RC2_SHIFT[i]!) | (v >> (16 - RC2_SHIFT[i]!)));
      }
    };
    const mash = () => {
      for (let i = 0; i < 4; i++) r[i] = m16(r[i]! + k[r[(i + 3) % 4]! & 63]!);
    };
    for (let n = 0; n < 5; n++) mix();
    mash();
    for (let n = 0; n < 6; n++) mix();
    mash();
    for (let n = 0; n < 5; n++) mix();
    return bytes(r);
  }

  function decrypt(block: Uint8Array): Uint8Array {
    const r = words(block);
    let j = 63;
    const mix = () => {
      for (let i = 3; i >= 0; i--) {
        const v = r[i]!;
        const rot = m16((v >> RC2_SHIFT[i]!) | (v << (16 - RC2_SHIFT[i]!)));
        const a = r[(i + 3) % 4]!;
        const b = r[(i + 2) % 4]!;
        const c = r[(i + 1) % 4]!;
        r[i] = m16(rot - k[j--]! - (a & b) - (~a & c));
      }
    };
    const mash = () => {
      for (let i = 3; i >= 0; i--) r[i] = m16(r[i]! - k[r[(i + 3) % 4]! & 63]!);
    };
    for (let n = 0; n < 5; n++) mix();
    mash();
    for (let n = 0; n < 6; n++) mix();
    mash();
    for (let n = 0; n < 5; n++) mix();
    return bytes(r);
  }

  return { encrypt, decrypt };
}

/* ── CBC with PKCS#7 padding ─────────────────────────────────────────── */

interface BlockCipher {
  encrypt(block: Uint8Array): Uint8Array;
  decrypt(block: Uint8Array): Uint8Array;
}

/** Thrown when the padding is wrong — in practice, when the password is. */
export class PaddingError extends Error {
  constructor() {
    super('The decrypted data is not validly padded');
    this.name = 'PaddingError';
  }
}

function cbcDecrypt(cipher: BlockCipher, iv: Uint8Array, data: Uint8Array): Buffer {
  if (iv.length !== 8 || data.length === 0 || data.length % 8 !== 0)
    throw new PaddingError();
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let off = 0; off < data.length; off += 8) {
    const block = data.subarray(off, off + 8);
    const plain = cipher.decrypt(block);
    for (let i = 0; i < 8; i++) out[off + i] = plain[i]! ^ prev[i]!;
    prev = block;
  }
  const pad = out[out.length - 1]!;
  if (pad < 1 || pad > 8) throw new PaddingError();
  for (let i = out.length - pad; i < out.length; i++)
    if (out[i] !== pad) throw new PaddingError();
  return Buffer.from(out.subarray(0, out.length - pad));
}

function cbcEncrypt(cipher: BlockCipher, iv: Uint8Array, data: Uint8Array): Buffer {
  const pad = 8 - (data.length % 8);
  const input = new Uint8Array(data.length + pad);
  input.set(data);
  input.fill(pad, data.length);
  const out = new Uint8Array(input.length);
  let prev = iv;
  for (let off = 0; off < input.length; off += 8) {
    const x = new Uint8Array(8);
    for (let i = 0; i < 8; i++) x[i] = input[off + i]! ^ prev[i]!;
    prev = cipher.encrypt(x);
    out.set(prev, off);
  }
  return Buffer.from(out);
}

export const desEde3Cbc = {
  decrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) =>
    cbcDecrypt(tripleDes(key), iv, data),
  encrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) =>
    cbcEncrypt(tripleDes(key), iv, data),
};

export const rc2Cbc = {
  decrypt: (key: Uint8Array, effectiveBits: number, iv: Uint8Array, data: Uint8Array) =>
    cbcDecrypt(rc2(key, effectiveBits), iv, data),
  encrypt: (key: Uint8Array, effectiveBits: number, iv: Uint8Array, data: Uint8Array) =>
    cbcEncrypt(rc2(key, effectiveBits), iv, data),
};
