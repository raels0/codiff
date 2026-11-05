// @ts-check

const { execFile } = require('node:child_process');
const { promises: fs } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { promisify } = require('node:util');
const { findExecutableOnPath, isExecutableFile } = require('../agent-shared.cjs');
const { getCommandEnvironment } = require('../login-shell-environment.cjs');

/**
 * @typedef {{id?: string; displayName?: string; uniqueName?: string; imageUrl?: string; url?: string; _links?: {web?: {href?: string}}}} AzureIdentity
 * @typedef {{commitId: string}} AzureCommitReference
 * @typedef {{
 *   createdBy?: AzureIdentity;
 *   description?: string;
 *   forkSource?: {repository?: {remoteUrl?: string}};
 *   isDraft?: boolean;
 *   lastMergeSourceCommit?: AzureCommitReference;
 *   lastMergeTargetCommit?: AzureCommitReference;
 *   reviewers?: Array<AzureIdentity & {vote?: number}>;
 *   status?: string;
 *   title?: string;
 * }} AzurePullRequest
 * @typedef {{line: number; offset?: number}} AzurePosition
 * @typedef {{filePath?: string; leftFileStart?: AzurePosition; leftFileEnd?: AzurePosition; rightFileStart?: AzurePosition; rightFileEnd?: AzurePosition}} AzureThreadContext
 * @typedef {{id: number; author?: AzureIdentity; commentType?: string | number; content?: string; isDeleted?: boolean; publishedDate?: string; lastContentUpdatedDate?: string}} AzureComment
 * @typedef {{id: number; status?: string | number; isDeleted?: boolean; comments?: Array<AzureComment>; threadContext?: AzureThreadContext}} AzureThread
 * @typedef {Extract<NonNullable<ReturnType<import('../review-source.cjs').parseReviewUrl>>, {provider: 'azure-devops'}>} AzurePullRequestReference
 */

const execFileAsync = promisify(execFile);
const AZURE_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const API_VERSION = '7.1';
const AZ_NOT_FOUND_CODE = 'AZ_NOT_FOUND';

/** @param {string} [detail] */
const missingAzureCli = (detail = '') =>
  Object.assign(
    new Error(
      `Azure DevOps support requires the Azure CLI. Install it, run \`az login\`, and ensure \`az --version\` works. Use CODIFF_AZ_PATH for a non-PATH installation. ${detail}`.trim(),
    ),
    { code: AZ_NOT_FOUND_CODE },
  );

const getAzCommand = () => {
  const override = process.env.CODIFF_AZ_PATH?.trim();
  if (override) {
    if (!isExecutableFile(override)) {
      throw missingAzureCli(`CODIFF_AZ_PATH is not executable: ${override}`);
    }
    return override;
  }
  const command =
    (process.platform === 'win32'
      ? ['az.exe', 'az.cmd', 'az.bat'].map(findExecutableOnPath).find(Boolean)
      : findExecutableOnPath('az')) ||
    [join(homedir(), '.local', 'bin', 'az'), '/opt/homebrew/bin/az', '/usr/local/bin/az'].find(
      isExecutableFile,
    );
  if (!command) {
    throw missingAzureCli();
  }
  return command;
};

/** @param {string} command @param {string} [platform] */
const getAzCommandTransport = (command, platform = process.platform) => {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args: [] };
  }
  // The MSI's az.cmd wraps Python. Invoke that interpreter directly, never a shell.
  const python = join(dirname(command), '..', 'python.exe');
  if (!isExecutableFile(python)) {
    throw missingAzureCli('The Azure CLI installation is missing its bundled python.exe.');
  }
  return { command: python, args: ['-m', 'azure.cli'] };
};

/**
 * Keep authentication, Windows launch rules, and request serialization out of the Git layer.
 * @param {string} repoRoot
 * @param {AzurePullRequestReference} pullRequest
 */
const createAzureDevOpsClient = (repoRoot, pullRequest) => {
  const endpoint = `${pullRequest.apiBase}/_apis/git/repositories/${encodeURIComponent(pullRequest.repo)}/pullRequests/${pullRequest.number}`;

  /**
   * @template T
   * @param {string} uri
   * @param {string} [method]
   * @param {unknown} [body]
   * @returns {Promise<T>}
   */
  const request = async (uri, method = 'GET', body) => {
    const transport = getAzCommandTransport(getAzCommand());
    const directory = body == null ? null : await fs.mkdtemp(join(tmpdir(), 'codiff-az-'));
    try {
      const bodyPath = directory ? join(directory, 'body.json') : null;
      if (bodyPath) {
        await fs.writeFile(bodyPath, JSON.stringify(body), { mode: 0o600 });
      }
      const { stdout } = await execFileAsync(
        transport.command,
        [
          ...transport.args,
          'rest',
          '--method',
          method,
          '--uri',
          uri,
          '--resource',
          AZURE_RESOURCE,
          '--output',
          'json',
          '--only-show-errors',
          ...(bodyPath
            ? ['--headers', 'Content-Type=application/json', '--body', `@${bodyPath}`]
            : []),
        ],
        {
          cwd: repoRoot,
          env: await getCommandEnvironment(),
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120_000,
          windowsHide: true,
        },
      );
      if (!stdout.trim()) {
        throw new Error(`Azure DevOps returned an empty response to ${method}.`);
      }
      return JSON.parse(stdout);
    } finally {
      if (directory) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  };

  /** @param {string} [suffix] @param {string} [query] */
  const url = (suffix = '', query = '') =>
    `${endpoint}${suffix}?api-version=${API_VERSION}${query ? `&${query}` : ''}`;

  /**
   * @template T
   * @param {string} suffix
   * @param {string} [query]
   * @returns {Promise<Array<T>>}
   */
  const collection = async (suffix, query) => {
    /** @type {{value?: Array<T>}} */
    const payload = await request(url(suffix, query));
    if (!Array.isArray(payload?.value)) {
      throw new Error(`Azure DevOps did not return ${suffix.slice(1)} for this pull request.`);
    }
    return payload.value;
  };

  return {
    /** @returns {Promise<AzurePullRequest>} */
    metadata: async () => {
      /** @type {AzurePullRequest} */
      const metadata = await request(url());
      if (!metadata || typeof metadata !== 'object') {
        throw new Error('Azure DevOps did not return pull request metadata.');
      }
      return metadata;
    },
    /** @returns {Promise<Array<AzureThread>>} */
    threads: () => collection('/threads'),
    /** @param {unknown} body @returns {Promise<AzureThread>} */
    createThread: (body) => request(url('/threads'), 'POST', body),
    /** @param {string} threadId @param {string} content @returns {Promise<AzureComment>} */
    reply: (threadId, content) =>
      request(url(`/threads/${encodeURIComponent(threadId)}/comments`), 'POST', {
        commentType: 1,
        content,
        parentCommentId: 1,
      }),
    /** @param {number} vote */
    vote: async (vote) => {
      /** @type {{authenticatedUser?: AzureIdentity}} */
      const connection = await request(
        `${pullRequest.organizationUrl}/_apis/connectionData?api-version=${API_VERSION}`,
      );
      const id = connection?.authenticatedUser?.id;
      if (typeof id !== 'string' || !id) {
        throw new Error(
          'Azure DevOps did not return the signed-in user needed to vote on a review.',
        );
      }
      await request(url(`/reviewers/${encodeURIComponent(id)}`), 'PUT', { id, vote });
    },
  };
};

module.exports = {
  AZ_NOT_FOUND_CODE,
  createAzureDevOpsClient,
  getAzCommand,
  getAzCommandTransport,
};
