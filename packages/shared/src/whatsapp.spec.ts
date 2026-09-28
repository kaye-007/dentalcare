import {
  WHATSAPP_DEFAULT_PREVIEWS,
  formatReminderWhen,
  renderWhatsAppPreview,
  templateVariables,
  unknownWhatsAppVariables,
  whatsAppExclusion,
  whatsAppRecipient,
  whatsAppReminderValues,
} from './whatsapp';

describe('WhatsApp reminder text', () => {
  // 07:00 UTC on 27 September is 09:00 in Tirana (summer time).
  const startsAt = new Date('2026-09-27T07:00:00Z');

  it('writes the date in Albanian or English, in the clinic zone', () => {
    expect(formatReminderWhen(startsAt, 'Europe/Tirane', 'sq')).toEqual({
      date: '27 shtator',
      time: '09:00',
    });
    expect(formatReminderWhen(startsAt, 'Europe/Tirane', 'en_US')).toEqual({
      date: '27 September',
      time: '09:00',
    });
  });

  it('crosses midnight by the clinic zone, not the server', () => {
    // 23:30 UTC on 30 Sept is 01:30 on 1 October in Tirana.
    expect(
      formatReminderWhen(new Date('2026-09-30T23:30:00Z'), 'Europe/Tirane', 'sq'),
    ).toEqual({
      date: '1 tetor',
      time: '01:30',
    });
  });

  it('renders the default Albanian reminder as the spec example reads', () => {
    const values = whatsAppReminderValues({
      patientFirstName: ' Ardit ',
      clinicName: 'Dental Clinic Tirana',
      clinicPhone: null,
      startsAt,
      timeZone: 'Europe/Tirane',
      languageCode: 'sq',
    });
    expect(renderWhatsAppPreview(WHATSAPP_DEFAULT_PREVIEWS.sq, values)).toBe(
      'Përshëndetje Ardit, kjo është një kujtesë nga Dental Clinic Tirana. Ju keni një takim nesër, më 27 shtator, ' +
        'në orën 09:00. Ju lutemi na kontaktoni nëse dëshironi të bëni ndryshime.',
    );
  });

  it('lists variables once, in order, and flags ones it cannot fill', () => {
    expect(
      templateVariables('{{ patient_name }} {{clinic_name}} {{patient_name}}'),
    ).toEqual(['patient_name', 'clinic_name']);
    expect(unknownWhatsAppVariables('Hi {{patient_name}}, you owe {{balance}}')).toEqual([
      'balance',
    ]);
    expect(renderWhatsAppPreview('{{balance}}', {})).toBe('{{balance}}');
  });
});

describe('who can be reminded', () => {
  const ok = {
    appointmentStatus: 'scheduled',
    optedOut: false,
    optIn: true,
    phoneProblem: null,
    alreadySent: false,
    connected: true,
    templateReady: true,
  } as const;

  it('allows an eligible appointment', () => {
    expect(whatsAppExclusion(ok)).toBeNull();
  });

  it('gives the most decisive reason first', () => {
    expect(
      whatsAppExclusion({ ...ok, appointmentStatus: 'cancelled', optIn: false }),
    ).toBe('appointment_cancelled');
    expect(whatsAppExclusion({ ...ok, optedOut: true, optIn: false })).toBe('opted_out');
    expect(
      whatsAppExclusion({ ...ok, optIn: false, phoneProblem: 'phone_missing' }),
    ).toBe('no_consent');
    expect(whatsAppExclusion({ ...ok, phoneProblem: 'phone_invalid' })).toBe(
      'phone_invalid',
    );
    expect(whatsAppExclusion({ ...ok, alreadySent: true, connected: false })).toBe(
      'already_sent',
    );
    expect(whatsAppExclusion({ ...ok, connected: false })).toBe('not_connected');
    expect(whatsAppExclusion({ ...ok, templateReady: false })).toBe('no_template');
  });

  it('sends to the WhatsApp number, else the phone, as E.164', () => {
    expect(
      whatsAppRecipient({ whatsappPhone: null, phone: '069 123 4567' }, '355'),
    ).toEqual({
      phone: '+355691234567',
      problem: null,
    });
    expect(
      whatsAppRecipient(
        { whatsappPhone: '+39 333 123 4567', phone: '069 123 4567' },
        '355',
      ).phone,
    ).toBe('+393331234567');
    expect(whatsAppRecipient({ whatsappPhone: '', phone: null }, '355')).toEqual({
      phone: null,
      problem: 'phone_missing',
    });
    expect(whatsAppRecipient({ whatsappPhone: null, phone: '12' }, '355')).toEqual({
      phone: null,
      problem: 'phone_invalid',
    });
  });
});
