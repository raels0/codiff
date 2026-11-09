import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import type { ReviewAssistantResult } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { readReviewAssistantReply } = require('../review-assist.cjs') as {
  readReviewAssistantReply: (
    state: unknown,
    request: unknown,
    agent: unknown,
    options: unknown,
  ) => Promise<ReviewAssistantResult>;
};
const answer = { reply: 'Use the shared helper.', requests: [], version: 1 };
type Run = (
  root: string,
  prompt: string,
  schema: unknown,
  outputName?: string,
  timeoutMessage?: string,
  options?: { timeoutMs?: number },
) => Promise<string>;
const request = {
  comment: {
    body: 'How do these changes work together?',
    filePath: 'selected.ts',
    sectionId: 'selected',
    lineNumber: 1,
    side: 'additions',
  },
};
const file = (path: string, patch: string) => ({
  path,
  sections: [{ binary: false, id: path, kind: 'pull-request', patch }],
  status: 'modified',
});
const state = (files = [file('selected.ts', '+const value = shared();')]) => ({
  files,
  root: '/repo',
  source: { type: 'working-tree' },
});
const agent = (run: Run) => ({
  defaultTimeoutMs: 300_000,
  isNotFoundError: () => false,
  label: 'Codex',
  notFoundCode: 'CODEX_NOT_FOUND',
  run,
});
const read = async (input = state(), response: unknown = answer, question: unknown = request) => {
  const run = vi.fn<Run>().mockResolvedValue(JSON.stringify(response));
  const result = await readReviewAssistantReply(input, question, agent(run), {});
  return { prompt: run.mock.calls[0]?.[1] as string, result, run };
};
const requestMore = (view: string, path: string, startLine = 1, search = '') => ({
  reply: '',
  requests: [{ path, search, startLine, view }],
  version: 1,
});
const repositories: string[] = [];
afterEach(() => {
  for (const root of repositories.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('asks the actual question using changes across the review, including files beyond forty', async () => {
  const files = Array.from({ length: 75 }, (_, index) =>
    file(`file-${index}.ts`, `+relatedChange${index}();`),
  );
  const { prompt, result } = await read(
    state([file('selected.ts', '+const value = shared();'), ...files]),
  );
  expect(result.status).toBe('ready');
  expect(prompt).toContain('# Reviewer’s question\n\nHow do these changes work together?');
  expect(prompt).toContain('# Selected location\n\nselected.ts:1–1 (additions)');
  expect(prompt).toContain('relatedChange74();');
  expect(prompt).toContain('not limit which parts of the review');
  expect(prompt).toContain('Only suggest wording for a review comment if asked.');
  expect(prompt).not.toContain('180 words');
  expect(result.context).toMatchObject({ fileCount: 76, filesRead: 76, warnings: [] });
});

test('does not invent a line for a file-level question and preserves answer Markdown', async () => {
  const { prompt, result } = await read(
    state(),
    {
      ...answer,
      reply: '  See both files.\n\n\n- **Caller**\n- Helper  ',
    },
    {
      comment: {
        anchor: 'file',
        body: 'Explain this file.',
        filePath: 'selected.ts',
        sectionId: 'selected',
      },
    },
  );
  expect(prompt).toContain('# Selected location\n\nselected.ts\n');
  expect(result).toMatchObject({
    reply: 'See both files.\n\n- **Caller**\n- Helper',
    status: 'ready',
  });
});

test('preserves replacement-string characters in code supplied to the readable prompt', async () => {
  const patch = `+value.replace(pattern, "$& $$ $' $\`");`;
  const { prompt } = await read(state([file('selected.ts', patch)]));
  expect(prompt).toContain(patch);
  expect(prompt).not.toContain('{{REVIEW_MATERIAL}}');
});

test('treats descriptions as intent and visibly discloses shortened material', async () => {
  const run = vi.fn<Run>().mockResolvedValue(JSON.stringify(answer));
  const result = await readReviewAssistantReply(
    {
      ...state(),
      source: {
        description: `${'A'.repeat(6100)}HIDDEN_TAIL`,
        type: 'pull-request',
        url: 'https://github.com/example/repo/pull/42',
      },
    },
    request,
    agent(run),
    {},
  );
  const prompt = run.mock.calls[0]?.[1] as string;
  expect(prompt).toContain('not proof that the code');
  expect(prompt).toContain('[Description shortened for length.]');
  expect(prompt).not.toContain('HIDDEN_TAIL');
  expect(result.context?.warnings).toContain('The PR description was shortened for length.');
});

test('retrieves omitted changes, source lines, and the rest of a large file list', async () => {
  const files = Array.from({ length: 250 }, (_, index) =>
    file(`file-${index}.ts`, `+change${index}();`),
  );
  const large = Array.from({ length: 1000 }, (_, index) => `+line${index} ${'x'.repeat(100)}`).join(
    '\n',
  );
  const input = state([file('selected.ts', large), ...files]);
  const run = vi
    .fn<Run>()
    .mockResolvedValueOnce(
      JSON.stringify({
        reply: '',
        requests: [
          { path: '', search: '', startLine: 200, view: 'files' },
          { path: 'selected.ts', search: '', startLine: 900, view: 'changes' },
          { path: '', search: 'change249', startLine: 201, view: 'changes' },
        ],
        version: 1,
      }),
    )
    .mockResolvedValueOnce(JSON.stringify(answer));
  const result = await readReviewAssistantReply(input, request, agent(run), {});
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[0][1]).not.toContain('+line899 ');
  expect(run.mock.calls[1][1]).toContain('+line899 ');
  expect(run.mock.calls[1][1]).toContain('file-249.ts');
  expect(run.mock.calls[1][1]).toContain('+change249();');
  expect(result.status).toBe('ready');
  expect(result.context?.warnings.length).toBeGreaterThan(0);
});

test('keeps the selected lines in view when a large patch needs paging', async () => {
  const patch = [
    'diff --git a/selected.ts b/selected.ts',
    '--- a/selected.ts',
    '+++ b/selected.ts',
    '@@ -1 +1,1000 @@',
    '-oldValue',
    ...Array.from({ length: 1000 }, (_, index) => `+line${index} ${'x'.repeat(100)}`),
  ].join('\n');
  const { prompt, result } = await read(state([file('selected.ts', patch)]), answer, {
    comment: { ...request.comment, lineNumber: 900 },
  });
  expect(result.status).toBe('ready');
  expect(prompt).toContain('+line899 ');
  expect(prompt).not.toContain('+line1 ');
});

test('keeps additional context reads bounded and does not invent an answer on failure', async () => {
  const run = vi.fn<Run>().mockResolvedValue(JSON.stringify(requestMore('changes', 'selected.ts')));
  const result = await readReviewAssistantReply(state(), request, agent(run), {
    timeoutMs: 20_000,
  });
  expect(run).toHaveBeenCalledTimes(4);
  expect(result).toMatchObject({
    reason: expect.stringContaining('Ask a narrower question'),
    status: 'unavailable',
  });
  for (const call of run.mock.calls) expect(call[5]?.timeoutMs).toBeLessThanOrEqual(20_000);
});

test.each([
  { text: 'raw model text', version: 1 },
  { reply: '', requests: [], version: 1 },
  requestMore('shell', 'selected.ts'),
  requestMore('changes', 'selected.ts', 0),
])('reports malformed replies and invalid reads as errors: %j', async (response) => {
  const { result } = await read(state(), response);
  expect(result.status).toBe('unavailable');
  expect('reply' in result).toBe(false);
});

test('uses pinned commits and the actual Git file list without reading a dirty, unrelated checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codiff-review-assist-'));
  repositories.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'selected.ts'), 'oldValue();\n');
  writeFileSync(join(root, 'old.ts'), 'renameMe();\n');
  writeFileSync(join(root, 'helper.ts'), 'export const shared = "UNCHANGED_HELPER";\n');
  writeFileSync(join(root, 'removed.ts'), 'removedValue();\n');
  git('add', '.');
  git('commit', '-qm', 'Before');
  const baseSha = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'selected.ts'), 'newValue(shared());\n');
  git('mv', 'old.ts', 'renamed.ts');
  git('rm', '-q', 'removed.ts');
  git('add', '.');
  git('commit', '-qm', 'After');
  const headSha = git('rev-parse', 'HEAD');
  git('checkout', '-q', baseSha);
  writeFileSync(join(root, 'selected.ts'), 'WRONG_DIRTY_CHECKOUT\n');
  writeFileSync(join(root, 'helper.ts'), 'WRONG_DIRTY_HELPER\n');
  const source = {
    baseSha,
    headSha,
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/42',
  };
  const input = { ...state([file('selected.ts', '+WRONG_API_PATCH')]), root, source };
  const run = vi
    .fn<Run>()
    .mockResolvedValueOnce(
      JSON.stringify({
        reply: '',
        requests: [
          { path: 'helper.ts', search: '', startLine: 1, view: 'after' },
          { path: 'renamed.ts', search: '', startLine: 1, view: 'before' },
          { path: 'removed.ts', search: '', startLine: 1, view: 'after' },
          { path: '..\\outside.txt', search: '', startLine: 1, view: 'before' },
        ],
        version: 1,
      }),
    )
    .mockResolvedValueOnce(JSON.stringify(answer));
  const result = await readReviewAssistantReply(input, { ...request, source }, agent(run), {});
  const prompt = run.mock.calls[1][1];
  expect(prompt).toContain('+newValue(shared());');
  expect(prompt).toContain('UNCHANGED_HELPER');
  expect(prompt).toContain('renameMe();');
  expect(prompt).toContain('removed.ts');
  expect(prompt).not.toContain('WRONG_');
  expect(result.context).toMatchObject({ fileCount: 3, filesRead: 3 });
  expect(result.context?.warnings.join('\n')).toContain('absent');
  expect(result.context?.warnings.join('\n')).toContain('Invalid repository path');
  expect(git('diff')).toContain('WRONG_DIRTY_CHECKOUT');
  expect(result.status).toBe('ready');
});

test('rejects changed PR commits before asking the assistant', async () => {
  const run = vi.fn<Run>();
  const source = {
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/42',
  };
  const result = await readReviewAssistantReply(
    { ...state(), source },
    {
      ...request,
      source: { ...source, headSha: 'c'.repeat(40) },
    },
    agent(run),
    {},
  );
  expect(run).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    reason: expect.stringContaining('Refresh'),
    status: 'unavailable',
  });
});
