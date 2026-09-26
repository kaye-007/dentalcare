import { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '@/core/database/database.service';
import type { TenantContextService } from '@/core/tenancy/tenant-context';
import type { StorageService } from '@/core/storage/storage.service';
import type {
  ClinicAuditActor,
  ClinicAuditService,
} from '@/core/audit/clinic-audit.service';
import type { PatientAccessService } from '@/core/audit/patient-access';
import { DocumentsService } from './documents.service';

/**
 * The profile photo path, which failed for every upload: `upload()` returned a
 * spread of the document, the spread dropped the non-enumerable storage key,
 * and `setProfilePhoto` then signed a link for `undefined` — after the file had
 * been stored, so staff saw an error and a stray photo in Documents.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';

// A JPEG header is all the magic-byte check needs.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function file(buffer = JPEG): Express.Multer.File {
  return {
    buffer,
    size: buffer.length,
    originalname: 'profile.jpg',
  } as Express.Multer.File;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    patient_id: PATIENT,
    storage_key: `tenants/${TENANT}/patients/${PATIENT}/abc.jpg`,
    file_name: 'profile.jpg',
    content_type: 'image/jpeg',
    byte_size: String(JPEG.length),
    checksum: 'x',
    kind: 'photo',
    tooth: null,
    taken_on: null,
    caption: 'Profile photo',
    photo_tag: null,
    uploaded_by_name: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function build({ duplicate }: { duplicate: boolean }) {
  const query = jest.fn(async (sql: string) => {
    if (sql.startsWith('SELECT 1 FROM patients')) return { rowCount: 1, rows: [{}] };
    if (sql.includes('d.checksum = $2')) return { rows: duplicate ? [row()] : [] };
    if (sql.includes('INSERT INTO patient_documents')) return { rows: [row()] };
    if (sql.includes('UPDATE patients SET photo_document_id'))
      return { rows: [{ name: 'Ana Hoxha' }] };
    return { rows: [] };
  });
  const db = {
    withTenant: (_t: string, fn: (c: unknown) => unknown) => fn({ query }),
  } as unknown as DatabaseService;
  const tenant = { getRequiredTenantId: () => TENANT } as unknown as TenantContextService;
  const storage = {
    put: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    buildKey: () => `tenants/${TENANT}/patients/${PATIENT}/abc.jpg`,
    signedViewUrl: jest.fn(async (key: string) => {
      if (typeof key !== 'string') throw new Error('Could not prepare the preview');
      return `https://bucket.example/${key}?sig=1`;
    }),
  } as unknown as StorageService & { signedViewUrl: jest.Mock };
  const audit = {
    record: jest.fn(async () => undefined),
  } as unknown as ClinicAuditService;
  const access = {} as PatientAccessService;
  const config = new ConfigService({ S3_BUCKET: 'bucket' });
  const service = new DocumentsService(db, tenant, audit, storage, access, config);
  return { service, storage };
}

const actor: ClinicAuditActor = {
  userId: '33333333-3333-4333-8333-333333333333',
  label: 'reception@clinic.al',
  role: 'receptionist',
};

describe('DocumentsService profile photo', () => {
  it.each([false, true])(
    'signs the stored key (duplicate upload: %s)',
    async (duplicate) => {
      const { service, storage } = build({ duplicate });
      const out = await service.setProfilePhoto(PATIENT, file(), actor);
      expect(storage.signedViewUrl).toHaveBeenCalledWith(
        `tenants/${TENANT}/patients/${PATIENT}/abc.jpg`,
      );
      expect(out.photoUrl).toContain('sig=1');
      expect(out.photoDocumentId).toBe('doc-1');
    },
  );

  it('keeps the storage key out of serialised output', async () => {
    const { service } = build({ duplicate: false });
    const doc = await service.upload(PATIENT, file(), { kind: 'photo' }, actor.userId);
    expect(doc.storageKey).toContain('abc.jpg');
    expect(JSON.stringify(doc)).not.toContain('storageKey');
  });

  it('refuses a profile photo that is not JPEG, PNG or WEBP', async () => {
    const { service } = build({ duplicate: false });
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(32)]);
    await expect(service.setProfilePhoto(PATIENT, file(pdf), actor)).rejects.toThrow(
      /JPEG, PNG or WEBP/,
    );
  });
});
