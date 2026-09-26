import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FiscalCertificateError, parseSigningMaterial } from './fiscal-crypto';
import { pkcs12ToPem, readPkcs12 } from './fiscal-pkcs12';

/**
 * Fixtures made from the throwaway test key and certificate with OpenSSL 3.2:
 *
 *   test-modern.p12       default export: PBES2 / PBKDF2-HMAC-SHA256 / AES-256-CBC,
 *                         SHA-256 MAC, with an unrelated CA certificate added
 *   test-pbes2-3des.p12   PBES2 with DES-EDE3-CBC
 *   test-3des.p12         PKCS#12 PBE, SHA-1 and 3-key Triple DES throughout
 *   test-legacy.p12       -legacy: 40-bit RC2 certificates, Triple DES key,
 *                         SHA-1 MAC — what OpenSSL 1.x and older Windows wrote
 *
 * The last two use a password with Albanian letters, written as UTF-8.
 */
const dir = join(__dirname, '__fixtures__');
const file = (name: string) => readFileSync(join(dir, name));
const ASCII = 'Fiskalizim-2026';
const ALBANIAN = 'Çelës-Fiskal-ë';

const expectedKey = createPrivateKey(
  readFileSync(join(dir, 'test-key.pem'), 'utf8'),
).export({ type: 'pkcs8', format: 'der' });

describe('readPkcs12', () => {
  it.each([
    ['test-modern.p12', ASCII, 2],
    ['test-pbes2-3des.p12', ASCII, 1],
    ['test-3des.p12', ALBANIAN, 1],
    ['test-legacy.p12', ALBANIAN, 1],
  ])('opens %s', async (name, password, certificates) => {
    const contents = await readPkcs12(file(name), password);
    expect(contents.keys).toHaveLength(1);
    expect(contents.keys[0]!.equals(expectedKey)).toBe(true);
    expect(contents.certificates).toHaveLength(certificates);
  });

  it('becomes signing material through the same checks as a PEM upload', async () => {
    const material = await parseSigningMaterial(
      await pkcs12ToPem(file('test-modern.p12'), ASCII),
    );
    // The CA certificate is skipped: the key belongs to the clinic's own.
    expect(material.info.subject.CN).toBe('Klinika Test');
    expect(material.info.subject.serialNumber).toBe('L12345678A');
  });

  it.each(['test-modern.p12', 'test-legacy.p12'])(
    'says so when the password of %s is wrong',
    async (name) => {
      const attempt = readPkcs12(file(name), 'not-the-password');
      await expect(attempt).rejects.toBeInstanceOf(FiscalCertificateError);
      await expect(readPkcs12(file(name), 'not-the-password')).rejects.toThrow(
        /password is not correct/,
      );
    },
  );

  it('refuses something that is not a certificate file', async () => {
    await expect(
      readPkcs12(Buffer.from('-----BEGIN CERTIFICATE-----\nMIIB…'), ASCII),
    ).rejects.toThrow(/not a \.p12/);
    const truncated = file('test-modern.p12').subarray(0, 900);
    await expect(readPkcs12(truncated, ASCII)).rejects.toBeInstanceOf(
      FiscalCertificateError,
    );
  });

  it('reads BER: indefinite lengths and a constructed octet string, as Java tooling writes', async () => {
    const ber = toBer(file('test-modern.p12'));
    expect(ber[1]).toBe(0x80);
    const contents = await readPkcs12(ber, ASCII);
    expect(contents.keys[0]!.equals(expectedKey)).toBe(true);
  });
});

/* ── a DER → BER rewrite of the outer structure, for the test above ── */

function header(buf: Buffer, at: number) {
  const first = buf[at + 1]!;
  if (!(first & 0x80)) return { start: at + 2, end: at + 2 + first };
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]!;
  return { start: at + 2 + n, end: at + 2 + n + len };
}

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const EOC = Buffer.from([0, 0]);

function toBer(der: Buffer): Buffer {
  const pfx = header(der, 0);
  const version = header(der, pfx.start);
  const authSafeAt = version.end;
  const authSafe = header(der, authSafeAt);
  const oid = header(der, authSafe.start);
  const wrap = header(der, oid.end);
  const octets = header(der, wrap.start);
  const data = der.subarray(octets.start, octets.end);
  const mac = der.subarray(authSafe.end, pfx.end);

  // The authenticated bytes split into chunks of a constructed OCTET STRING.
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += 1000) {
    const part = data.subarray(i, i + 1000);
    chunks.push(Buffer.concat([Buffer.from([0x04]), derLen(part.length), part]));
  }
  return Buffer.concat([
    Buffer.from([0x30, 0x80]),
    der.subarray(pfx.start, version.end),
    Buffer.from([0x30, 0x80]),
    der.subarray(authSafe.start, oid.end),
    Buffer.from([0xa0, 0x80, 0x24, 0x80]),
    ...chunks,
    EOC, // octet string
    EOC, // [0]
    EOC, // content info
    mac,
    EOC, // pfx
  ]);
}
