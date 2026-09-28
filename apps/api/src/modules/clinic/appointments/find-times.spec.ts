import {
  addDays,
  clinicDate,
  findTimes,
  isDate,
  weekdayOf,
  zonedInstant,
  type Busy,
  type FindTimesInput,
  type OpeningDay,
} from './find-times';

const ZONE = 'Europe/Tirane';
/** Monday 28 September 2026 — Tirana is on summer time, UTC+2. */
const MONDAY = '2026-09-28';

const at = (date: string, time: string) => zonedInstant(ZONE, date, time);
/** "09:30" on the clinic's clock for a found time. */
const hhmm = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));

const WEEK: OpeningDay[] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  closed: day >= 5,
  open: '09:00',
  close: '17:00',
}));

const ARDIT = { id: 'ardit', name: 'Dr. Ardit', homeRoomId: null, shifts: [] };
const ELIRA = { id: 'elira', name: 'Dr. Elira', homeRoomId: null, shifts: [] };

function input(over: Partial<FindTimesInput> = {}): FindTimesInput {
  return {
    zone: ZONE,
    // Sunday evening: all of Monday is still ahead.
    now: at('2026-09-27', '20:00'),
    from: MONDAY,
    days: 1,
    durationMinutes: 30,
    opening: WEEK,
    practitioners: [ARDIT],
    rooms: [],
    closures: [],
    busy: [],
    spread: false,
    limit: 100,
    ...over,
  };
}

const busy = (
  over: Partial<Busy> & { from: string; to: string; date?: string },
): Busy => ({
  staffId: over.staffId ?? null,
  roomId: over.roomId ?? null,
  patientId: over.patientId ?? 'someone-else',
  start: at(over.date ?? MONDAY, over.from),
  end: at(over.date ?? MONDAY, over.to),
});

describe('clinic dates and instants', () => {
  it('reads a wall time on the clinic clock, summer and winter', () => {
    expect(new Date(at(MONDAY, '09:00')).toISOString()).toBe('2026-09-28T07:00:00.000Z');
    expect(new Date(at('2026-12-01', '09:00')).toISOString()).toBe(
      '2026-12-01T08:00:00.000Z',
    );
  });

  it('settles on the day the clocks change', () => {
    // Summer time starts at 02:00 on 29 March 2026; noon is already UTC+2.
    expect(new Date(at('2026-03-29', '12:00')).toISOString()).toBe(
      '2026-03-29T10:00:00.000Z',
    );
  });

  it("knows the clinic's date when UTC has not reached it yet", () => {
    expect(clinicDate(ZONE, Date.parse('2026-09-27T23:30:00Z'))).toBe('2026-09-28');
  });

  it('does date arithmetic without a zone', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOf(MONDAY)).toBe(1);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-02-28')).toBe(true);
  });
});

