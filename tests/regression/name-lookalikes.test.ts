/**
 * Audit 1 re-audit, R3 (low). Look-alike names skipped the duplicate suffix, blank-looking and
 * malformed names were accepted, and one character could carry hundreds of combining marks.
 * Special characters are built with String.fromCodePoint so the source stays plain ASCII.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeName, uniqueName } from '@crossfire/shared/rules/validation';
import { TUNING } from '@crossfire/shared/tuning';

const u = (...cps: number[]) => String.fromCodePoint(...cps);
const ZWJ = u(0x200d);
const ZWNJ = u(0x200c);
const ACUTE = u(0x0301);
const CYR_E = u(0x0435);

function clean(raw: string): string {
  const r = sanitizeName(raw);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(raw)}`);
  return r.name;
}

describe('R3: look-alikes get the duplicate suffix', () => {
  const cases: [string, string, string][] = [
    ['ZWJ at the end', 'Alice' + ZWJ, 'Alice'],
    ['ZWNJ inside', 'Al' + ZWNJ + 'ice', 'Alice'],
    ['Cyrillic e', 'Alic' + CYR_E, 'Alice'],
    ['decomposed accent', 'Jose' + ACUTE, 'Jos' + u(0xe9)],
    ['fullwidth letters', u(0xff21) + 'lice', 'Alice'],
    ['case', 'ALICE', 'Alice'],
    // Re-audit 2, N1: plain-letter and other-script look-alikes.
    ['capital I for l', 'AIice', 'Alice'],
    ['digit 1 for l', 'A1ice', 'Alice'],
    ['bar for l', 'A|ice', 'Alice'],
    ['l for i', 'Allce', 'Alice'],
    ['Latin small capitals', u(0x1d00, 0x029f, 0x026a, 0x1d04, 0x1d07), 'Alice'],
    ['Latin alpha', u(0x0251) + 'lice', 'Alice'],
    ['Cherokee capitals', u(0x13aa, 0x13de, 0x13c6, 0x13df, 0x13ac), 'Alice'],
    ['Armenian oh', 'B' + u(0x0585) + 'b', 'Bob'],
    ['digit 0 for o', 'B0b', 'Bob'],
    ['rn for m', 'rnike', 'mike'],
    ['vv for w', 'Ovven', 'Owen'],
    ['Ian and lan (accepted trade-off)', 'lan', 'Ian'],
    ['Ian and ian (case still ignored)', 'ian', 'Ian'],
  ];
  for (const [label, joiner, existing] of cases) {
    it(label, () => {
      const name = uniqueName(clean(joiner), [clean(existing)]);
      expect(name.endsWith(' 2')).toBe(true);
    });
  }

  it('the name shown keeps what the player typed', () => {
    expect(uniqueName(clean('AIice'), ['Bob'])).toBe('AIice');
    expect(uniqueName(clean('Alic' + CYR_E), ['Bob'])).toBe('Alic' + CYR_E);
  });
});

describe('R3: blank and malformed names are refused', () => {
  const cases: [string, string][] = [
    ['Hangul filler', u(0x3164)],
    ['Hangul choseong filler', u(0x115f)],
    ['braille blank', u(0x2800, 0x2800)],
    ['lone high surrogate', 'A\uD800B'],
    ['lone low surrogate', 'A\uDC00'],
    ['only joiners', ZWJ + ZWNJ + ZWJ],
  ];
  for (const [label, raw] of cases) {
    it(label, () => expect(sanitizeName(raw)).toEqual({ ok: false }));
  }
});

describe('R3: mark stacks are bounded', () => {
  it(`at most ${TUNING.lobby.maxMarksPerGrapheme} marks per character`, () => {
    // 'q' has no precomposed accented form, so NFC leaves every mark separate.
    const name = clean('q' + ACUTE.repeat(900));
    expect(name).toBe('q' + ACUTE.repeat(TUNING.lobby.maxMarksPerGrapheme));
  });

  it(`every name is at most ${TUNING.lobby.maxNameUnits} UTF-16 units`, () => {
    const family = u(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466);
    for (const raw of [family.repeat(20), ('a' + ACUTE.repeat(4)).repeat(20), u(0x1f600).repeat(40)])
      expect(clean(raw).length).toBeLessThanOrEqual(TUNING.lobby.maxNameUnits);
  });
});

describe('R3: real names still work unchanged', () => {
  const ok: [string, string][] = [
    ['emoji ZWJ sequence', 'Dev' + u(0x1f469, 0x200d, 0x1f4bb)],
    ['flag', u(0x1f1f3, 0x1f1f1) + ' Joey'],
    ['Arabic', u(0x0633, 0x0627, 0x0631, 0x0629)],
    ['Hebrew', u(0x05d3, 0x05e0, 0x05d4)],
    ['Hindi', u(0x0905, 0x0928, 0x0941, 0x092a, 0x092e)],
    ['Persian with ZWNJ', u(0x0645, 0x06cc) + ZWNJ + u(0x062e, 0x0648, 0x0627, 0x0647, 0x0645)],
    ['accented Latin (NFC)', 'Jos' + u(0xe9)],
    ['Cyrillic name', u(0x0418, 0x0432, 0x0430, 0x043d)],
  ];
  for (const [label, raw] of ok) {
    it(label, () => expect(clean(raw)).toBe(raw));
  }

  it('NFD input is stored as NFC', () => {
    expect(clean('Jose' + ACUTE)).toBe('Jos' + u(0xe9));
  });

  it('two different real names never collide', () => {
    expect(uniqueName(clean('Bob'), [clean('Alice'), clean(u(0x0418, 0x0432, 0x0430, 0x043d))])).toBe('Bob');
    for (const [a, b] of [
      ['Ian', 'Ivan'],
      ['Alice', 'Alina'],
      ['Bob', 'Bobby'],
      ['Joey', 'Zoey'],
      ['Player 1', 'Player 7'],
    ])
      expect(uniqueName(a!, [b!])).toBe(a);
  });
});
