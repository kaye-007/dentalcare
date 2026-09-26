import { ConfigService } from '@nestjs/config';
import {
  TwilioWhatsAppChannel,
  contentSidFor,
  contentVariables,
  parseContentSids,
} from './whatsapp';
import { composeMessage } from '../messages.service';

const SID = (n: number) => `HX${String(n).padStart(32, '0')}`;

describe('WhatsApp content templates', () => {
  it('reads a bare language as the appointment reminder, as configured before 0012', () => {
    const sids = parseContentSids(`en:${SID(1)}, sq:${SID(2)}`);
    expect(contentSidFor(sids, 'appointment_reminder', 'sq')).toBe(SID(2));
    expect(contentSidFor(sids, 'post_procedure_followup', 'sq')).toBeNull();
  });

  it('finds each kind of message in its language, then English', () => {
    const sids = parseContentSids(
      `sq:${SID(1)},followup.sq:${SID(2)},balance.en:${SID(3)},nonsense:HX12`,
    );
    expect(contentSidFor(sids, 'post_procedure_followup', 'sq')).toBe(SID(2));
    expect(contentSidFor(sids, 'unpaid_balance', 'sq')).toBe(SID(3));
    expect(sids.size).toBe(3);
  });

  it('offers over WhatsApp only the kinds that have a template', () => {
    const channel = new TwilioWhatsAppChannel(
      new ConfigService({
        WHATSAPP_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_WHATSAPP_FROM: '+355691234567',
        TWILIO_WHATSAPP_CONTENT_SIDS: `sq:${SID(1)},balance.sq:${SID(2)}`,
      }),
    );
    expect(channel.supportedPurposes()).toEqual([
      'appointment_reminder',
      'unpaid_balance',
    ]);
  });

  it('fills variables for the kind of message, and treats rows without a purpose as reminders', () => {
    expect(
      JSON.parse(
        contentVariables({
          locale: 'sq',
          first_name: 'Ana',
          date: 'e martë',
          time: '10:30',
          dentist: '',
          clinic: 'Klinika',
        }),
      ),
    ).toEqual({ 1: 'Ana', 2: 'e martë', 3: '10:30', 4: '—', 5: 'Klinika' });
    expect(
      JSON.parse(
        contentVariables({
          locale: 'sq',
          purpose: 'unpaid_balance',
          first_name: 'Ana',
          clinic: 'Klinika',
          balance: '5 000 Lekë',
          clinic_phone: '+355 4 222 3333',
        }),
      ),
    ).toEqual({ 1: 'Ana', 2: '5 000 Lekë', 3: 'Klinika', 4: '+355 4 222 3333' });
  });
});

describe('composeMessage', () => {
  const ctx = {
    locale: 'sq' as const,
    phone: '+355 4 222 3333',
    template: 'Kujtesë {first_name}: {date} {time}.',
  };
  const values = {
    first_name: 'Ana',
    clinic: 'Klinika',
    date: 'e martë',
    time: '10:30',
    clinic_phone: '+355 4 222 3333',
  };

  it("uses the clinic's own reminder wording on free-text channels", () => {
    expect(
      composeMessage('appointment_reminder', ctx, values, { templateChannel: false }),
    ).toBe('Kujtesë Ana: e martë 10:30.');
  });

  it('uses the built-in wording where WhatsApp needs the approved template', () => {
    expect(
      composeMessage('appointment_reminder', ctx, values, { templateChannel: true }),
    ).toMatch(/^Përshëndetje Ana, ju kujtojmë/);
  });

  it('never applies the reminder wording to another kind of message', () => {
    expect(
      composeMessage(
        'unpaid_balance',
        ctx,
        { ...values, balance: '5 000 Lekë' },
        { templateChannel: false },
      ),
    ).toMatch(/detyrim i papaguar prej 5 000 Lekë/);
  });
});
