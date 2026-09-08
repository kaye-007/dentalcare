import {
  ABSENT_CONDITIONS,
  ALL_TEETH,
  CONDITION_LABELS,
  PERMANENT_LOWER,
  PERMANENT_TEETH,
  PERMANENT_UPPER,
  PRIMARY_LOWER,
  PRIMARY_TEETH,
  PRIMARY_UPPER,
  SURFACES,
  TOOTH_CONDITIONS,
  WHOLE_TOOTH_CONDITIONS,
  archesFor,
  dentitionOf,
  isLower,
  isPrimary,
  formatTooth,
  fromUniversal,
  isAbsent,
  isAnterior,
  isCondition,
  isPosterior,
  isUpper,
  isValidSurface,
  isValidTooth,
  isWholeToothCondition,
  positionOf,
  quadrantOf,
  surfaceName,
  surfacesFor,
  toUniversal,
  toothLabel,
  toothType,
} from './tooth-notation';

describe('dentition sets', () => {
  it('has 32 permanent and 20 primary teeth, all distinct', () => {
    expect(PERMANENT_TEETH).toHaveLength(32);
    expect(PRIMARY_TEETH).toHaveLength(20);
    expect(new Set(ALL_TEETH).size).toBe(52);
  });

  it('uses quadrants 1–4 for permanent and 5–8 for primary', () => {
    for (const t of PERMANENT_TEETH) expect(quadrantOf(t)).toBeGreaterThanOrEqual(1);
    for (const t of PERMANENT_TEETH) expect(quadrantOf(t)).toBeLessThanOrEqual(4);
    for (const t of PRIMARY_TEETH) expect(quadrantOf(t)).toBeGreaterThanOrEqual(5);
    for (const t of PRIMARY_TEETH) expect(quadrantOf(t)).toBeLessThanOrEqual(8);
  });

  it('puts 8 teeth in every permanent quadrant and 5 in every primary one', () => {
    for (const q of [1, 2, 3, 4]) {
      expect(PERMANENT_TEETH.filter((t) => quadrantOf(t) === q)).toHaveLength(8);
    }
    for (const q of [5, 6, 7, 8]) {
      expect(PRIMARY_TEETH.filter((t) => quadrantOf(t) === q)).toHaveLength(5);
    }
  });

  it('rejects numbers that are not teeth', () => {
    for (const bad of [0, 1, 10, 19, 20, 29, 30, 39, 40, 49, 50, 56, 66, 86, 99, -11]) {
      expect(isValidTooth(bad)).toBe(false);
      expect(dentitionOf(bad)).toBeNull();
    }
  });

  it('classifies every tooth as exactly one dentition', () => {
    for (const t of PERMANENT_TEETH) expect(dentitionOf(t)).toBe('permanent');
    for (const t of PRIMARY_TEETH) expect(dentitionOf(t)).toBe('primary');
  });
});

describe('anatomy', () => {
  it('reads position from the second FDI digit', () => {
    expect(positionOf(11)).toBe(1);
    expect(positionOf(48)).toBe(8);
    expect(positionOf(55)).toBe(5);
  });

  it('puts quadrants 1, 2, 5 and 6 in the upper arch', () => {
    expect([11, 28, 51, 65].every(isUpper)).toBe(true);
    expect([31, 48, 71, 85].some(isUpper)).toBe(false);
  });

  it('treats positions 1–3 as anterior', () => {
    for (const t of [11, 12, 13, 21, 33, 41, 51, 63]) expect(isAnterior(t)).toBe(true);
    for (const t of [14, 16, 18, 24, 38, 45, 54, 75]) expect(isPosterior(t)).toBe(true);
  });

  it('names tooth types, with no premolars in the primary dentition', () => {
    expect(toothType(11)).toBe('incisor');
    expect(toothType(13)).toBe('canine');
    expect(toothType(14)).toBe('premolar');
    expect(toothType(16)).toBe('molar');
    // Primary positions 4 and 5 are molars, not premolars.
    expect(toothType(54)).toBe('molar');
    expect(toothType(55)).toBe('molar');
    expect(toothType(53)).toBe('canine');
    expect(toothType(51)).toBe('incisor');
    for (const t of PRIMARY_TEETH) expect(toothType(t)).not.toBe('premolar');
  });

  it('labels a tooth with its quadrant and dentition', () => {
    expect(toothLabel(16)).toBe('Upper right · tooth 16');
    expect(toothLabel(75)).toBe('Lower left · tooth 75 (primary)');
  });
});

