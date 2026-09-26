import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { TwilioSmsChannel } from './channels/twilio';
import { RemindersService } from './reminders.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delivery receipts from the SMS provider.
 *
 * Nobody signs in to call this, and no clinic subdomain arrives with it: it is
 * Twilio's servers reporting on a message. So it is excluded from tenant
 * resolution (core/tenancy/tenant-routes.ts) and from the permission guards
 * (the route-coverage allowlist), and it has exactly one boundary instead:
 *
 *   the signature   HMAC over the URL and every parameter, keyed with the
 *                   account's auth token. Checked before anything else is
 *                   read, and a mismatch is a 403.
 *
 * The URL itself — built by this API when the message was sent — names the
 * clinic and the reminder, and the signature covers it. The update then runs
 * as app_user under that clinic's RLS context and must match the provider's
 * message id too, so even a valid signature over a URL naming another clinic
 * reaches nothing there.
 *
 * Answers 204 once the signature is good, whether or not a reminder matched:
 * a receipt for a message this system no longer knows about is not an error
 * the provider can do anything about, and a non-2xx only makes it retry.
 *
 * Not throttled: receipts arrive in bursts from a handful of provider
 * addresses, and a per-IP limit would drop real ones. The signature check is
 * a single HMAC before any database work.
 */
@Controller('reminders/delivery')
export class ReminderDeliveryController {
  constructor(
    private readonly reminders: RemindersService,
    private readonly channel: TwilioSmsChannel,
  ) {}

  @Post('twilio')
  @HttpCode(204)
  @SkipThrottle()
  async twilio(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Query('tenant') tenant?: string,
    @Query('reminder') reminder?: string,
  ): Promise<void> {
    if (!this.channel.receiptsEnabled()) throw new NotFoundException();

    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(body ?? {})) params[key] = String(value);

    if (!this.channel.verifyReceipt(req.originalUrl, params, req.header('x-twilio-signature'))) {
      throw new ForbiddenException('The request signature does not match');
    }

    const messageId = params.MessageSid ?? params.SmsSid;
    const status = params.MessageStatus ?? params.SmsStatus;
    if (!tenant || !reminder || !UUID.test(tenant) || !UUID.test(reminder) || !messageId || !status) {
      return;
    }

    await this.reminders.recordReceipt({
      tenantId: tenant,
      reminderId: reminder,
      providerMessageId: messageId,
      providerStatus: status,
      errorCode: params.ErrorCode || null,
    });
  }
}
