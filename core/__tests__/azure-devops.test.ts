import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import type { PullRequestReviewComment, ReviewSource } from '../types.ts';
import { getGitTestEnvironment } from './helpers/git.ts';
import { createTemporaryDirectory, createTemporaryEnvironment } from './helpers/resources.ts';

const require = createRequire(import.meta.url);
const { AZ_NOT_FOUND_CODE, getAzCommand, getAzCommandTransport } =
  require('../../electron/git-state/azure-devops-api.cjs') as typeof import('../../electron/git-state/azure-devops-api.cjs');
const {
  createAzureDevOpsThreadContext,
  normalizeAzureDevOpsReviewComment,
  parseAzureDevOpsPullRequestUrl,
  readAzureDevOpsPullRequestState,
  readAzureDevOpsSectionContent,
  resolveAzureDevOpsContentRefs,
  submitAzureDevOpsComment,
  submitAzureDevOpsReview,
} =
  require('../../electron/git-state/azure-devops.cjs') as typeof import('../../electron/git-state/azure-devops.cjs');

const execFileAsync = promisify(execFile);

type AzCall = {
  args: ReadonlyArray<string>;
  body: string;
};

const withFakeAzureDevOps = async (
  callback: (repo: string, readCalls: () => Promise<ReadonlyArray<AzCall>>) => Promise<void>,
) => {
  await using directory = await createTemporaryDirectory('codiff-azure-devops-');
  const repo = join(directory.path, 'repo');
  const fakeAzPath = join(directory.path, 'az.cjs');
  const callsPath = join(directory.path, 'calls.jsonl');

  await execFileAsync('git', ['init', repo]);
  await execFileAsync('git', [
    '-C',
    repo,
    'remote',
    'add',
    'origin',
    'git@ssh.dev.azure.com:v3/mpc-tech-hub/MPCM/Dashboard',
  ]);
  await writeFile(
    fakeAzPath,
    `const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(1);
const uriIndex = args.indexOf('--uri');
const uri = uriIndex >= 0 ? args[uriIndex + 1] : '';
const methodIndex = args.indexOf('--method');
const method = (methodIndex >= 0 ? args[methodIndex + 1] : 'GET').toUpperCase();
const bodyIndex = args.indexOf('--body');
const bodyArgument = bodyIndex >= 0 ? args[bodyIndex + 1] : '';
const body = bodyArgument.startsWith('@') ? readFileSync(bodyArgument.slice(1), 'utf8') : bodyArgument;
appendFileSync(process.env.CODIFF_AZ_TEST_CALLS, JSON.stringify({ args, body }) + '\\n');
if (method === 'POST' && uri.includes('/threads/') && uri.includes('/comments')) {
  process.stdout.write(JSON.stringify({
    author: { displayName: 'Ada', uniqueName: 'ada@contoso.com' },
    commentType: 1,
    content: JSON.parse(body).content,
    id: 2,
    publishedDate: '2026-08-19T00:00:00Z',
  }));
  process.exit(0);
}
if (method === 'POST' && /\\/threads\\?/.test(uri)) {
  const payload = JSON.parse(body);
  process.stdout.write(JSON.stringify({
    comments: [{
      author: { displayName: 'Ada', uniqueName: 'ada@contoso.com' },
      commentType: 1,
      content: payload.comments[0].content,
      id: 1,
      publishedDate: '2026-08-19T00:00:00Z',
    }],
    id: 18,
    threadContext: payload.threadContext || null,
  }));
  process.exit(0);
}
if (uri.includes('/connectionData')) {
  process.stdout.write(JSON.stringify({ authenticatedUser: { id: 'user-1' } }));
  process.exit(0);
}
if (method === 'PUT' && uri.includes('/reviewers/')) {
  process.stdout.write(JSON.stringify({ id: 'user-1', vote: 10 }));
  process.exit(0);
}
if (uri.includes('/threads?')) {
  process.stdout.write(JSON.stringify({ value: [] }));
  process.exit(0);
}
if (uri.includes('/pullRequests/492?')) {
  process.stdout.write(process.env.CODIFF_AZ_TEST_METADATA || JSON.stringify({
    createdBy: { displayName: 'Ada' },
    lastMergeSourceCommit: { commitId: 'abc' },
    targetRefName: 'refs/heads/main',
    title: 'Add Azure DevOps reviews',
  }));
  process.exit(0);
}
process.stdout.write('{}');
process.exit(0);
`,
  );
  await chmod(fakeAzPath, 0o755);
  await using _environment = createTemporaryEnvironment({
    CODIFF_AZ_PATH: process.execPath,
    CODIFF_AZ_TEST_CALLS: callsPath,
    CODIFF_AZ_TEST_METADATA: undefined,
    NODE_OPTIONS: `--require=${JSON.stringify(fakeAzPath)}`,
    SHELL: undefined,
  });

  await callback(repo, async () =>
    (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AzCall),
  );
};

