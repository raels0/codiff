import { expect, test } from 'vite-plus/test';
import dunkel from '../themes/dunkel.json' with { type: 'json' };
import licht from '../themes/licht.json' with { type: 'json' };

const rgb = (hex: string) =>
  [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));

const luminance = (color: ReadonlyArray<number>) => {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
};

test.each([
  {
    accents: ['#1f7a44', '#b8312f', '#1d5eaa', '#945200'],
    background: '#ffffff',
    theme: licht,
  },
  {
    accents: ['#6fd094', '#ee7e7e', '#75b8ff', '#e9b86b'],
    background: '#1c1c1c',
    theme: dunkel,
  },
])(
  '$theme.name syntax remains legible on neutral and both review palettes',
  ({ accents, background, theme }) => {
    const base = rgb(background);
    const backgrounds = [
      base,
      ...accents.map((accent) =>
        rgb(accent).map((value, index) => value * 0.08 + base[index]! * 0.92),
      ),
    ];
    for (const [token, style] of Object.entries(theme.style.syntax)) {
      for (const backdrop of backgrounds) {
        const levels = [luminance(rgb(style.color)), luminance(backdrop)].sort((a, b) => a - b);
        const contrast = (levels[1]! + 0.05) / (levels[0]! + 0.05);
        expect(contrast, `${theme.name} ${token} (${style.color})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  },
);
