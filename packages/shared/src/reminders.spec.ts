import {
  REMINDER_PLACEHOLDERS,
  defaultReminderTemplate,
  formatAppointmentTime,
  isTimeZone,
  renderReminder,
  smsSegments,
  toE164,
  unknownPlaceholders,
} from './reminders';

const values = {
  first_name: 'Ana',
  clinic: 'Avicena Dental',
  date: 'Tuesday 15 September',
  time: '10:30',
  clinic_phone: '+355 4 222 3333',
  dentist: 'Dr. Elira Kola',
  clinic_address: 'Rruga e Kavajës 12, Tiranë',
};

describe('what a clinic may add to its wording', () => {
  it('can name the dentist and the address, which say where and with whom but not why', () => {
    const text = renderReminder(
      '{first_name}: {date} {time} with {dentist} at {clinic_address}',
      values,
    );
    expect(text).toBe(
      'Ana: Tuesday 15 September 10:30 with Dr. Elira Kola at Rruga e Kavajës 12, Tiranë',
    );
    expect(unknownPlaceholders('{dentist} {clinic_address}')).toEqual([]);
  });
});

describe('the built-in reminder', () => {
  it('says who, where and when — and nothing clinical', () => {
    for (const locale of ['en', 'sq'] as const) {
      const text = renderReminder(defaultReminderTemplate(locale, true), values);
      expect(text).toContain('Ana');
      expect(text).toContain('Avicena Dental');
      expect(text).toContain('10:30');
      expect(unknownPlaceholders(defaultReminderTemplate(locale, true))).toEqual([]);
    }
  });

  it('does not ask the patient to call a number the clinic has not given', () => {
    for (const locale of ['en', 'sq'] as const) {
      expect(defaultReminderTemplate(locale, false)).not.toContain('{clinic_phone}');
    }
  });

  it('offers nothing a template could use to reach the treatment', () => {
    expect(REMINDER_PLACEHOLDERS).not.toContain('reason' as never);
    expect(
      unknownPlaceholders('See you for {reason} with {doctor}, {first_name}'),
    ).toEqual(['{reason}', '{doctor}']);
  });
});

describe('renderReminder', () => {
  it('fills known placeholders and collapses whitespace to one paragraph', () => {
    expect(renderReminder('Hi {first_name},\n\n  {clinic} at {time}.', values)).toBe(
      'Hi Ana, Avicena Dental at 10:30.',
    );
  });

  it('leaves text that only looks like a placeholder alone', () => {
    expect(renderReminder('{First_Name} {first_name}', values)).toBe('{First_Name} Ana');
  });
});

describe('formatAppointmentTime', () => {
  const at = new Date('2026-09-15T08:30:00Z');

  it('uses the clinic’s zone, not the server’s', () => {
    expect(formatAppointmentTime(at, 'Europe/Tirane', 'en').time).toBe('10:30');
    expect(formatAppointmentTime(at, 'UTC', 'en').time).toBe('08:30');
  });

  it('names the day in the clinic’s language', () => {
    expect(formatAppointmentTime(at, 'Europe/Tirane', 'en').date).toMatch(
      /Tuesday.*15.*September/,
    );
    expect(formatAppointmentTime(at, 'Europe/Tirane', 'sq').date).toMatch(/15/);
  });

  it('knows a real zone from a made-up one', () => {
    expect(isTimeZone('Europe/Tirane')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });
});

describe('toE164', () => {
  it.each([
    ['069 123 4567', '+355691234567'],
    ['(069) 123-4567', '+355691234567'],
    ['69 123 4567', '+355691234567'],
    ['+355 69 123 4567', '+355691234567'],
    ['00355 69 123 4567', '+355691234567'],
    ['355691234567', '+355691234567'],
    ['+44 7700 900123', '+447700900123'],
  ])('%p -> %p', (input, expected) => {
    expect(toE164(input, '355')).toBe(expected);
  });

  it('uses the clinic’s own country for local numbers', () => {
    expect(toE164('07700 900123', '44')).toBe('+447700900123');
  });

  it.each([null, '', '12', 'ext. 12', 'ask for Ana', '+0123456789', '+1234567890123456'])(
    'refuses %p',
    (input) => {
      expect(toE164(input, '355')).toBeNull();
    },
  );
});

describe('smsSegments', () => {
  it('fits 160 plain characters in one part, and splits at 153 after that', () => {
    expect(smsSegments('a'.repeat(160))).toEqual({
      encoding: 'gsm7',
      characters: 160,
      segments: 1,
    });
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('a'.repeat(306)).segments).toBe(2);
    expect(smsSegments('a'.repeat(307)).segments).toBe(3);
  });

  it('counts the euro sign as two', () => {
    expect(smsSegments('€'.repeat(80))).toEqual({
      encoding: 'gsm7',
      characters: 160,
      segments: 1,
    });
  });

  it('drops to 70 per part once one character is outside the GSM alphabet', () => {
    expect(smsSegments(`ë${'a'.repeat(69)}`)).toEqual({
      encoding: 'ucs2',
      characters: 70,
      segments: 1,
    });
    expect(smsSegments(`ë${'a'.repeat(70)}`).segments).toBe(2);
  });
});
