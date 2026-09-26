import {
  MESSAGE_PLACEHOLDERS,
  MESSAGE_PURPOSES,
  defaultMessageTemplate,
  renderMessage,
  whatsappVariables,
} from './messages';
import { REMINDER_LOCALES } from './reminders';

const values = {
  first_name: 'Ana',
  clinic: 'Klinika Dentare Tirana',
  date: 'e martë 22 shtator',
  time: '10:30',
  visit_date: 'e hënë 21 shtator',
  balance: '12 500 Lekë',
  clinic_phone: '+355 4 222 3333',
  dentist: 'Dr. Elira Shehu',
  clinic_address: 'Rruga e Kavajës 12, Tiranë',
};

describe('built-in messages', () => {
  it.each(
    MESSAGE_PURPOSES.flatMap((p) =>
      REMINDER_LOCALES.flatMap(
        (l) =>
          [
            [p, l, true],
            [p, l, false],
          ] as const,
      ),
    ),
  )(
    '%s in %s (phone on file: %s) fills every placeholder it uses',
    (purpose, locale, hasPhone) => {
      const template = defaultMessageTemplate(purpose, locale, hasPhone);
      for (const used of template.matchAll(/\{([a-z_]+)\}/g)) {
        expect(MESSAGE_PLACEHOLDERS[purpose]).toContain(used[1]);
      }
      const text = renderMessage(template, purpose, values);
      expect(text).not.toMatch(/[{}]/);
      expect(text).toContain('Ana');
      expect(text.includes('+355 4 222 3333')).toBe(hasPhone);
    },
  );

  it('writes Albanian for the Albanian locale', () => {
    expect(
      renderMessage(
        defaultMessageTemplate('unpaid_balance', 'sq', true),
        'unpaid_balance',
        values,
      ),
    ).toBe(
      'Përshëndetje Ana, ju njoftojmë me mirësjellje se në Klinika Dentare Tirana rezulton një detyrim i papaguar prej 12 500 Lekë. Për ta shlyer ose për çdo pyetje, telefononi +355 4 222 3333. Faleminderit!',
    );
    expect(defaultMessageTemplate('post_procedure_followup', 'sq', true)).toMatch(
      /^Përshëndetje \{first_name\}/,
    );
  });

  it('never says what the treatment was', () => {
    for (const purpose of MESSAGE_PURPOSES) {
      for (const locale of REMINDER_LOCALES) {
        const t = defaultMessageTemplate(purpose, locale, true);
        expect(t).not.toMatch(/\{(reason|treatment|procedure|tooth|last_name)\}/);
      }
    }
  });

  it('does not fill a placeholder from another kind of message', () => {
    expect(
      renderMessage('Balance {balance}, time {time}', 'unpaid_balance', values),
    ).toBe('Balance 12 500 Lekë, time {time}');
  });

  it('numbers WhatsApp variables and never sends an empty one', () => {
    expect(whatsappVariables('appointment_reminder', { ...values, dentist: '' })).toEqual(
      {
        1: 'Ana',
        2: 'e martë 22 shtator',
        3: '10:30',
        4: '—',
        5: 'Klinika Dentare Tirana',
      },
    );
    expect(whatsappVariables('unpaid_balance', values)).toEqual({
      1: 'Ana',
      2: '12 500 Lekë',
      3: 'Klinika Dentare Tirana',
      4: '+355 4 222 3333',
    });
  });
});