describe('Azure DevOps pull requests', { concurrent: false }, () => {
  test('parses cloud and visualstudio pull request URLs', () => {
    expect(
      parseAzureDevOpsPullRequestUrl(
        'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
      ),
    ).toMatchObject({
      host: 'dev.azure.com',
      number: 492,
      organization: 'mpc-tech-hub',
      project: 'MPCM',
      provider: 'azure-devops',
      repo: 'Dashboard',
    });
  });

  test('rejects incomplete or invalid PR commit metadata', async () => {
    await withFakeAzureDevOps(async (repo) => {
      const pr = parseAzureDevOpsPullRequestUrl(
        'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
      );
      await expect(resolveAzureDevOpsContentRefs(repo, pr, {})).rejects.toThrow(
        'source and target commits',
      );
      await expect(
        resolveAzureDevOpsContentRefs(repo, pr, {
          lastMergeSourceCommit: { commitId: '--upload-pack=bad' },
          lastMergeTargetCommit: { commitId: 'b'.repeat(40) },
        }),
      ).rejects.toThrow('source and target commits');
    });
  });

  test('launches Windows Azure CLI through bundled Python without a command shell', async () => {
    await using directory = await createTemporaryDirectory('codiff-az-windows-');
    const wbin = join(directory.path, 'wbin');
    await mkdir(wbin);
    const python = join(directory.path, 'python.exe');
    await writeFile(python, '');
    await chmod(python, 0o755);
    expect(getAzCommandTransport(join(wbin, 'az.cmd'), 'win32')).toEqual({
      args: ['-m', 'azure.cli'],
      command: join(wbin, '..', 'python.exe'),
    });
    expect(getAzCommandTransport(process.execPath, 'win32')).toEqual({
      args: [],
      command: process.execPath,
    });
  });

  test(
    'loads a checkout-independent PR snapshot and rejects a changed merge-base',
    { timeout: 20_000 },
    async () => {
      await withFakeAzureDevOps(async (repo, readCalls) => {
        const git = async (...args: ReadonlyArray<string>) =>
          (
            await execFileAsync('git', ['-C', repo, ...args], { env: getGitTestEnvironment() })
          ).stdout.trim();
        await writeFile(join(repo, 'base.txt'), 'base\n');
        await git('add', '.');
        await git('commit', '-m', 'base');
        const base = await git('rev-parse', 'HEAD');
        await git('checkout', '-b', 'feature');
        await writeFile(join(repo, 'new file.txt'), 'feature change\n');
        await mkdir(join(repo, 'tests'));
        await writeFile(join(repo, 'tests', 'check.txt'), 'nested feature change\n');
        await git('add', '.');
        await git('commit', '-m', 'feature');
        const head = await git('rev-parse', 'HEAD');
        await git('update-ref', 'refs/remotes/origin/feature', base);
        await git('checkout', '--detach', base);
        await writeFile(join(repo, 'requirements.txt'), 'target-only\n');
        await git('add', '.');
        await git('commit', '-m', 'target advanced');
        const target = await git('rev-parse', 'HEAD');
        await writeFile(join(repo, 'base.txt'), 'uncommitted local change\n');
        await using _metadata = createTemporaryEnvironment({
          CODIFF_AZ_TEST_METADATA: JSON.stringify({
            lastMergeSourceCommit: { commitId: head },
            lastMergeTargetCommit: { commitId: target },
            title: 'Review feature',
          }),
        });
        const url = 'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492';
        expect(
          await resolveAzureDevOpsContentRefs(repo, parseAzureDevOpsPullRequestUrl(url), {
            lastMergeSourceCommit: { commitId: head },
            lastMergeTargetCommit: { commitId: target },
          }),
        ).toEqual({ base, head });
        const state = await readAzureDevOpsPullRequestState(repo, { type: 'pull-request', url });
        if (state.source.type !== 'pull-request') {
          throw new Error('Expected a pull request snapshot.');
        }
        expect(state.files.map(({ path }) => path)).toEqual(['tests/check.txt', 'new file.txt']);
        for (const file of state.files) {
          expect(file.sections[0].patch).toContain(`diff --git a/${file.path} b/${file.path}`);
          expect(file.sections[0].patch).toContain(
            file.path === 'new file.txt' ? '+feature change' : '+nested feature change',
          );
          const section = await readAzureDevOpsSectionContent(repo, {
            force: true,
            kind: 'pull-request',
            path: file.path,
            source: state.source,
          });
          expect(section.patch).toBe(file.sections[0].patch);
          expect(section.id).toBe(file.sections[0].id);
        }
        expect(await git('rev-parse', 'HEAD')).toBe(target);
        expect(await readFile(join(repo, 'base.txt'), 'utf8')).toBe('uncommitted local change\n');
        await using _advancedTarget = createTemporaryEnvironment({
          CODIFF_AZ_TEST_METADATA: JSON.stringify({
            lastMergeSourceCommit: { commitId: head },
            lastMergeTargetCommit: { commitId: head },
            title: 'Review feature',
          }),
        });
        await expect(
          readAzureDevOpsSectionContent(repo, {
            kind: 'pull-request',
            path: state.files[0].path,
            source: state.source,
          }),
        ).rejects.toThrow('comparison base changed');
        await expect(
          submitAzureDevOpsReview(repo, {
            comments: [],
            event: 'APPROVE',
            source: state.source,
          }),
        ).rejects.toThrow('comparison base changed');
        expect(
          (await readCalls()).every(({ args }) => args[args.indexOf('--method') + 1] === 'GET'),
        ).toBe(true);
      });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'fetches missing PR objects without changing refs or FETCH_HEAD',
    async () => {
      await withFakeAzureDevOps(async (repo) => {
        const git = async (path: string, ...args: ReadonlyArray<string>) =>
          (
            await execFileAsync('git', ['-C', path, ...args], { env: getGitTestEnvironment() })
          ).stdout.trim();
        await writeFile(join(repo, 'base.txt'), 'base\n');
        await git(repo, 'add', '.');
        await git(repo, 'commit', '-m', 'base');
        const base = await git(repo, 'rev-parse', 'HEAD');
        await writeFile(join(repo, 'feature.txt'), 'feature\n');
        await git(repo, 'add', '.');
        await git(repo, 'commit', '-m', 'feature');
        const head = await git(repo, 'rev-parse', 'HEAD');
        const consumer = join(dirname(repo), 'consumer');
        await execFileAsync('git', ['init', consumer]);
        await git(consumer, 'remote', 'add', 'origin', 'git@ssh.dev.azure.com:v3/org/project/repo');
        const ssh = join(dirname(repo), 'ssh');
        await writeFile(ssh, '#!/bin/sh\nexec git upload-pack "$CODIFF_TEST_REMOTE"\n');
        await chmod(ssh, 0o755);
        const fetchHead = join(consumer, '.git', 'FETCH_HEAD');
        await writeFile(fetchHead, 'existing fetch marker\n');
        await using _transport = createTemporaryEnvironment({
          CODIFF_TEST_REMOTE: repo,
          GIT_SSH_COMMAND: `"${ssh}"`,
          GIT_SSH_VARIANT: 'ssh',
        });
        const pr = parseAzureDevOpsPullRequestUrl(
          'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
        );
        await expect(
          resolveAzureDevOpsContentRefs(consumer, pr, {
            lastMergeSourceCommit: { commitId: head },
            lastMergeTargetCommit: { commitId: base },
          }),
        ).resolves.toEqual({ base, head });
        expect(await git(consumer, 'for-each-ref')).toBe('');
        expect(await readFile(fetchHead, 'utf8')).toBe('existing fetch marker\n');
        await expect(git(consumer, 'rev-parse', '--verify', 'HEAD')).rejects.toThrow();
      });
    },
  );

  test('builds Azure DevOps thread positions for lines and files', () => {
    expect(
      createAzureDevOpsThreadContext({
        body: 'Comment',
        filePath: 'src/a.ts',
        lineNumber: 12,
        side: 'additions',
      }),
    ).toEqual({
      filePath: '/src/a.ts',
      rightFileEnd: { line: 12, offset: 1 },
      rightFileStart: { line: 12, offset: 1 },
    });
    expect(
      createAzureDevOpsThreadContext({
        body: 'Comment',
        filePath: 'src/a.ts',
        lineNumber: 8,
        side: 'deletions',
        startLineNumber: 6,
      }),
    ).toEqual({
      filePath: '/src/a.ts',
      leftFileEnd: { line: 8, offset: 1 },
      leftFileStart: { line: 6, offset: 1 },
    });
    expect(
      createAzureDevOpsThreadContext({
        anchor: 'file',
        body: 'Review the file.',
        filePath: 'src/a.ts',
      }),
    ).toEqual({ filePath: '/src/a.ts' });
  });

  test('normalizes Azure DevOps threads for the renderer', () => {
    expect(
      normalizeAzureDevOpsReviewComment(
        {
          author: { displayName: 'Ada', uniqueName: 'ada@contoso.com' },
          content: 'Please change this.',
          id: 1,
          publishedDate: '2026-08-19T00:00:00Z',
        },
        {
          id: 18,
          threadContext: {
            filePath: '/src/a.ts',
            rightFileEnd: { line: 12, offset: 1 },
            rightFileStart: { line: 12, offset: 1 },
          },
        },
        'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
      ),
    ).toMatchObject({
      author: { login: 'ada@contoso.com' },
      body: 'Please change this.',
      filePath: 'src/a.ts',
      id: 'azure-devops:18:1',
      lineNumber: 12,
      side: 'additions',
      threadId: '18',
      url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/42?discussionId=18',
    });
  });

  test('normalizes file-level Azure DevOps threads without line metadata', () => {
    expect(
      normalizeAzureDevOpsReviewComment(
        {
          author: { displayName: 'Ada' },
          content: 'Please review the file structure.',
          id: 2,
          publishedDate: '2026-08-19T00:00:00Z',
        },
        {
          id: 19,
          threadContext: { filePath: '/src/a.ts' },
        },
        'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
      ),
    ).toMatchObject({
      anchor: 'file',
      filePath: 'src/a.ts',
      id: 'azure-devops:19:2',
    });
  });

  test('resolves the Azure CLI from an explicit override', async () => {
    await using directory = await createTemporaryDirectory('codiff-az-command-');
    const fakeAz = join(directory.path, 'az');
    await writeFile(fakeAz, '#!/bin/sh\nexit 0\n');
    await chmod(fakeAz, 0o755);
    await using _environment = createTemporaryEnvironment({ CODIFF_AZ_PATH: fakeAz });
    expect(getAzCommand()).toBe(fakeAz);
  });

  test('rejects invalid explicit Azure CLI overrides', async () => {
    await using _environment = createTemporaryEnvironment({
      CODIFF_AZ_PATH: '/tmp/codiff-missing-az',
    });
    expect(() => getAzCommand()).toThrow('CODIFF_AZ_PATH');
    try {
      getAzCommand();
    } catch (error) {
      expect(error).toMatchObject({ code: AZ_NOT_FOUND_CODE });
    }
  });

  test.skipIf(process.platform !== 'win32')(
    'does not execute the MSI Unix shell script on Windows',
    async () => {
      await using directory = await createTemporaryDirectory('codiff-az-path-');
      await writeFile(join(directory.path, 'az'), '#!/bin/sh\n');
      await writeFile(join(directory.path, 'az.cmd'), '@echo off\n');
      await using _environment = createTemporaryEnvironment({
        CODIFF_AZ_PATH: undefined,
        PATH: directory.path,
      });
      expect(getAzCommand()).toBe(join(directory.path, 'az.cmd'));
    },
  );

  test('submits Azure DevOps comments and reviews through az rest', async () => {
    await withFakeAzureDevOps(async (repo, readCalls) => {
      const source: Extract<ReviewSource, { type: 'pull-request' }> = {
        provider: 'azure-devops',
        type: 'pull-request',
        url: 'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
      };

      await expect(
        submitAzureDevOpsComment(repo, {
          comment: {
            body: 'Keep this explicit.',
            filePath: 'src/a.ts',
            lineNumber: 12,
            side: 'additions',
          },
          source,
        }),
      ).resolves.toMatchObject({
        body: 'Keep this explicit.',
        filePath: 'src/a.ts',
        id: 'azure-devops:18:1',
        threadId: '18',
      });

      await submitAzureDevOpsReview(repo, {
        body: 'Looks good.',
        comments: [
          {
            body: 'Nit.',
            filePath: 'src/a.ts',
            lineNumber: 12,
            side: 'additions',
          },
        ],
        event: 'APPROVE',
        source,
      });

      const calls = await readCalls();
      const uris = calls.map((call) => call.args[call.args.indexOf('--uri') + 1]);
      expect(uris.some((uri) => uri.includes('/threads?'))).toBe(true);
      expect(uris.some((uri) => uri.includes('/reviewers/user-1'))).toBe(true);
      expect(
        calls.every((call) => call.args.includes('499b84ac-1321-427f-aa17-267ca6975798')),
      ).toBe(true);
    });
  });

  test('preserves long Unicode comment bodies and reply locations without a command shell', async () => {
    await withFakeAzureDevOps(async (repo, readCalls) => {
      const body = `Quotes " ' & | < > % ! \u2603\n${'x'.repeat(12_000)}`;
      const comment: PullRequestReviewComment = {
        body,
        filePath: 'src/a.ts',
        lineNumber: 12,
        side: 'additions',
        threadId: '18',
      };
      await expect(
        submitAzureDevOpsComment(repo, {
          comment,
          source: {
            type: 'pull-request',
            url: 'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
          },
        }),
      ).resolves.toMatchObject({ ...comment, id: 'azure-devops:18:2' });
      const [call] = await readCalls();
      expect(JSON.parse(call.body)).toEqual({ commentType: 1, content: body, parentCommentId: 1 });
      expect(call.args).toContain('--output');
      expect(call.args[call.args.indexOf('--body') + 1]).toMatch(/^@/);
    });
  });

  test('does not reset an existing vote when submitting a comment-only review', async () => {
    await withFakeAzureDevOps(async (repo, readCalls) => {
      await submitAzureDevOpsReview(repo, {
        body: 'Review notes.',
        comments: [],
        event: 'COMMENT',
        source: {
          type: 'pull-request',
          url: 'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
        },
      });
      const calls = await readCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].args[calls[0].args.indexOf('--uri') + 1]).toContain('/threads?');
    });
  });

  test('rejects new comments and votes when the reviewed PR head has changed', async () => {
    await withFakeAzureDevOps(async (repo, readCalls) => {
      const source: Extract<ReviewSource, { type: 'pull-request' }> = {
        headSha: 'a'.repeat(40),
        type: 'pull-request',
        url: 'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
      };
      await expect(
        submitAzureDevOpsComment(repo, {
          comment: { anchor: 'file', body: 'Comment.', filePath: 'src/a.ts' },
          source,
        }),
      ).rejects.toThrow('Refresh');
      await expect(
        submitAzureDevOpsReview(repo, {
          comments: [],
          event: 'APPROVE',
          source,
        }),
      ).rejects.toThrow('Refresh');
      expect(
        (await readCalls()).every(({ args }) => args[args.indexOf('--method') + 1] === 'GET'),
      ).toBe(true);
    });
  });

  test.skipIf(process.platform === 'win32')(
    'authenticates az from the login shell environment when the app inherited none',
    async () => {
      await using directory = await createTemporaryDirectory('codiff-az-login-env-');
      const repo = join(directory.path, 'repo');
      const fakeAz = join(directory.path, 'az');
      const fakeShell = join(directory.path, 'fake-login-shell');

      await execFileAsync('git', ['init', repo]);
      await execFileAsync('git', [
        '-C',
        repo,
        'remote',
        'add',
        'origin',
        'git@ssh.dev.azure.com:v3/mpc-tech-hub/MPCM/Dashboard',
      ]);

      await writeFile(
        fakeShell,
        `#!/bin/sh
AZURE_DEVOPS_EXT_PAT='from-login-shell' exec /bin/sh -c "$4"
`,
      );
      await writeFile(
        fakeAz,
        `#!/bin/sh
if [ "$AZURE_DEVOPS_EXT_PAT" != 'from-login-shell' ]; then
  echo 'Please run az login' >&2
  exit 1
fi
printf '%s' '{"authenticatedUser":{"id":"user-1"}}'
`,
      );
      await Promise.all([chmod(fakeShell, 0o755), chmod(fakeAz, 0o755)]);

      await using _environment = createTemporaryEnvironment({
        AZURE_DEVOPS_EXT_PAT: undefined,
        CODIFF_AZ_PATH: fakeAz,
        SHELL: fakeShell,
      });

      await submitAzureDevOpsReview(repo, {
        comments: [],
        event: 'REQUEST_CHANGES',
        source: {
          provider: 'azure-devops',
          type: 'pull-request',
          url: 'https://dev.azure.com/mpc-tech-hub/MPCM/_git/Dashboard/pullrequest/492',
        },
      });
    },
  );
});
