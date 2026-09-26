import { createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FiscalCertificateError,
  describeSubject,
  importSigningKey,
  parseSigningMaterial,
  signRsaSha256,
} from './fiscal-crypto';

/**
 * Fixtures are throwaway self-signed certificates generated for these tests
 * (openssl req -x509 -newkey rsa:2048 -nodes …). They sign nothing real.
 */
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const key = fixture('test-key.pem');
const keyPkcs1 = fixture('test-key-pkcs1.pem');
const cert = fixture('test-cert.pem');

describe('parseSigningMaterial', () => {
  it('reads a key and its certificate, and describes who it belongs to', async () => {
    const m = await parseSigningMaterial(`${key}\n${cert}`);
    expect(m.info.subject.CN).toBe('Klinika Test');
    expect(m.info.subject.serialNumber).toBe('L12345678A');
    expect(describeSubject(m.info.subject)).toContain('O=Test Clinic');
    expect(m.info.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(m.certificatePem).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
  });

  it('accepts the traditional RSA PRIVATE KEY form', async () => {
    const m = await parseSigningMaterial(`${cert}\n${keyPkcs1}`);
    expect(m.info.subject.CN).toBe('Klinika Test');
  });

  it('finds the matching certificate among CA certificates', async () => {
    const m = await parseSigningMaterial(`${fixture('other-cert.pem')}\n${key}\n${cert}`);
    expect(m.info.subject.CN).toBe('Klinika Test');
  });

  it('refuses a key that belongs to a different certificate', async () => {
    await expect(parseSigningMaterial(`${key}\n${fixture('other-cert.pem')}`)).rejects.toThrow(
      /does not belong/,
    );
  });

  it('refuses an expired certificate', async () => {
    await expect(parseSigningMaterial(`${key}\n${cert}`, new Date('2100-01-01'))).rejects.toThrow(
      /expired/,
    );
  });

  it('explains a missing key and a passphrase-protected one', async () => {
    await expect(parseSigningMaterial(cert)).rejects.toBeInstanceOf(FiscalCertificateError);
    await expect(
      parseSigningMaterial(`-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n${cert}`),
    ).rejects.toThrow(/passphrase/);
  });
});

describe('signRsaSha256', () => {
  it('produces a signature an independent RSA-SHA256 verifier accepts', async () => {
    const m = await parseSigningMaterial(`${key}\n${cert}`);
    const signature = await signRsaSha256(await importSigningKey(m.pkcs8), 'L12345678A|2026-09-15T10:30:00+02:00|1');
    const ok = createVerify('RSA-SHA256').update('L12345678A|2026-09-15T10:30:00+02:00|1').verify(cert, signature);
    expect(ok).toBe(true);
  });
});
