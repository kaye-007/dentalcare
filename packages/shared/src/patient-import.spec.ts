import {
  duplicatesWithinFile,
  guessMapping,
  normalizeImportRow,
  parseImportDate,
} from './patient-import';

const opts = { dateFormat: 'DMY' as const, countryCode: '355' };

describe('guessMapping', () => {
  it('maps English and Albanian headers and leaves unknown columns unmapped', () => {
    expect(
      guessMapping([
        'Emri',
        'Mbiemri',
        'Telefon',
        'E-mail',
        'Datelindja',
        'Favourite colour',
      ]),
    ).toEqual(['firstName', 'lastName', 'phone', 'email', 'birthDate', null]);
  });

  it('matches headers with or without Albanian diacritics', () => {
    expect(guessMapping(['DATËLINDJA', 'Qyteti', 'Adresë'])).toEqual([
      'birthDate',
      'city',
      'address',
    ]);
    expect(guessMapping(['Adrese'])).toEqual(['address']);
  });

  it('never maps two columns to one field', () => {
    expect(guessMapping(['Name', 'First name'])).toEqual(['firstName', null]);
  });
});

describe('a name in one column', () => {
  it('reads a whole-name column in English or Albanian as the full name', () => {
    expect(guessMapping(['Emri Mbiemri', 'Telefoni'])).toEqual(['fullName', 'phone']);
    expect(guessMapping(['Pacienti', 'Nr. telefoni'])).toEqual(['fullName', 'phone']);
  });

  it('reads a lone "Name" as the whole name, but beside a surname as the first name', () => {
    expect(guessMapping(['Name', 'Phone'])).toEqual(['fullName', 'phone']);
    expect(guessMapping(['Name', 'Surname'])).toEqual(['firstName', 'lastName']);
  });

  it('splits on the last space: the last word is the surname', () => {
    const { value, errors } = normalizeImportRow(
      { fullName: '  Ana  Maria Hoxha ' },
      opts,
    );
    expect(errors).toEqual([]);
    expect(value).toMatchObject({ firstName: 'Ana Maria', lastName: 'Hoxha' });
  });

  it('says a surname is missing when the column holds one word', () => {
    const { errors } = normalizeImportRow({ fullName: 'Erisa' }, opts);
    expect(errors.map((e) => e.field)).toContain('lastName');
  });

  it('prefers separate columns when a file has both', () => {
    const { value } = normalizeImportRow(
      { fullName: 'Erisa Kola', firstName: 'Erisa', lastName: 'Kola-Hoxha' },
      opts,
    );
    expect(value.lastName).toBe('Kola-Hoxha');
  });
});

describe('parseImportDate', () => {
  const today = new Date('2026-09-15T12:00:00Z');

  it('reads the order a person chose', () => {
    expect(parseImportDate('03/04/1990', 'DMY', today)).toBe('1990-04-03');
    expect(parseImportDate('03/04/1990', 'MDY', today)).toBe('1990-03-04');
    expect(parseImportDate('1990-04-03', 'YMD', today)).toBe('1990-04-03');
    expect(parseImportDate('3.4.90', 'DMY', today)).toBe('1990-04-03');
  });

  it('refuses dates that do not exist, the future, and the implausibly old', () => {
    expect(parseImportDate('31/02/1990', 'DMY', today)).toBeNull();
    expect(parseImportDate('01/01/2030', 'DMY', today)).toBeNull();
    expect(parseImportDate('01/01/1850', 'DMY', today)).toBeNull();
    expect(parseImportDate('yesterday', 'DMY', today)).toBeNull();
  });
});

describe('normalizeImportRow', () => {
  it('normalises a good row', () => {
    const { value, errors } = normalizeImportRow(
      {
        firstName: ' Ana ',
        lastName: 'Hoxha',
        phone: '069 123 4567',
        email: 'Ana@Example.al',
        birthDate: '03/04/1990',
        nationalId: 'j 12345678 a',
        gender: 'F',
        medicalConditions: 'Diabetes; Hypertension',
        balance: '1.200,50',
      },
      opts,
    );
    expect(errors).toEqual([]);
    expect(value).toMatchObject({
      firstName: 'Ana',
      phoneE164: '+355691234567',
      email: 'ana@example.al',
      birthDate: '1990-04-03',
      nationalId: 'J12345678A',
      gender: 'female',
      conditions: ['Diabetes', 'Hypertension'],
      balance: 120050,
    });
  });

  it('flags every problem on a bad row, by field', () => {
    const { errors } = normalizeImportRow(
      {
        firstName: '',
        lastName: 'X',
        phone: 'ask at reception',
        email: 'not-an-email',
        balance: 'lots',
      },
      opts,
    );
    expect(errors.map((e) => e.field).sort()).toEqual([
      'balance',
      'email',
      'firstName',
      'phone',
    ]);
  });

  it('reads a credit as a negative balance', () => {
    expect(
      normalizeImportRow({ firstName: 'A', lastName: 'B', balance: '-30' }, opts).value
        .balance,
    ).toBe(-3000);
  });
});

describe('duplicatesWithinFile', () => {
  it('matches on national ID or phone and points at the first occurrence', () => {
    const dupes = duplicatesWithinFile([
      { nationalId: 'J1', phoneE164: '+355691' },
      { nationalId: null, phoneE164: '+355692' },
      { nationalId: 'J1', phoneE164: null },
      { nationalId: null, phoneE164: '+355692' },
    ]);
    expect([...dupes.entries()]).toEqual([
      [2, 0],
      [3, 1],
    ]);
  });
});