describe('surfaces', () => {
  it('gives every tooth exactly five surfaces', () => {
    for (const t of ALL_TEETH) expect(surfacesFor(t)).toHaveLength(5);
  });

  it('never gives a tooth both occlusal and incisal', () => {
    for (const t of ALL_TEETH) {
      const s = surfacesFor(t);
      expect(s.includes('O') && s.includes('I')).toBe(false);
      expect(s.includes('O') || s.includes('I')).toBe(true);
    }
  });

  it('gives anteriors an incisal edge and posteriors an occlusal table', () => {
    expect(surfacesFor(11)).toContain('I');
    expect(surfacesFor(11)).not.toContain('O');
    expect(surfacesFor(16)).toContain('O');
    expect(surfacesFor(16)).not.toContain('I');
  });

  it('rejects a surface the tooth does not have', () => {
    expect(isValidSurface(11, 'O')).toBe(false);
    expect(isValidSurface(11, 'I')).toBe(true);
    expect(isValidSurface(16, 'I')).toBe(false);
    expect(isValidSurface(16, 'O')).toBe(true);
    // Mesial and distal exist on everything.
    for (const t of ALL_TEETH) {
      expect(isValidSurface(t, 'M')).toBe(true);
      expect(isValidSurface(t, 'D')).toBe(true);
    }
  });

  it('names F as labial on anteriors and buccal on posteriors', () => {
    expect(surfaceName(11, 'F')).toBe('Labial');
    expect(surfaceName(16, 'F')).toBe('Buccal');
    expect(surfaceName(51, 'F')).toBe('Labial');
    expect(surfaceName(85, 'F')).toBe('Buccal');
  });

  it('names L as palatal on upper teeth and lingual on lower', () => {
    expect(surfaceName(16, 'L')).toBe('Palatal');
    expect(surfaceName(46, 'L')).toBe('Lingual');
    expect(surfaceName(61, 'L')).toBe('Palatal');
    expect(surfaceName(81, 'L')).toBe('Lingual');
  });

  it('names every valid surface on every tooth', () => {
    for (const t of ALL_TEETH) {
      for (const s of surfacesFor(t)) {
        expect(surfaceName(t, s)).toMatch(/^[A-Z][a-z]+$/);
      }
    }
  });

  it('declares exactly six surface codes', () => {
    expect(SURFACES).toEqual(['M', 'D', 'O', 'I', 'F', 'L']);
  });
});

describe('Universal numbering', () => {
  it('maps the permanent arch to 1–32 with no gaps or repeats', () => {
    const nums = PERMANENT_TEETH.map((t) => Number(toUniversal(t)));
    expect(new Set(nums).size).toBe(32);
    expect(Math.min(...nums)).toBe(1);
    expect(Math.max(...nums)).toBe(32);
  });

  it('maps the primary arch to A–T with no gaps or repeats', () => {
    const letters = PRIMARY_TEETH.map((t) => toUniversal(t));
    expect(new Set(letters).size).toBe(20);
    expect([...letters].sort().join('')).toBe('ABCDEFGHIJKLMNOPQRST');
  });

  it('anchors the landmark teeth correctly', () => {
    expect(toUniversal(18)).toBe('1'); // upper right third molar
    expect(toUniversal(11)).toBe('8'); // upper right central incisor
    expect(toUniversal(21)).toBe('9'); // upper left central incisor
    expect(toUniversal(28)).toBe('16'); // upper left third molar
    expect(toUniversal(38)).toBe('17'); // lower left third molar
    expect(toUniversal(31)).toBe('24'); // lower left central incisor
    expect(toUniversal(41)).toBe('25'); // lower right central incisor
    expect(toUniversal(48)).toBe('32'); // lower right third molar
  });

  it('anchors the primary landmarks correctly', () => {
    expect(toUniversal(55)).toBe('A'); // upper right second primary molar
    expect(toUniversal(65)).toBe('J'); // upper left second primary molar
    expect(toUniversal(75)).toBe('K'); // lower left second primary molar
    expect(toUniversal(85)).toBe('T'); // lower right second primary molar
  });

  it('round-trips every tooth through Universal and back', () => {
    for (const t of ALL_TEETH) {
      const u = toUniversal(t);
      expect(u).not.toBeNull();
      expect(fromUniversal(u!)).toBe(t);
    }
  });

  it('parses letters case-insensitively and ignores surrounding space', () => {
    expect(fromUniversal(' c ')).toBe(53);
    expect(fromUniversal('C')).toBe(53);
    expect(fromUniversal('14')).toBe(26);
  });

  it('returns null for labels that are not teeth', () => {
    for (const bad of ['0', '33', 'U', 'Z', '', 'abc', '-1']) {
      expect(fromUniversal(bad)).toBeNull();
    }
    expect(toUniversal(99)).toBeNull();
  });

  it('formats in the requested notation and falls back to FDI', () => {
    expect(formatTooth(16, 'fdi')).toBe('16');
    expect(formatTooth(16, 'universal')).toBe('3');
    expect(formatTooth(53, 'universal')).toBe('C');
    expect(formatTooth(99, 'universal')).toBe('99');
  });
});

