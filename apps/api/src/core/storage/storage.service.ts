import { randomUUID, createHash } from 'node:crypto';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AwsClient } from 'aws4fetch';

/**
 * Object storage for patient documents.
 *
 * Four rules shape this class:
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
 *
 * 4. SIGNING IS DONE BY HAND, over fetch. This used to be @aws-sdk/client-s3
 *    plus @aws-sdk/s3-request-presigner. Both are large, and a Cloudflare
 *    Worker bundle is capped at 3 MiB compressed on the free plan — the SDK
 *    alone does not leave room for NestJS. aws4fetch is a few kilobytes, signs
 *    SigV4 with WebCrypto, and runs unchanged on Node 20 and on Workers, so
 *    the container image and the Worker share one implementation. The four
 *    operations this application actually performs (PUT, presigned GET,
 *    DELETE, HEAD bucket) are plain REST calls.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);

  private readonly aws: AwsClient | null;
  private readonly bucket: string | null;
  private readonly endpoint: string | null;
  private readonly region: string;
  private readonly pathStyle: boolean;
  private readonly signedUrlTtl: number;

  constructor(private readonly config: ConfigService) {
    this.signedUrlTtl = Number(this.config.get('S3_SIGNED_URL_TTL') ?? 300);
    this.region = this.config.get<string>('S3_REGION') ?? 'auto';
    this.pathStyle = this.config.get('S3_FORCE_PATH_STYLE') === '1';
    this.endpoint = this.config.get<string>('S3_ENDPOINT') ?? null;

    const bucket = this.config.get<string>('S3_BUCKET');
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('S3_SECRET_ACCESS_KEY');

    // All three or none — env.validation already rejects a partial set, so
    // reaching here with one missing means storage is deliberately off.
    if (!bucket || !accessKeyId || !secretAccessKey) {
      this.bucket = null;
      this.aws = null;
      return;
    }

    this.bucket = bucket;
    this.aws = new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: 's3',
      region: this.region,
    });
  }

  /** Whether patient documents are available in this deployment. */
  get isConfigured(): boolean {
    return this.aws !== null && this.bucket !== null;
  }

  /**
   * Narrow the optional client for the call sites that genuinely need it.
   * A 503 naming the missing configuration beats a 500 saying "Could not
   * store the file" when the real answer is that no bucket exists.
   */
  private requireStorage(): { aws: AwsClient; bucket: string } {
    if (!this.aws || !this.bucket) {
      throw new ServiceUnavailableException(
        'Document storage is not configured on this server. Set S3_BUCKET, ' +
          'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to enable patient documents.',
      );
    }
    return { aws: this.aws, bucket: this.bucket };
  }

  /**
   * The REST URL for one object.
   *
   * Path style (`S3_FORCE_PATH_STYLE=1`) puts the bucket in the path, which is
   * what R2 and MinIO want; virtual-host style puts it in the hostname, which
   * is what AWS S3 wants. Each path segment is encoded separately so the
   * slashes in a key survive while everything else is escaped.
   */
  private objectUrl(bucket: string, key = ''): string {
    const encoded = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    if (this.endpoint) {
      const base = this.endpoint.replace(/\/+$/, '');
      if (this.pathStyle) return `${base}/${bucket}/${encoded}`;
      const url = new URL(base);
      url.hostname = `${bucket}.${url.hostname}`;
      return `${url.origin}/${encoded}`;
    }

    return this.pathStyle
      ? `https://s3.${this.region}.amazonaws.com/${bucket}/${encoded}`
      : `https://${bucket}.s3.${this.region}.amazonaws.com/${encoded}`;
  }

  /**
   * Prove at boot that the bucket exists and the credentials work. Failing
   * here is loud and immediate; failing on a dentist's first upload is not.
   * Logged rather than thrown so a storage outage cannot take down
   * appointments and billing with it.
   */
  async onModuleInit(): Promise<void> {
    if (!this.aws || !this.bucket) {
      this.log.warn(
        'Object storage is not configured — patient document upload and ' +
          'download are disabled. Every other module is unaffected.',
      );
      return;
    }
    try {
      const res = await this.aws.fetch(this.objectUrl(this.bucket), {
        method: 'HEAD',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

  /**
   * A key for a clinic's own branding (the logo). Same prefix discipline as
   * patient files, so a per-clinic export or lifecycle rule still covers it.
   */
  buildBrandingKey(tenantId: string, extension: string): string {
    return `tenants/${tenantId}/branding/logo-${randomUUID()}.${extension}`;
  }

  /**
   * Read an object back. Used server-side only — embedding the logo in an
   * invoice PDF — and never to proxy a patient file to a browser, which gets
   * a signed URL instead. Null when the object is gone.
   */
  async get(key: string, maxBytes = 5 * 1024 * 1024): Promise<Uint8Array | null> {
    const { aws, bucket } = this.requireStorage();
    try {
      const res = await aws.fetch(this.objectUrl(bucket, key), { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > maxBytes) throw new Error(`object is ${body.byteLength} bytes`);
      return body;
    } catch (err) {
      this.log.warn(`Could not read ${key}: ${String(err)}`);
      return null;
    }
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
    const { aws, bucket } = this.requireStorage();
    const headers: Record<string, string> = {
      'content-type': contentType,
      // Server-side encryption at rest. Honoured by S3 and R2; harmless
      // where unsupported.
      'x-amz-server-side-encryption': 'AES256',
    };
    // Header values must be ASCII. Percent-encoding keeps an Albanian
    // filename or caption from producing an unsendable request.
    for (const [name, value] of Object.entries(meta)) {
      headers[`x-amz-meta-${name.toLowerCase()}`] = encodeURIComponent(value);
    }

    try {
      const res = await aws.fetch(this.objectUrl(bucket, key), {
        method: 'PUT',
        body: new Uint8Array(body),
        headers,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${await safeBody(res)}`);
      }
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
    return this.presign(
      key,
      downloadName
        ? {
            'response-content-disposition': `attachment; filename="${sanitizeHeaderFilename(
              downloadName,
            )}"`,
          }
        : {},
      'Could not prepare the download',
    );
  }

  /** Inline variant — lets the SPA render an X-ray without a download prompt. */
  async signedViewUrl(key: string): Promise<string> {
    return this.presign(key, {}, 'Could not prepare the preview');
  }

  /**
   * Mint a query-signed GET URL valid for S3_SIGNED_URL_TTL seconds.
   *
   * The response-* parameters are part of the signed query string, so a
   * recipient cannot alter the disposition or the content type of what they
   * are served by editing the link.
   */
  private async presign(
    key: string,
    query: Record<string, string>,
    failureMessage: string,
  ): Promise<string> {
    const { aws, bucket } = this.requireStorage();
    try {
      const url = new URL(this.objectUrl(bucket, key));
      url.searchParams.set('X-Amz-Expires', String(this.signedUrlTtl));
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.set(name, value);
      }
      const signed = await aws.sign(url.toString(), {
        method: 'GET',
        aws: { signQuery: true },
      });
      return signed.url;
    } catch (err) {
      this.log.error(`Could not sign URL for ${key}: ${String(err)}`);
      throw new InternalServerErrorException(failureMessage);
    }
  }

  /**
   * Best-effort removal. The database row is the record of truth; if the
   * object outlives it we have a harmless orphan, whereas throwing here would
   * leave the user staring at an error after the delete already succeeded.
   */
  async remove(key: string): Promise<void> {
    if (!this.aws || !this.bucket) return;
    try {
      const res = await this.aws.fetch(this.objectUrl(this.bucket, key), {
        method: 'DELETE',
      });
      // S3 answers 204 for a delete, and 404 for an object that was already
      // gone — both mean the bucket no longer holds it.
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
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

/** S3 explains its refusals in the body; read it, but never fail on reading. */
async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
