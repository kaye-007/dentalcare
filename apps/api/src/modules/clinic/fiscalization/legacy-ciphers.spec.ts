import { createCipheriv, randomBytes } from 'node:crypto';
import {
  DES_SBOXES,
  PaddingError,
  RC2_PITABLE,
  desEde3Cbc,
  desKey,
  rc2,
  rc2Cbc,
} from './legacy-ciphers';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('DES', () => {
  it('has S-boxes whose every row is a permutation of 0..15', () => {
    for (const box of DES_SBOXES) {
      expect(box).toHaveLength(64);
      for (let row = 0; row < 4; row++) {
        expect([...box.slice(row * 16, row * 16 + 16)].sort((a, b) => a - b)).toEqual([
          ...Array(16).keys(),
        ]);
      }
    }
  });

  it('matches the classic known answer', () => {
    // Key 133457799BBCDFF1, plaintext 0123456789ABCDEF (FIPS 46 worked example).
    const des = desKey(hex('133457799BBCDFF1'));
    expect(Buffer.from(des.encrypt(hex('0123456789ABCDEF'))).toString('hex')).toBe(
      '85e813540f0ab405',
    );
    expect(Buffer.from(des.decrypt(hex('85E813540F0AB405'))).toString('hex')).toBe(
      '0123456789abcdef',
    );
  });

  it('decrypts what OpenSSL encrypts as DES-EDE3-CBC', () => {
    for (const size of [0, 1, 7, 8, 9, 100, 1200]) {
      const key = randomBytes(24);
      const iv = randomBytes(8);
      const plain = randomBytes(size);
      const c = createCipheriv('des-ede3-cbc', key, iv);
      const encrypted = Buffer.concat([c.update(plain), c.final()]);
      expect(desEde3Cbc.decrypt(key, iv, encrypted).equals(plain)).toBe(true);
      expect(desEde3Cbc.encrypt(key, iv, plain).equals(encrypted)).toBe(true);
    }
  });

  it('refuses bad padding, which is what a wrong password produces', () => {
    const key = randomBytes(24);
    const iv = randomBytes(8);
    const encrypted = desEde3Cbc.encrypt(key, iv, Buffer.from('certificate'));
    const wrongKey = Buffer.from(key);
    wrongKey[0] = wrongKey[0]! ^ 0xfe;
    // A wrong key yields valid-looking padding about once in 256 tries; the
    // PKCS#12 reader checks the MAC before this for that reason.
    let refused = 0;
    for (let i = 0; i < 20; i++) {
      wrongKey[1] = i;
      try {
        desEde3Cbc.decrypt(wrongKey, iv, encrypted);
      } catch (e) {
        expect(e).toBeInstanceOf(PaddingError);
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(15);
  });
});

describe('RC2', () => {
  it('has a PITABLE that is a permutation of 0..255', () => {
    expect(RC2_PITABLE).toHaveLength(256);
    expect(new Set(RC2_PITABLE).size).toBe(256);
  });

  // RFC 2268, section 5.
  it.each([
    ['0000000000000000', 63, '0000000000000000', 'ebb773f993278eff'],
    ['ffffffffffffffff', 64, 'ffffffffffffffff', '278b27e42e2f0d49'],
    ['3000000000000000', 64, '1000000000000001', '30649edf9be7d2c2'],
    ['88', 64, '0000000000000000', '61a8a244adacccf0'],
    ['88bca90e90875a', 64, '0000000000000000', '6ccf4308974c267f'],
    ['88bca90e90875a7f0f79c384627bafb2', 64, '0000000000000000', '1a807d272bbe5db1'],
    ['88bca90e90875a7f0f79c384627bafb2', 128, '0000000000000000', '2269552ab0f85ca6'],
  ])('key %s, %i effective bits', (key, bits, plain, cipher) => {
    const c = rc2(hex(key), bits);
    expect(Buffer.from(c.encrypt(hex(plain))).toString('hex')).toBe(cipher);
    expect(Buffer.from(c.decrypt(hex(cipher))).toString('hex')).toBe(plain);
  });

  it('round-trips CBC with 40-bit keys', () => {
    const key = randomBytes(5);
    const iv = randomBytes(8);
    const plain = randomBytes(333);
    expect(
      rc2Cbc.decrypt(key, 40, iv, rc2Cbc.encrypt(key, 40, iv, plain)).equals(plain),
    ).toBe(true);
  });
});
