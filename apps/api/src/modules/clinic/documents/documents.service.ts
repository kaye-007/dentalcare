import { DocumentKind } from './documents.types';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { StorageService } from '@/core/storage/storage.service';
import {
  ALLOWED_TYPES_LABEL,
  EXTENSION_FOR,
  detectFileType,
  isAllowedType,
} from '@/core/storage/file-signature';
import { ClinicAuditService, ClinicAuditActor } from '@/core/audit/clinic-audit.service';
import { PatientAccessActor, PatientAccessService } from '@/core/audit/patient-access';
import { PhotoTag, UpdateDocumentDto, UploadDocumentDto } from './dto/documents.dto';

/* ═════════════════════════ service ═════════════════════════ */

interface DocumentRow {
  id: string;
  patient_id: string;
  storage_key: string;
  file_name: string;
  content_type: string;
  byte_size: string;
  checksum: string;
  kind: DocumentKind;
  tooth: number | null;
  taken_on: string | null;
  caption: string | null;
  photo_tag: PhotoTag | null;
  uploaded_by_name: string | null;
  created_at: string;
}

const SELECT = `
  SELECT d.id, d.patient_id, d.storage_key, d.file_name, d.content_type,
         d.byte_size, d.checksum, d.kind, d.tooth, d.taken_on, d.caption, d.photo_tag,
         u.full_name AS uploaded_by_name, d.created_at
    FROM patient_documents d
    LEFT JOIN users u ON u.id = d.uploaded_by`;

const RETURNING = `RETURNING id, patient_id, storage_key, file_name, content_type,
                   byte_size, checksum, kind, tooth, taken_on, caption, photo_tag,
                   NULL::text AS uploaded_by_name, created_at`;

/** Images a browser can draw, and so the only ones worth a thumbnail. */
const PREVIEWABLE = ['image/jpeg', 'image/png', 'image/webp'];

/** A profile picture is cropped and re-encoded in the browser; it is small. */
const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;