describe('conditions', () => {
  it('recognises only declared conditions', () => {
    for (const c of TOOTH_CONDITIONS) expect(isCondition(c)).toBe(true);
    for (const bad of ['CARIES', 'decay', '', null, undefined, 5, {}]) {
      expect(isCondition(bad)).toBe(false);
    }
  });

  it('treats structural findings as whole-tooth, not per-surface', () => {
    for (const c of ['extracted', 'missing', 'implant', 'crown', 'root_canal'] as const) {
      expect(isWholeToothCondition(c)).toBe(true);
    }
    // Surface-scoped findings must NOT be whole-tooth.
    for (const c of [
      'caries',
      'restored',
      'sealant',
      'veneer',
      'fractured',
      'watch',
    ] as const) {
      expect(isWholeToothCondition(c)).toBe(false);
    }
  });

  it('marks only extracted and missing as absent', () => {
    expect(isAbsent('extracted')).toBe(true);
    expect(isAbsent('missing')).toBe(true);
    expect(isAbsent('implant')).toBe(false);
    expect(isAbsent('caries')).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Reconciliation
 *
 * This module replaced two implementations — the API's and the clinic SPA's —
 * which had drifted. The cases below are the ones only ONE of them handled,
 * plus the two places where they disagreed outright. They exist so the merge
 * cannot quietly lose a behaviour that some caller depended on.
 * ══════════════════════════════════════════════════════════════════════════ */

describe('arches (was client-only)', () => {
  it('splits each dentition into an upper and a lower arch', () => {
    expect(archesFor('permanent').upper).toEqual(PERMANENT_UPPER);
    expect(archesFor('permanent').lower).toEqual(PERMANENT_LOWER);
    expect(archesFor('primary').upper).toEqual(PRIMARY_UPPER);
    expect(archesFor('primary').lower).toEqual(PRIMARY_LOWER);
  });

  it('covers every tooth exactly once across both arches', () => {
    for (const d of ['permanent', 'primary'] as const) {
      const { upper, lower } = archesFor(d);
      const all = [...upper, ...lower];
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort()).toEqual(
        [...(d === 'permanent' ? PERMANENT_TEETH : PRIMARY_TEETH)].sort(),
      );
    }
  });

  /**
   * The flat lists the API validates against are DERIVED from the arches the
   * chart draws, so the two cannot describe different sets of teeth. Written
   * out twice, as they were, is exactly the shape that drifts.
   */
  it('keeps the flat sets and the arches in agreement by construction', () => {
    expect([...PERMANENT_TEETH]).toEqual([...PERMANENT_UPPER, ...PERMANENT_LOWER]);
    expect([...PRIMARY_TEETH]).toEqual([...PRIMARY_UPPER, ...PRIMARY_LOWER]);
    expect(ALL_TEETH).toHaveLength(52);
  });

  it('places every arch tooth in the arch it was filed under', () => {
    for (const d of ['permanent', 'primary'] as const) {
      for (const t of archesFor(d).upper) expect(isUpper(t)).toBe(true);
      for (const t of archesFor(d).lower) expect(isLower(t)).toBe(true);
    }
  });
});

describe('toothType — the first divergence', () => {
  /**
   * The API asked "is this one of the twenty primary teeth?"; the client asked
   * "is the quadrant digit 5 or more?". On every real tooth those agree, which
   * is why the drift went unnoticed. They part on numbers that are not teeth.
   *
   * The membership test won: a function about anatomy should answer from
   * anatomy. 94 is not a tooth, so calling it a molar because "9 >= 5" is an
   * answer about arithmetic, not about a mouth.
   */
  it('agrees with both old implementations on every real tooth', () => {
    for (const t of ALL_TEETH) {
      const p = positionOf(t);
      const byQuadrant =
        p <= 2
          ? 'incisor'
          : p === 3
            ? 'canine'
            : quadrantOf(t) >= 5
              ? 'molar'
              : p <= 5
                ? 'premolar'
                : 'molar';
      expect(toothType(t)).toBe(byQuadrant);
    }
  });

  it('treats a number that is not a tooth by position, not by quadrant', () => {
    // 94 has quadrant 9, which the client's test would have called primary.
    expect(isPrimary(94)).toBe(false);
    expect(toothType(94)).toBe('premolar');
  });

  it('reports no dentition for a number that is not a tooth', () => {
    for (const n of [0, 9, 19, 29, 49, 56, 58, 66, 94, 99]) {
      expect(dentitionOf(n)).toBeNull();
      expect(isValidTooth(n)).toBe(false);
      expect(isPrimary(n)).toBe(false);
    }
  });
});

describe('toothLabel — the second divergence', () => {
  /**
   * The API always rendered FDI; the client rendered the notation the
   * clinician had selected. The client's signature won, with FDI as the
   * default, so every existing API call is unchanged.
   */
  it('defaults to FDI, which is what the API always produced', () => {
    expect(toothLabel(16)).toBe('Upper right · tooth 16');
    expect(toothLabel(75)).toBe('Lower left · tooth 75 (primary)');
  });

  it('renders Universal when asked, which is what the client produced', () => {
    expect(toothLabel(16, 'universal')).toBe('Upper right · tooth 3');
    expect(toothLabel(75, 'universal')).toBe('Lower left · tooth K (primary)');
  });

  it('is explicit about an unrecognised quadrant rather than blank', () => {
    // The API said "Unknown"; the client said "", producing " · tooth 99".
    expect(toothLabel(99)).toBe('Unknown · tooth 99');
    expect(toothLabel(99).startsWith(' ·')).toBe(false);
  });

  it('marks primary teeth and only primary teeth', () => {
    for (const t of PRIMARY_TEETH) expect(toothLabel(t)).toContain('(primary)');
    for (const t of PERMANENT_TEETH) expect(toothLabel(t)).not.toContain('(primary)');
  });
});

describe('surface naming across every tooth', () => {
  /**
   * F and L are stored orientation-neutral and rendered per tooth. Asserting
   * this over all 52 teeth rather than a sample is cheap, and the alternative
   * — a sample that happens to miss the primary lower arch — is how "lingual"
   * ends up printed on a palate.
   */
  it('names F labial on anteriors and buccal on posteriors', () => {
    for (const t of ALL_TEETH) {
      expect(surfaceName(t, 'F')).toBe(isAnterior(t) ? 'Labial' : 'Buccal');
    }
  });

  it('names L palatal on upper teeth and lingual on lower', () => {
    for (const t of ALL_TEETH) {
      expect(surfaceName(t, 'L')).toBe(isUpper(t) ? 'Palatal' : 'Lingual');
    }
  });

  it('names the orientation-free surfaces the same on every tooth', () => {
    for (const t of ALL_TEETH) {
      expect(surfaceName(t, 'M')).toBe('Mesial');
      expect(surfaceName(t, 'D')).toBe('Distal');
      expect(surfaceName(t, isAnterior(t) ? 'I' : 'O')).toBe(
        isAnterior(t) ? 'Incisal' : 'Occlusal',
      );
    }
  });
});

describe('the third copy, in the SPA api client', () => {
  /**
   * SURFACES, TOOTH_CONDITIONS, CONDITION_LABELS and WHOLE_TOOTH_CONDITIONS
   * were also restated in apps/tenant-web/src/lib/api.ts. All three copies
   * happened to agree; these assert the values that had to be preserved when
   * the copies were removed, so a later edit here cannot silently change what
   * the client offers a clinician versus what the API accepts.
   */
  it('keeps the six surface codes in their canonical order', () => {
    expect([...SURFACES]).toEqual(['M', 'D', 'O', 'I', 'F', 'L']);
  });

  it('keeps the thirteen conditions in their canonical order', () => {
    expect([...TOOTH_CONDITIONS]).toEqual([
      'caries',
      'restored',
      'crown',
      'bridge',
      'veneer',
      'root_canal',
      'implant',
      'extracted',
      'missing',
      'impacted',
      'fractured',
      'sealant',
      'watch',
    ]);
  });

  it('labels every condition, and only the conditions', () => {
    expect(Object.keys(CONDITION_LABELS).sort()).toEqual([...TOOTH_CONDITIONS].sort());
    for (const c of TOOTH_CONDITIONS) {
      expect(CONDITION_LABELS[c]).toEqual(expect.any(String));
      expect(CONDITION_LABELS[c].length).toBeGreaterThan(0);
    }
  });

  it('keeps the seven whole-tooth findings', () => {
    expect([...WHOLE_TOOTH_CONDITIONS]).toEqual([
      'extracted',
      'missing',
      'implant',
      'impacted',
      'crown',
      'bridge',
      'root_canal',
    ]);
    for (const c of WHOLE_TOOTH_CONDITIONS) expect(isWholeToothCondition(c)).toBe(true);
  });

  /** Every whole-tooth finding must be a real condition, or the API rejects it. */
  it('draws the whole-tooth and absent sets from the condition list', () => {
    for (const c of WHOLE_TOOTH_CONDITIONS) expect(isCondition(c)).toBe(true);
    for (const c of ABSENT_CONDITIONS) {
      expect(isCondition(c)).toBe(true);
      expect(isAbsent(c)).toBe(true);
      // A tooth that is gone is a whole-tooth finding by definition.
      expect(isWholeToothCondition(c)).toBe(true);
    }
  });
});

describe('Universal numbering is a bijection', () => {
  /**
   * Both old implementations carried a hand-written FDI to Universal table.
   * The API's could also parse back; the client's could not. Round-tripping
   * every tooth is the cheapest way to catch a transposed pair, which is the
   * error a hand-written table of 52 entries actually makes.
   */
  it('round-trips every tooth', () => {
    for (const t of ALL_TEETH) {
      const universal = toUniversal(t);
      expect(universal).not.toBeNull();
      expect(fromUniversal(universal as string)).toBe(t);
    }
  });

  it('assigns a distinct Universal label to every tooth', () => {
    const labels = ALL_TEETH.map((t) => toUniversal(t));
    expect(new Set(labels).size).toBe(ALL_TEETH.length);
  });

  it('numbers permanent teeth 1-32 and letters the primary A-T', () => {
    const permanent = PERMANENT_TEETH.map((t) => Number(toUniversal(t))).sort(
      (a, b) => a - b,
    );
    expect(permanent).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));

    const primary = PRIMARY_TEETH.map((t) => toUniversal(t)).sort();
    expect(primary).toEqual('ABCDEFGHIJKLMNOPQRST'.split(''));
  });

  it('anchors the corners of the Universal path', () => {
    expect(toUniversal(18)).toBe('1'); // upper right third molar
    expect(toUniversal(28)).toBe('16'); // upper left third molar
    expect(toUniversal(38)).toBe('17'); // lower left third molar
    expect(toUniversal(48)).toBe('32'); // lower right third molar
    expect(toUniversal(55)).toBe('A');
    expect(toUniversal(65)).toBe('J');
    expect(toUniversal(75)).toBe('K');
    expect(toUniversal(85)).toBe('T');
  });

  it('is forgiving about how a Universal label is typed', () => {
    expect(fromUniversal(' 14 ')).toBe(26);
    expect(fromUniversal('c')).toBe(53);
    expect(fromUniversal('C')).toBe(53);
  });

  it('returns null rather than guessing at nonsense', () => {
    for (const bad of ['', '0', '33', 'U', 'Z', 'abc', '  ']) {
      expect(fromUniversal(bad)).toBeNull();
    }
    expect(toUniversal(99)).toBeNull();
  });

  /** formatTooth falls back to FDI rather than rendering nothing. */
  it('formats an unknown tooth as its FDI number in either notation', () => {
    expect(formatTooth(99, 'fdi')).toBe('99');
    expect(formatTooth(99, 'universal')).toBe('99');
  });
});
