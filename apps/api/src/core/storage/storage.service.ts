import { randomUUID, createHash } from 'node:crypto';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage for patient documents.
 *
 * Three rules shape this class:
 *
 * 1. THE BUCKET IS PRIVATE. Nothing is ever public-read. Downloads go out as
 *    short-lived pre-signed URLs minted per request, after the caller has
 *    passed both the tenant middleware and the permission guard. An X-ray URL
 *    that leaks is useless within minutes and was never guessable.
 *
 * 2. KEYS ARE TENANT-PREFIXED and contain a random UUID. The prefix makes
 *    per-clinic lifecycle rules and exports trivial; the UUID means a key
 *    cannot be enumerated or guessed from a patient's name. Authorization
 *    still comes from the database row (protected by RLS) — the key layout is
 *    hygiene, never the access control.
 *
 * 3. STORAGE IS OPTIONAL. `env.validation` accepts all three S3 settings or
 *    none, and documents this as the way to disable document upload. That
 *    contract has to hold here too: with no bucket configured this service
 *    constructs in a disabled state and the API boots normally. A clinic that
 *    has not set up a bucket yet still gets patients, appointments and
 *    billing; only the documents endpoints answer 503.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string | null;
  private readonly signedUrlTtl: number;

  constructor(private readonly config: ConfigService) {
    this.signedUrlTtl = Number(this.config.get('S3_SIGNED_URL_TTL') ?? 300);

    const bucket = this.config.get<string>('S3_BUCKET');
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('S3_SECRET_ACCESS_KEY');

    // All three or none — env.validation already rejects a partial set, so
    // reaching here with one missing means storage is deliberately off.
    if (!bucket || !accessKeyId || !secretAccessKey) {
      this.bucket = null;
      this.client = null;
      return;
    }

    this.bucket = bucket;
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    this.client = new S3Client({
      region: this.config.get<string>('S3_REGION') ?? 'auto',
      // Set for R2/MinIO/Spaces; omitted for AWS S3 proper.
      ...(endpoint ? { endpoint } : {}),
      // R2 and MinIO address buckets by path, not by virtual host.
      forcePathStyle: this.config.get('S3_FORCE_PATH_STYLE') === '1',
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  /** Whether patient documents are available in this deployment. */
  get isConfigured(): boolean {
    return this.client !== null && this.bucket !== null;
  }

  /**
   * Narrow the optional client for the call sites that genuinely need it.
   * A 503 naming the missing configuration beats a 500 saying "Could not
   * store the file" when the real answer is that no bucket exists.
   */
  private requireStorage(): { client: S3Client; bucket: string } {
    if (!this.client || !this.bucket) {
      throw new ServiceUnavailableException(
        'Document storage is not configured on this server. Set S3_BUCKET, ' +
          'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to enable patient documents.',
      );
    }
    return { client: this.client, bucket: this.bucket };
  }

  /**
   * Prove at boot that the bucket exists and the credentials work. Failing
   * here is loud and immediate; failing on a dentist's first upload is not.
   * Logged rather than thrown so a storage outage cannot take down
   * appointments and billing with it.
   */
  async onModuleInit(): Promise<void> {
    if (!this.client || !this.bucket) {
      this.log.warn(
        'Object storage is not configured — patient document upload and ' +
          'download are disabled. Every other module is unaffected.',
      );
      return;
    }
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.log.log(`Object storage ready (bucket "${this.bucket}")`);
    } catch (err) {
      this.log.error(
        `Object storage unreachable (bucket "${this.bucket}"): ${
          err instanceof Error ? err.message : String(err)
        }. Document upload and download will fail until this is fixed.`,
      );
    }
  }

  /**
   * Build a storage key. Never derived from the uploaded filename — that is
   * attacker-controlled and a path-traversal vector.
   */
  buildKey(tenantId: string, patientId: string, extension: string): string {
    return `tenants/${tenantId}/patients/${patientId}/${randomUUID()}.${extension}`;
  }

  static checksum(body: Buffer): string {
    return createHash('sha256').update(body).digest('hex');
  }

  async put(
    key: string,
    body: Buffer,
    contentType: string,
    meta: Record<string, string> = {},
  ): Promise<void> {
    const { client, bucket } = this.requireStorage();
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // Server-side encryption at rest. Honoured by S3 and R2; harmless
          // where unsupported.
          ServerSideEncryption: 'AES256',
          Metadata: meta,
        }),
      );
    } catch (err) {
      this.log.error(`Upload failed for ${key}: ${String(err)}`);
      throw new InternalServerErrorException('Could not store the file');
    }
  }

  /**
   * A time-limited download URL. `downloadName` drives the browser's save
   * dialog, so the patient gets a sensible filename rather than a UUID.
   */
  async signedDownloadUrl(key: string, downloadName?: string): Promise<string> {
    const { client, bucket } = this.requireStorage();
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(downloadName
        ? {
            ResponseContentDisposition: `attachment; filename="${sanitizeHeaderFilename(
              downloadName,
            )}"`,
          }
        : {}),
    });
    try {
      return await getSignedUrl(client, command, {
        expiresIn: this.signedUrlTtl,
      });
    } catch (err) {
      this.log.error(`Could not sign URL for ${key}: ${String(err)}`);
      throw new InternalServerErrorException('Could not prepare the download');
    }
  }

  /** Inline variant — lets the SPA render an X-ray without a download prompt. */
  async signedViewUrl(key: string): Promise<string> {
    const { client, bucket } = this.requireStorage();
    try {
      return await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: this.signedUrlTtl },
      );
    } catch (err) {
      this.log.error(`Could not sign view URL for ${key}: ${String(err)}`);
      throw new InternalServerErrorException('Could not prepare the preview');
    }
  }

  /**
   * Best-effort removal. The database row is the record of truth; if the
   * object outlives it we have a harmless orphan, whereas throwing here would
   * leave the user staring at an error after the delete already succeeded.
   */
  async remove(key: string): Promise<void> {
    const client = this.client;
    const bucket = this.bucket;
    if (!client || !bucket) return;
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      this.log.warn(
        `Orphaned object — row deleted but ${key} remains in the bucket: ${String(err)}`,
      );
    }
  }

  get urlTtlSeconds(): number {
    return this.signedUrlTtl;
  }
}

/**
 * Strip anything that could break out of the quoted filename in a
 * Content-Disposition header (CR, LF, quotes, backslashes).
 */
function sanitizeHeaderFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, '_').slice(0, 120) || 'download';
}
