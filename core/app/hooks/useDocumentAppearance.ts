import { useEffect } from 'react';
import type { CodiffReviewTheme } from '../../config/types.ts';
import type { CodiffPreferences } from '../../types.ts';

export const CODE_FONT_SIZE_DEFAULT = 13;
const CODE_FONT_SIZE_MAX = 32;
const CODE_FONT_SIZE_MIN = 10;

export const normalizeCodeFontSizePreference = (size: number) =>
  Number.isFinite(size)
    ? Math.min(CODE_FONT_SIZE_MAX, Math.max(CODE_FONT_SIZE_MIN, Math.round(size)))
    : CODE_FONT_SIZE_DEFAULT;

export const getCodeFontLineHeight = (size: number) => Math.round((size * 20) / 13);

type UseDocumentAppearanceOptions = Pick<
  CodiffPreferences,
  'codeFontFamily' | 'codeFontSize' | 'theme'
> & {
  cleanupCodeFontProperties?: boolean;
  clearEmptyCodeFontFamily?: boolean;
  reviewTheme?: CodiffReviewTheme;
};

export function useDocumentAppearance({
  cleanupCodeFontProperties = false,
  clearEmptyCodeFontFamily = false,
  codeFontFamily,
  codeFontSize,
  reviewTheme = 'neutral',
  theme,
}: UseDocumentAppearanceOptions) {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-review-theme', reviewTheme);
    return () => {
      root.removeAttribute('data-review-theme');
    };
  }, [reviewTheme]);

  useEffect(() => {
    const root = document.documentElement;
    const normalizedCodeFontFamily = codeFontFamily.trim();
    const normalizedCodeFontSize = normalizeCodeFontSizePreference(codeFontSize);

    if (normalizedCodeFontFamily) {
      root.style.setProperty(
        '--font-diff-mono',
        `${JSON.stringify(normalizedCodeFontFamily)}, monospace`,
      );
    } else if (clearEmptyCodeFontFamily) {
      root.style.removeProperty('--font-diff-mono');
    }

    root.style.setProperty('--font-diff-size', `${normalizedCodeFontSize}px`);
    root.style.setProperty(
      '--font-diff-line-height',
      `${getCodeFontLineHeight(normalizedCodeFontSize)}px`,
    );

    if (!cleanupCodeFontProperties) {
      return;
    }

    return () => {
      root.style.removeProperty('--font-diff-mono');
      root.style.removeProperty('--font-diff-size');
      root.style.removeProperty('--font-diff-line-height');
    };
  }, [cleanupCodeFontProperties, clearEmptyCodeFontFamily, codeFontFamily, codeFontSize]);
}
