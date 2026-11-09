/** @vitest-environment jsdom */
import {
  cloneFileDiffMetadata,
  DiffHunksRenderer,
  FileDiff,
  getSharedHighlighter,
  parseDiffFromFile,
  renderDiffWithHighlighter,
  type RenderDiffOptions,
} from '@pierre/diffs';
import { expect, test, vi } from 'vite-plus/test';
import { codeViewUnsafeCSS, workerHighlighterOptions } from '../lib/code-view-options.ts';
import { waitFor } from './helpers/react.tsx';

const createFixture = async () => {
  const highlighter = await getSharedHighlighter({ langs: ['tsx'], themes: ['github-dark'] });
  const diff = {
    ...parseDiffFromFile(
      { contents: 'const value = <div>old</div>;\n', name: 'source.tsx' },
      { contents: 'const value = <div>new</div>;\n', name: 'source.tsx' },
    ),
    cacheKey: 'original',
  };
  const options: RenderDiffOptions = {
    lineDiffType: 'word-alt',
    maxLineDiffLength: 2000,
    theme: 'github-dark',
    tokenizeMaxLineLength: 20_000,
    useTokenTransformer: true,
  };
  const result = { options, result: renderDiffWithHighlighter(diff, highlighter, options) };
  const cache = new Map([[diff.cacheKey, result]]);
  const worker = {
    cleanUpTasks: vi.fn(),
    evictDiffFromCache: vi.fn((key: string) => cache.delete(key)),
    getDiffRenderOptions: () => result.options,
    getDiffResultCache: (target: typeof diff) => cache.get(target.cacheKey),
    highlightDiffAST: vi.fn(),
    isWorkingPool: () => true,
    primeDiffHighlightCache: vi.fn(async (target: typeof diff) => {
      cache.set(target.cacheKey, result);
    }),
    shouldHighlightOnMainThread: () => false,
  };
  const renderer = new DiffHunksRenderer(
    {},
    undefined,
    undefined,
    worker as unknown as NonNullable<ConstructorParameters<typeof DiffHunksRenderer>[3]>,
  );
  return { cache, diff, renderer, result, worker };
};

test('highlighting an accepted edit uses its new worker cache key and preserves the original cache', async () => {
  const { cache, diff, renderer, result, worker } = await createFixture();
  renderer.hydrate(diff);
  const session = cloneFileDiffMetadata(diff);
  delete session.cacheKey;
  renderer.beginEditSession(session, diff);
  renderer.endEditSession();
  session.cacheKey = 'completed-edit';
  const localHighlight = vi.spyOn(renderer, 'asyncHighlight');
  try {
    await renderer.refreshHighlightedResult();
    expect(localHighlight).not.toHaveBeenCalled();
    expect(worker.primeDiffHighlightCache).toHaveBeenCalledOnce();
    const target = worker.primeDiffHighlightCache.mock.calls[0]![0];
    expect(target).toBe(session);
    expect(target.cacheKey).toBe('completed-edit');
    expect(cache.get(diff.cacheKey)).toBe(result);
    expect(cache.size).toBe(2);
  } finally {
    localHighlight.mockRestore();
    renderer.cleanUp();
  }
});

test('re-entering editing reuses the highlighted replacement diff', async () => {
  const { cache, diff, renderer, result } = await createFixture();
  renderer.hydrate(diff);
  const next = { ...diff, cacheKey: 'next' };
  cache.set(next.cacheKey, result);
  renderer.renderDiff(next);
  const session = cloneFileDiffMetadata(next);
  delete session.cacheKey;
  const localHighlight = vi.spyOn(renderer, 'renderDiffWithHighlighter');
  try {
    renderer.beginEditSession(session, next);
    expect(renderer.editorRenderReady()).toBe(true);
    renderer.renderDiff(session);
    expect(localHighlight).not.toHaveBeenCalled();
    expect(cache.get(next.cacheKey)).toBe(result);
  } finally {
    localHighlight.mockRestore();
    renderer.cleanUp();
  }
});

const renderInlineWords = async (before: string | null, after: string | null) => {
  const container = document.createElement('div');
  document.body.append(container);
  const renderer = new FileDiff({
    ...workerHighlighterOptions,
    theme: 'Dunkel',
    themeType: 'dark',
    unsafeCSS: codeViewUnsafeCSS,
  });
  try {
    renderer.render({
      containerWrapper: container,
      fileDiff: parseDiffFromFile(
        before == null ? null : { contents: before, name: 'source.txt' },
        after == null ? null : { contents: after, name: 'source.txt' },
      ),
    });
    await waitFor(() =>
      expect(container.firstElementChild?.shadowRoot?.querySelector('[data-line]')).toBeTruthy(),
    );
    const root = container.firstElementChild!.shadowRoot!;
    const words = (type: string) =>
      Array.from(root.querySelectorAll(`[data-line-type="${type}"] [data-diff-span]`)).map(
        (element) => element.textContent,
      );
    return { additions: words('change-addition'), deletions: words('change-deletion') };
  } finally {
    renderer.cleanUp();
    container.remove();
  }
};

test('inline edits emphasize changed words, not the surrounding expression', async () => {
  expect(
    await renderInlineWords(
      'const result = cache.lookup(key);\n',
      'const result = store.lookup(key);\n',
    ),
  ).toEqual({ additions: ['store'], deletions: ['cache'] });
  expect(
    await renderInlineWords(
      'return original(before, stableArgument);\n',
      'return updated(after, stableArgument);\n',
    ),
  ).toEqual({ additions: ['updated', 'after'], deletions: ['original', 'before'] });
});

test.each([
  [null, 'startBatch();\ncollectJobs();\nfinishBatch();\n'],
  ['startBatch();\ncollectJobs();\nfinishBatch();\n', null],
  ['const stable = 1;\n', 'const stable = 1;\nstartBatch();\ncollectJobs();\nfinishBatch();\n'],
])('whole added/deleted blocks remain gutter-only (%#)', async (before, after) => {
  expect(await renderInlineWords(before, after)).toEqual({ additions: [], deletions: [] });
});