describe('finding a time', () => {
  it('offers every quarter hour that fits inside opening hours', () => {
    const { times } = findTimes(
      input({ opening: WEEK.map((d) => ({ ...d, open: '09:00', close: '10:00' })) }),
    );
    expect(times.map((t) => hhmm(t.startsAt))).toEqual(['09:00', '09:15', '09:30']);
    expect(hhmm(times[2]!.endsAt)).toBe('10:00');
  });

  it('offers nothing that has already started, or starts in the next five minutes', () => {
    const { times } = findTimes(input({ now: at(MONDAY, '09:20') }));
    expect(hhmm(times[0]!.startsAt)).toBe('09:30');
  });

  it('skips a busy practitioner and allows back-to-back visits', () => {
    const { times } = findTimes(
      input({ busy: [busy({ staffId: 'ardit', from: '09:00', to: '10:00' })] }),
    );
    expect(times.map((t) => hhmm(t.startsAt)).slice(0, 2)).toEqual(['10:00', '10:15']);
  });

  it('gives a time to whoever is free when the first choice is not', () => {
    const { times } = findTimes(
      input({
        practitioners: [ARDIT, ELIRA],
        preferStaffId: 'ardit',
        busy: [busy({ staffId: 'ardit', from: '09:00', to: '10:00' })],
      }),
    );
    expect(times[0]).toMatchObject({ staffId: 'elira' });
    expect(hhmm(times[0]!.startsAt)).toBe('09:00');
    // From ten, the patient's usual dentist is free again and comes first.
    expect(times.find((t) => hhmm(t.startsAt) === '10:00')).toMatchObject({
      staffId: 'ardit',
    });
  });

  it('never offers a time the patient is already booked', () => {
    const { times } = findTimes(
      input({
        patientId: 'erisa',
        busy: [
          busy({ patientId: 'erisa', staffId: 'elira', from: '09:00', to: '11:00' }),
        ],
      }),
    );
    expect(hhmm(times[0]!.startsAt)).toBe('11:00');
  });

  it('needs a free room when the clinic has rooms, starting with the practitioner’s own', () => {
    const rooms = [
      { id: 'r1', name: 'Salla 1', color: null },
      { id: 'r2', name: 'Salla 2', color: '#f00' },
    ];
    const home = { ...ARDIT, homeRoomId: 'r2' };
    const free = findTimes(input({ practitioners: [home], rooms }));
    expect(free.times[0]).toMatchObject({ operatoryId: 'r2', operatoryName: 'Salla 2' });

    const homeTaken = findTimes(
      input({
        practitioners: [home],
        rooms,
        busy: [busy({ roomId: 'r2', from: '09:00', to: '09:30' })],
      }),
    );
    expect(homeTaken.times[0]).toMatchObject({ operatoryId: 'r1' });

    const allTaken = findTimes(
      input({
        practitioners: [home],
        rooms,
        busy: [
          busy({ roomId: 'r1', from: '09:00', to: '12:00' }),
          busy({ roomId: 'r2', from: '09:00', to: '12:00' }),
        ],
      }),
    );
    expect(hhmm(allTaken.times[0]!.startsAt)).toBe('12:00');
  });

  it("follows a practitioner's own shifts over the clinic's hours", () => {
    const afternoons = {
      ...ARDIT,
      // Monday and Wednesday afternoons only (0 = Sunday).
      shifts: [
        { weekday: 1, start: '14:00', end: '18:00' },
        { weekday: 3, start: '14:00', end: '18:00' },
      ],
    };
    const monday = findTimes(input({ practitioners: [afternoons] }));
    expect(hhmm(monday.times[0]!.startsAt)).toBe('14:00');
    expect(hhmm(monday.times.at(-1)!.startsAt)).toBe('17:30');

    const tuesday = findTimes(input({ practitioners: [afternoons], from: '2026-09-29' }));
    expect(tuesday.times).toEqual([]);
  });

  it('skips a closed day, a holiday, and one person’s leave', () => {
    const saturday = findTimes(input({ from: '2026-10-03' }));
    expect(saturday.times).toEqual([]);

    const holiday = findTimes(
      input({ closures: [{ staffId: null, startsOn: MONDAY, endsOn: MONDAY }] }),
    );
    expect(holiday.times).toEqual([]);

    const leave = findTimes(
      input({
        practitioners: [ARDIT, ELIRA],
        closures: [{ staffId: 'ardit', startsOn: MONDAY, endsOn: '2026-10-02' }],
      }),
    );
    expect(new Set(leave.times.map((t) => t.staffId))).toEqual(new Set(['elira']));
  });

  it('books without a practitioner when the clinic has none', () => {
    const { times } = findTimes(input({ practitioners: [] }));
    expect(times[0]).toMatchObject({ staffId: null, staffName: null });
  });
});

describe('the soonest times, spread out', () => {
  it('offers the first free time of the morning, midday and afternoon', () => {
    const { times } = findTimes(input({ spread: true }));
    expect(times.map((t) => hhmm(t.startsAt))).toEqual(['09:00', '12:00', '15:00']);
  });

  it('carries on across days and stops after the day that reaches the limit', () => {
    const { times, nextFrom } = findTimes(input({ spread: true, days: 14, limit: 4 }));
    // Monday gives three, Tuesday three more: the day is never cut in half.
    expect(times).toHaveLength(6);
    expect(nextFrom).toBe('2026-09-30');
  });

  it('says where to carry on when the window runs out', () => {
    const { nextFrom } = findTimes(input({ spread: true, days: 7, limit: 100 }));
    expect(nextFrom).toBe('2026-10-05');
  });
});
