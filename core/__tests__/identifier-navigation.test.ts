/**
 * @vitest-environment jsdom
 */

import { expect, test, vi } from 'vite-plus/test';
import {
  applyIdentifierNavigationState,
  getIdentifierAtOffset,
  getIdentifierFromPointerEvent,
  isNavigableIdentifierToken,
} from '../lib/identifier-navigation.ts';
import { applySearchHighlights } from '../lib/search-highlights.ts';
import dunkelTheme from '../themes/dunkel.json' with { type: 'json' };

test('finds identifiers at either edge of the clicked token', () => {
  expect(getIdentifierAtOffset('return formatGreeting(name)', 8)).toEqual({
    identifier: 'formatGreeting',
    start: 7,
  });
  expect(getIdentifierAtOffset('return formatGreeting(name)', 20)?.identifier).toBe(
    'formatGreeting',
  );
  expect(getIdentifierAtOffset('return formatGreeting(name)', 6)).toBeNull();
});

test('uses a syntax-token element as a pointer lookup fallback', () => {
  const line = document.createElement('div');
  const token = document.createElement('span');
  token.textContent = 'formatGreeting';
  line.append('return ', token, '(name)');

  expect(
    getIdentifierFromPointerEvent(
      { clientX: 0, clientY: 0, target: token } as unknown as PointerEvent,
      line,
    ),
  ).toBe('formatGreeting');
});

test('only treats identifier-shaped non-keyword tokens as navigation candidates', () => {
  expect(isNavigableIdentifierToken('formatGreeting')).toBe(true);
  expect(isNavigableIdentifierToken('$value')).toBe(true);
  expect(isNavigableIdentifierToken('return')).toBe(false);
  expect(isNavigableIdentifierToken('name:')).toBe(false);
});

test('applies and clears the modifier affordance inside rendered diff shadow roots', () => {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const line = document.createElement('div');
  line.dataset.line = '1';
  const syntaxToken = document.createElement('span');
  syntaxToken.textContent = '  return formatGreeting(name).value;';
  const commentToken = document.createElement('span');
  commentToken.setAttribute(
    'style',
    `--diffs-token-dark:${dunkelTheme.style.syntax.comment.color}`,
  );
  commentToken.textContent = ' // do not navigate these words';
  line.append(syntaxToken, commentToken);
  root.append(line);

  applyIdentifierNavigationState([{ element: host }], true);
  expect(host.hasAttribute('data-codiff-definition-mode')).toBe(true);
  expect(
    Array.from(root.querySelectorAll<HTMLElement>('[data-codiff-identifier]')).map(
      (element) => element.textContent,
    ),
  ).toEqual(['formatGreeting', 'name', 'value']);
  expect(line.textContent).toBe(
    '  return formatGreeting(name).value; // do not navigate these words',
  );

  const identifier = root.querySelector('[data-codiff-identifier]');
  const text = identifier?.firstChild;
  if (!text) {
    throw new Error('Expected a navigable identifier.');
  }
  const range = document.createRange();
  range.selectNodeContents(text);

  applyIdentifierNavigationState([{ element: host }], false);
  expect(host.hasAttribute('data-codiff-definition-mode')).toBe(false);
  expect(root.querySelector('[data-codiff-identifier]')).toBe(identifier);
  expect(range.toString()).toBe('formatGreeting');
  expect(range.startContainer).toBe(text);
  expect(range.collapsed).toBe(false);

  applyIdentifierNavigationState([{ element: host }], true);
  applyIdentifierNavigationState([{ element: host }], true);
  expect(root.querySelector('[data-codiff-identifier]')).toBe(identifier);
  expect(identifier?.firstChild).toBe(text);
  expect(range.toString()).toBe('formatGreeting');
  expect(line.textContent).toBe(
    '  return formatGreeting(name).value; // do not navigate these words',
  );
});

test.each(['composed', 'shadow'] as const)(
  'preserves selected text reported by the %s selection API',
  (selectionAPI) => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const line = document.createElement('div');
    line.dataset.line = '1';
    const text = document.createTextNode('return formatGreeting(name);');
    line.append(text);
    root.append(line);
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 21);

    // Document selection can appear collapsed when text is in a shadow root.
    const collapsedRange = document.createRange();
    const selection = {
      getComposedRanges: () => (selectionAPI === 'composed' ? [range] : []),
      getRangeAt: () => collapsedRange,
      isCollapsed: true,
      rangeCount: 1,
      toString: () => '',
    } as unknown as Selection;
    using _selection = vi.spyOn(window, 'getSelection').mockReturnValue(selection);
    if (selectionAPI === 'shadow') {
      Object.defineProperty(root, 'getSelection', {
        value: () => ({
          getRangeAt: () => range,
          isCollapsed: range.collapsed,
          rangeCount: 1,
          toString: () => range.toString(),
        }),
      });
    }

    for (const active of [true, true, false]) {
      applyIdentifierNavigationState([{ element: host }], active);
      expect(host.hasAttribute('data-codiff-definition-mode')).toBe(false);
      expect(root.querySelector('[data-codiff-identifier]')).toBeNull();
      expect(line.firstChild).toBe(text);
      expect(range.toString()).toBe('formatGreeting');
      expect(range.startOffset).toBe(7);
      expect(range.endOffset).toBe(21);
    }

    range.collapse();
    applyIdentifierNavigationState([{ element: host }], true);
    expect(host.hasAttribute('data-codiff-definition-mode')).toBe(true);
    expect(root.querySelector('[data-codiff-identifier]')?.textContent).toBe('formatGreeting');
  },
);

test('searches across persistent identifier wrappers after releasing the modifier', () => {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const column = document.createElement('div');
  column.dataset.code = '';
  const line = document.createElement('div');
  line.dataset.line = '1';
  line.textContent = 'return formatGreeting(name);';
  column.append(line);
  root.append(column);
  const items = [{ element: host, id: 'file' }];

  applyIdentifierNavigationState(items, true);
  applyIdentifierNavigationState(items, false);
  applySearchHighlights(items, 'formatGreeting(name)', null);
  expect(root.querySelector('mark.codiff-search-mark')?.textContent).toBe('formatGreeting(name)');

  applySearchHighlights(items, '', null);
  applyIdentifierNavigationState(items, true);
  expect(root.querySelector('[data-codiff-identifier]')?.textContent).toBe('formatGreeting');
  expect(line.textContent).toBe('return formatGreeting(name);');
});
