import { Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { StorageService } from './storage.service';

/**
 * Downloads for files kept on this server's disk (StorageService, local
 * backend) — the stand-in for an S3 pre-signed URL.
 *
 * There is no login check here, on purpose, exactly as there is none on a
 * pre-signed S3 link: the link itself is the permission. It is minted only by
 * an endpoint that has already passed the tenant middleware, the JWT guard and
 * the permission guard, it names one file, and it expires after
 * S3_SIGNED_URL_TTL seconds. A forged, altered or expired link answers 404 —
 * never "forbidden", which would confirm that the file exists.
 */
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Get('*key')
  async serve(
    @Param('key') keyParam: string | string[],
    @Query('e') exp: string,
    @Query('s') sig: string,
    @Query('d') disposition: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const key = Array.isArray(keyParam) ? keyParam.join('/') : keyParam;
    const file =
      key && exp && sig
        ? await this.storage.openSigned(key, exp, sig, disposition ?? '')
        : null;
    if (!file) throw new NotFoundException('This link has expired or is not valid.');

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Private to this browser, and no longer than the link itself lives.
    res.setHeader('Cache-Control', `private, max-age=${this.storage.urlTtlSeconds}`);
    res.setHeader('Content-Disposition', file.disposition || 'inline');
    res.end(file.body);
  }
}
