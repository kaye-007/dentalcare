import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '@/core/database/database.service';

/**
 * Liveness AND readiness in one endpoint, because everything that consumes it
 * — the compose healthcheck, `npm run doctor`, an uptime probe — wants the
 * same question answered: can this process serve a request that touches data?
 *
 * It used to answer 200 with `status: "degraded"` when the database was
 * unreachable. Every consumer that reads the status code and not the body
 * therefore saw a healthy API: compose would mark the container healthy and
 * start whatever waited on it, and a load balancer would keep routing traffic
 * to a process that could not answer a single real request. Saying "degraded"
 * inside a 200 is not honesty, it is honesty nobody is listening to.
 *
 * The body is unchanged, so `doctor.js` and anything else reading
 * `checks.database` still work. Only the status code became truthful.
 *
 * `passthrough: true` keeps Nest's serialisation and interceptors — this sets
 * the code and still returns an object, rather than taking over the response.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const dbUp = await this.db.ping();

    // The reason a ping failed is in the server log (DatabaseService.ping
    // writes it). It is deliberately not here: this endpoint is reachable
    // without credentials, and a connection error names hosts and roles.
    res.status(dbUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: dbUp ? 'ok' : 'degraded',
      service: 'dentalcare-api',
      checks: {
        database: dbUp ? 'up' : 'down',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