@Injectable()
export class DocumentsService {
  private readonly maxBytes: number;
  private readonly storageConfigured: boolean;

  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly storage: StorageService,
    private readonly access: PatientAccessService,
    config: ConfigService,
  ) {
    this.maxBytes = Number(config.get('MAX_UPLOAD_BYTES') ?? 40 * 1024 * 1024);
    this.storageConfigured = Boolean(config.get('S3_BUCKET'));
  }

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /**
   * Documents are the one feature that needs a service the rest of the app
   * does not. Say so plainly instead of failing deep inside an upload.
   */
  private assertStorage() {
    if (!this.storageConfigured) {
      throw new ServiceUnavailableException(
        'Document storage is not configured on this server. Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
      );
    }
  }

  async list(patientId: string, kind?: DocumentKind) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM patients WHERE id = $1', [
        patientId,
      ]);
      if (!rowCount) throw new NotFoundException('Patient not found');

      const params: unknown[] = [patientId];
      let filter = '';
      if (kind) {
        params.push(kind);
        filter = ` AND d.kind = $${params.length}`;
      }
      const { rows } = await client.query<DocumentRow>(
        `${SELECT}
          WHERE d.patient_id = $1 AND d.deleted_at IS NULL${filter}
          ORDER BY d.taken_on DESC NULLS LAST, d.created_at DESC`,
        params,
      );
      return rows.map(mapDocument);
    });
  }

  async upload(
    patientId: string,
    file: Express.Multer.File | undefined,
    dto: UploadDocumentDto,
    userId: string,
  ) {
    this.assertStorage();
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('No file was uploaded');
    }
    if (file.size > this.maxBytes) {
      throw new BadRequestException(
        `File is too large (${formatBytes(file.size)}). The limit is ${formatBytes(this.maxBytes)}.`,
      );
    }

    // The claimed Content-Type is ignored — only the real header is trusted.
    const detected = detectFileType(file.buffer);
    if (!isAllowedType(detected)) {
      throw new BadRequestException(
        `That file type is not accepted. Allowed formats: ${ALLOWED_TYPES_LABEL}.`,
      );
    }
    const kind = dto.kind ?? (detected.startsWith('image/') && detected !== 'image/tiff' ? 'photo' : 'other');
    if (dto.photoTag && kind !== 'photo') {
      throw new BadRequestException('Before, after and progress apply to photos only');
    }

    const tenantId = this.tenant.getRequiredTenantId();
    const checksum = StorageService.checksum(file.buffer);
    const key = this.storage.buildKey(tenantId, patientId, EXTENSION_FOR[detected]);

    return this.db.withTenant(tenantId, async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM patients WHERE id = $1', [
        patientId,
      ]);
      if (!rowCount) throw new NotFoundException('Patient not found');

      // Re-uploading an identical file is a double-click, not a new document.
      const { rows: dupe } = await client.query<DocumentRow>(
        `${SELECT}
          WHERE d.patient_id = $1 AND d.checksum = $2 AND d.deleted_at IS NULL
          LIMIT 1`,
        [patientId, checksum],
      );
      // Object.assign, not a spread: a spread copies enumerable properties
      // only, so it dropped the storage key and every profile photo failed
      // when setProfilePhoto signed a link for `undefined`.
      if (dupe[0]) return Object.assign(mapDocument(dupe[0]), { duplicate: true as const });

      // Object first: a stored object with no row is a recoverable orphan,
      // whereas a row with no object is a broken download for the clinician.
      await this.storage.put(key, file.buffer, detected, {
        tenant: tenantId,
        patient: patientId,
      });

      try {
        const { rows } = await client.query<DocumentRow>(
          `INSERT INTO patient_documents
             (tenant_id, patient_id, storage_key, file_name, content_type,
              byte_size, checksum, kind, tooth, taken_on, caption, uploaded_by, photo_tag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ${RETURNING}`,
          [
            tenantId,
            patientId,
            key,
            safeFileName(file.originalname),
            detected,
            file.size,
            checksum,
            kind,
            dto.tooth ?? null,
            dto.takenOn || null,
            dto.caption ?? null,
            userId,
            dto.photoTag ?? null,
          ],
        );
        return Object.assign(mapDocument(rows[0]), { duplicate: false as const });
      } catch (err) {
        // Do not leave a paid-for object behind if the row could not be written.
        await this.storage.remove(key);
        throw err;
      }
    });
  }

  /**
   * Signed URL for viewing inline (X-ray preview) or downloading.
   *
   * Minting the URL is the moment the file is opened, so it is the moment the
   * record-access log is written — before the URL exists, so a link that was
   * handed out is a link that was recorded.
   */
  async link(id: string, disposition: 'inline' | 'attachment', actor: PatientAccessActor) {
    this.assertStorage();
    const tenantId = this.tenant.getRequiredTenantId();
    return this.tx(async (client) => {
      const { rows } = await client.query<DocumentRow>(
        `${SELECT} WHERE d.id = $1 AND d.deleted_at IS NULL`,
        [id],
      );
      const doc = rows[0];
      if (!doc) throw new NotFoundException('Document not found');

      await this.access.record(tenantId, doc.patient_id, 'document_file', actor);

      const url =
        disposition === 'attachment'
          ? await this.storage.signedDownloadUrl(doc.storage_key, doc.file_name)
          : await this.storage.signedViewUrl(doc.storage_key);

      return {
        url,
        fileName: doc.file_name,
        contentType: doc.content_type,
        expiresInSeconds: this.storage.urlTtlSeconds,
      };
    });
  }

  async update(id: string, dto: UpdateDocumentDto) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.kind !== undefined) push('kind', dto.kind);
    if (dto.tooth !== undefined) push('tooth', dto.tooth ?? null);
    if (dto.takenOn !== undefined) push('taken_on', dto.takenOn || null);
    if (dto.caption !== undefined) push('caption', dto.caption || null);
    if (dto.photoTag !== undefined) push('photo_tag', dto.photoTag ?? null);
    // A document moved out of 'photo' loses its tag in the same statement,
    // which the 0009 constraint would otherwise refuse.
    if (dto.kind !== undefined && dto.kind !== 'photo' && dto.photoTag === undefined) {
      sets.push('photo_tag = NULL');
    }
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      const { rows } = await client
        .query<DocumentRow>(
          `UPDATE patient_documents SET ${sets.join(', ')}
            WHERE id = $1 AND deleted_at IS NULL
            ${RETURNING}`,
          params,
        )
        .catch((err: { code?: string }) => {
          if (err.code === '23514') {
            throw new BadRequestException('Before, after and progress apply to photos only');
          }
          throw err;
        });
      if (!rows[0]) throw new NotFoundException('Document not found');
      return mapDocument(rows[0]);
    });
  }

  /**
   * Short-lived view links for the image documents of one patient, so the
   * list can show thumbnails. One access-log entry for the lot: opening the
   * documents tab is one look at the record, however many pictures it shows.
   */
  async thumbnails(patientId: string, actor: PatientAccessActor) {
    this.assertStorage();
    const tenantId = this.tenant.getRequiredTenantId();
    const docs = await this.tx(async (client) => {
      const { rows } = await client.query<{ id: string; storage_key: string }>(
        `SELECT id, storage_key FROM patient_documents
          WHERE patient_id = $1 AND deleted_at IS NULL AND content_type = ANY($2::text[])
          ORDER BY created_at DESC LIMIT 60`,
        [patientId, PREVIEWABLE],
      );
      return rows;
    });
    if (docs.length === 0) return [];
    await this.access.record(tenantId, patientId, 'document_file', actor);
    return Promise.all(
      docs.map(async (d) => ({ id: d.id, url: await this.storage.signedViewUrl(d.storage_key) })),
    );
  }

  /**
   * Set a patient's profile picture: stored as a patient document like any
   * other photo, and pointed at from the patient record. The browser crops and
   * re-encodes it first, which also strips the camera's EXIF data — a phone
   * photo's GPS position has no business in a clinic's bucket.
   */
  async setProfilePhoto(
    patientId: string,
    file: Express.Multer.File | undefined,
    actor: ClinicAuditActor,
  ) {
    if (file && file.size > MAX_PROFILE_PHOTO_BYTES) {
      throw new BadRequestException('A profile photo must be under 5 MB');
    }
    if (file && !PREVIEWABLE.includes(detectFileType(file.buffer) ?? '')) {
      throw new BadRequestException('A profile photo must be a JPEG, PNG or WEBP image');
    }
    const doc = await this.upload(
      patientId,
      file,
      { kind: 'photo', caption: 'Profile photo' },
      actor.userId,
    );
    return this.tx(async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `UPDATE patients SET photo_document_id = $2, updated_at = now()
          WHERE id = $1 RETURNING first_name || ' ' || last_name AS name`,
        [patientId, doc.id],
      );
      if (!rows[0]) throw new NotFoundException('Patient not found');
      await this.audit.record(client, actor, {
        action: 'patient.photo_changed',
        entityType: 'patient',
        entityId: patientId,
        summary: `Changed ${rows[0].name}'s profile photo`,
        metadata: { documentId: doc.id },
      });
      return { photoDocumentId: doc.id, photoUrl: await this.storage.signedViewUrl(doc.storageKey) };
    });
  }

  /** The picture stays in the patient's documents; it just stops being the profile photo. */
  async clearProfilePhoto(patientId: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `UPDATE patients SET photo_document_id = NULL, updated_at = now()
          WHERE id = $1 RETURNING first_name || ' ' || last_name AS name`,
        [patientId],
      );
      if (!rows[0]) throw new NotFoundException('Patient not found');
      await this.audit.record(client, actor, {
        action: 'patient.photo_changed',
        entityType: 'patient',
        entityId: patientId,
        summary: `Removed ${rows[0].name}'s profile photo`,
      });
      return { photoDocumentId: null, photoUrl: null };
    });
  }

  /**
   * Soft delete, then remove the object. The row is retained as evidence that
   * the document existed and who removed it — a deleted radiograph is exactly
   * the thing an audit later asks about.
   */
  async remove(id: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      // This returned a `title` column the table has never had, so every delete
      // failed with a 500 before anything was removed.
      const { rows } = await client.query<{
        storage_key: string;
        file_name: string;
        kind: string;
        patient_id: string;
      }>(
        `UPDATE patient_documents
            SET deleted_at = now(), deleted_by = $2
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING storage_key, file_name, kind, patient_id`,
        [id, actor.userId],
      );
      if (!rows[0]) throw new NotFoundException('Document not found');
      // A deleted picture cannot stay the face on the patient's record.
      await client.query(
        'UPDATE patients SET photo_document_id = NULL WHERE photo_document_id = $1',
        [id],
      );
      // The audit row is written before the bytes go, and in the same
      // transaction as the soft delete: object storage has no rollback, so if
      // anything here fails the record must not already be gone.
      await this.audit.record(client, actor, {
        action: 'document.deleted',
        entityType: 'patient_document',
        entityId: id,
        summary: `Deleted ${rows[0].kind} "${rows[0].file_name}"`,
        metadata: { kind: rows[0].kind, patientId: rows[0].patient_id },
      });
      await this.storage.remove(rows[0].storage_key);
      return { deleted: true as const };
    });
  }

  /** Counts for the profile header, without shipping every row. */
  async countsFor(patientId: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<{ kind: DocumentKind; count: string }>(
        `SELECT kind, count(*)::text AS count
           FROM patient_documents
          WHERE patient_id = $1 AND deleted_at IS NULL
          GROUP BY kind`,
        [patientId],
      );
      const byKind = Object.fromEntries(
        rows.map((r) => [r.kind, Number(r.count)]),
      ) as Record<DocumentKind, number>;
      return {
        total: rows.reduce((sum, r) => sum + Number(r.count), 0),
        byKind,
      };
    });
  }
}

