import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

const TENANT = '11111111-2222-4333-8444-555555555555';
const PATIENT = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function make(env: Record<string, string>) {
  return new StorageService(new ConfigService(env));
}

/** Pull the path and query out of a relative signed link. */
function parse(url: string) {
  const u = new URL(url, 'http://x');
  const key = decodeURIComponent(u.pathname.replace(/^\/api\/files\//, ''));
  return {
    key,
    e: u.searchParams.get('e')!,
    s: u.searchParams.get('s')!,
    d: u.searchParams.get('d') ?? '',
  };
}

describe('StorageService — local disk backend', () => {
  let dir: string;
  let storage: StorageService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-storage-'));
    storage = make({ STORAGE_DIR: dir, JWT_SECRET: 'test-secret-that-is-long-enough' });
    await storage.onModuleInit();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is used when no bucket is configured', () => {
    expect(storage.isConfigured).toBe(true);
    expect(storage.driver).toBe('local');
  });

  it('can be switched off', () => {
    const off = make({
      STORAGE_DRIVER: 'off',
      STORAGE_DIR: dir,
      JWT_SECRET: 'x'.repeat(20),
    });
    expect(off.isConfigured).toBe(false);
    expect(off.driver).toBe('off');
  });

  it('stores, reads back and removes a file', async () => {
    const key = storage.buildKey(TENANT, PATIENT, 'png');
    await storage.put(key, Buffer.from('hello'), 'image/png');
    expect(Buffer.from((await storage.get(key))!).toString()).toBe('hello');

    await storage.remove(key);
    expect(await storage.get(key)).toBeNull();
    expect(existsSync(join(dir, key))).toBe(false);
  });

  it('serves a file through its signed link, with its content type and disposition', async () => {
    const key = storage.buildKey(TENANT, PATIENT, 'pdf');
    await storage.put(key, Buffer.from('%PDF-1.7'), 'application/pdf');

    const view = parse(await storage.signedViewUrl(key));
    expect(view.key).toBe(key);
    const opened = await storage.openSigned(view.key, view.e, view.s, view.d);
    expect(opened?.contentType).toBe('application/pdf');
    expect(opened?.body.toString()).toBe('%PDF-1.7');

    const dl = parse(await storage.signedDownloadUrl(key, 'Scan "1".pdf'));
    const asDownload = await storage.openSigned(dl.key, dl.e, dl.s, dl.d);
    expect(asDownload?.disposition).toBe('attachment; filename="Scan _1_.pdf"');
  });

  it('refuses an altered link', async () => {
    const key = storage.buildKey(TENANT, PATIENT, 'png');
    await storage.put(key, Buffer.from('x'), 'image/png');
    const link = parse(await storage.signedViewUrl(key));

    const other = storage.buildKey(TENANT, PATIENT, 'png');
    await storage.put(other, Buffer.from('y'), 'image/png');

    expect(await storage.openSigned(other, link.e, link.s, link.d)).toBeNull(); // another file
    expect(
      await storage.openSigned(key, String(Number(link.e) + 60), link.s, link.d),
    ).toBeNull(); // longer life
    expect(await storage.openSigned(key, link.e, link.s, 'attachment')).toBeNull(); // changed disposition
    expect(await storage.openSigned(key, link.e, 'forged', link.d)).toBeNull();
  });

  it('refuses an expired link', async () => {
    const key = storage.buildKey(TENANT, PATIENT, 'png');
    await storage.put(key, Buffer.from('x'), 'image/png');
    const link = parse(await storage.signedViewUrl(key));
    const realNow = Date.now;
    Date.now = () => realNow() + 3_600_000;
    try {
      expect(await storage.openSigned(key, link.e, link.s, link.d)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('never reads outside its folder', async () => {
    const e = String(Math.floor(Date.now() / 1000) + 60);
    for (const key of [
      '../../etc/passwd',
      `tenants/${TENANT}/../../outside.txt`,
      'not-a-tenant/file.png',
    ]) {
      expect(await storage.openSigned(key, e, 'anything', '')).toBeNull();
      await expect(storage.put(key, Buffer.from('x'), 'text/plain')).rejects.toThrow();
    }
  });
});
