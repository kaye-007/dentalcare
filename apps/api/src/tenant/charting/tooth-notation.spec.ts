import {
  ALL_TEETH,
  PERMANENT_TEETH,
  PRIMARY_TEETH,
  SURFACES,
  TOOTH_CONDITIONS,
  dentitionOf,
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
    expect(toUniversal(18)).toBe('1');   // upper right third molar
    expect(toUniversal(11)).toBe('8');   // upper right central incisor
    expect(toUniversal(21)).toBe('9');   // upper left central incisor
    expect(toUniversal(28)).toBe('16');  // upper left third molar
    expect(toUniversal(38)).toBe('17');  // lower left third molar
    expect(toUniversal(31)).toBe('24');  // lower left central incisor
    expect(toUniversal(41)).toBe('25');  // lower right central incisor
    expect(toUniversal(48)).toBe('32');  // lower right third molar
  });

  it('anchors the primary landmarks correctly', () => {
    expect(toUniversal(55)).toBe('A');   // upper right second primary molar
    expect(toUniversal(65)).toBe('J');   // upper left second primary molar
    expect(toUniversal(75)).toBe('K');   // lower left second primary molar
    expect(toUniversal(85)).toBe('T');   // lower right second primary molar
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
    for (const c of ['caries', 'restored', 'sealant', 'veneer', 'fractured', 'watch'] as const) {
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