/** Keep a recognisable name for downloads; never used to build a storage key. */
function safeFileName(original: string | undefined): string {
  const base = (original ?? 'document').split(/[\\/]/).pop() ?? 'document';
  // Control characters are the point: a filename arrives from a client and
  // ends up in a Content-Disposition header, where a raw newline is header
  // injection. Stripping them is the fix, not an oversight.
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return (cleaned || 'document').slice(0, 200);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/**
 * The API shape of a document. `storageKey` is attached non-enumerable: the
 * service needs it to sign a link, and JSON.stringify — which DOES serialise
 * an ordinary getter — must never put a bucket key in a response.
 */
const mapDocument = (r: DocumentRow) =>
  Object.defineProperty(documentFields(r), 'storageKey', { value: r.storage_key, enumerable: false }) as
    ReturnType<typeof documentFields> & { readonly storageKey: string };

const documentFields = (r: DocumentRow) => ({
  id: r.id,
  patientId: r.patient_id,
  fileName: r.file_name,
  contentType: r.content_type,
  // bigint arrives as a string; the API contract is a number.
  byteSize: Number(r.byte_size),
  checksum: r.checksum,
  kind: r.kind,
  tooth: r.tooth,
  takenOn: r.taken_on,
  caption: r.caption,
  photoTag: r.photo_tag,
  uploadedByName: r.uploaded_by_name,
  createdAt: r.created_at,
  isImage: r.content_type.startsWith('image/'),
  /** A browser can draw it: TIFF and DICOM are images it cannot. */
  isPreviewable: PREVIEWABLE.includes(r.content_type),
});

/* ═══════════════════════ controllers ═══════════════════════ */

/**
 * Multer keeps the file in memory: it is validated by magic bytes and streamed
 * straight to object storage, so it never touches the container's disk — which
 * on Render is ephemeral anyway. The limit is a hard stop enforced by multer
 * before the buffer is fully read, in addition to the service-level check.
 */
export const uploadOptions = {
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 40 * 1024 * 1024),
    files: 1,
  },
};
