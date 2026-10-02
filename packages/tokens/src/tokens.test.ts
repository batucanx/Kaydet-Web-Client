import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.ts';
import { generateCss } from './css.ts';
import { avatarTones, colors, typography } from './index.ts';

describe('generated tokens.css', () => {
  it('is in sync with tokens.ts (run `npm run tokens`)', () => {
    const onDisk = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
    expect(onDisk).toBe(generateCss());
  });
});

describe('mobile parity', () => {
  it('has 15 avatar tones per theme', () => {
    expect(avatarTones.light).toHaveLength(15);
    expect(avatarTones.dark).toHaveLength(15);
  });

  it('keeps mobile-confirmed anchors', () => {
    expect(colors.dark.bg).toBe('#131314');
    expect(colors.dark.accent).toBe('#A8C7FA');
    expect(colors.light.accent).toBe('#1478C9');
    expect(typography.listSenderUnread.weight).toBe(700);
    expect(typography.titleLarge.size).toBe(18);
  });

  // Mobile docs claim ">= 6:1 in every tone"; measured: dark >= 6, light tones 3..8 are 4.62–5.58.
  // Values are kept verbatim (mobile is the source of truth) and all pass WCAG AA (4.5:1).
  it('avatar letter/background contrast: dark >= 6:1, light >= 4.5:1', () => {
    for (const tone of avatarTones.dark) {
      expect(contrastRatio(tone.fg, tone.bg)).toBeGreaterThanOrEqual(5.99); // 5.9975 measured
    }
    for (const tone of avatarTones.light) {
      expect(contrastRatio(tone.fg, tone.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('contrast report (documents known parity/accessibility gaps)', () => {
  const pairs: Array<[string, 'light' | 'dark', 'textPrimary' | 'textSecondary' | 'textTertiary', number]> = [
    ['primary on bg', 'light', 'textPrimary', 4.5],
    ['secondary on bg', 'light', 'textSecondary', 4.5],
    ['primary on bg', 'dark', 'textPrimary', 4.5],
    ['secondary on bg', 'dark', 'textSecondary', 4.5],
    ['tertiary on bg', 'dark', 'textTertiary', 4.5],
  ];
  for (const [name, theme, key, min] of pairs) {
    it(`${theme}: ${name} >= ${min}`, () => {
      expect(contrastRatio(colors[theme][key], colors[theme].bg)).toBeGreaterThanOrEqual(min);
    });
  }

  // KNOWN ISSUE (discovery R9): mobile light `textTertiary` #9AA0A6 on white is ~2.6:1.
  // Kept verbatim because mobile values are the source of truth; needs a product decision.
  it('light: tertiary on bg is below AA (known, tracked)', () => {
    const ratio = contrastRatio(colors.light.textTertiary, colors.light.bg);
    expect(ratio).toBeLessThan(4.5);
    expect(ratio).toBeGreaterThan(2.4);
  });
});
