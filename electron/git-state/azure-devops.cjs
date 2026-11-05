// @ts-check

const { git, gitOrEmpty } = require('./common.cjs');
const { listRepositoryHistory, parseCommitNameStatus } = require('./commit.cjs');
const {
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonState,
} = require('./comparison.cjs');
const { createAzureDevOpsClient } = require('./azure-devops-api.cjs');
const { parseRemoteUrl, parseReviewUrl, readReviewRemotes } = require('../review-source.cjs');

/**
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../core/types.ts').SubmitPullRequestCommentRequest} SubmitPullRequestCommentRequest
 * @typedef {import('../../core/types.ts').SubmitPullRequestReviewRequest} SubmitPullRequestReviewRequest
 * @typedef {import('./azure-devops-api.cjs').AzureIdentity} AzureIdentity
 * @typedef {import('./azure-devops-api.cjs').AzurePullRequest} AzurePullRequest
 * @typedef {import('./azure-devops-api.cjs').AzureThread} AzureThread
 * @typedef {import('./azure-devops-api.cjs').AzureComment} AzureComment
 * @typedef {Extract<ReviewSource, {type: 'pull-request'}>} PullRequestSource
 */

/** @param {string} value */
const parseAzureDevOpsPullRequestUrl = (value) => {
  const parsed = parseReviewUrl(value);
  if (!parsed || parsed.provider !== 'azure-devops') {
    throw new Error('Codiff expected an Azure DevOps Services pull request URL.');
  }
  return parsed;
};

/** @param {string} repoRoot @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pr */
const selectRemote = (repoRoot, pr) => {
  const remote = readReviewRemotes(repoRoot).find(
    (candidate) =>
      candidate.direction === 'fetch' &&
      candidate.provider === 'azure-devops' &&
      candidate.projectPath.toLowerCase() === pr.projectPath.toLowerCase(),
  );
  if (!remote) {
    throw new Error(
      `PR ${pr.projectPath}#${pr.number} does not match an Azure DevOps remote in this repository. Open its repository first.`,
    );
  }
  return remote;
};

/** @param {AzurePullRequest} metadata */
const commitRefs = (metadata) => {
  const head = metadata.lastMergeSourceCommit?.commitId;
  const target = metadata.lastMergeTargetCommit?.commitId;
  const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
  if (
    typeof head !== 'string' ||
    !sha.test(head) ||
    typeof target !== 'string' ||
    !sha.test(target)
  ) {
    throw new Error(
      'Azure DevOps has not supplied valid PR source and target commits. Refresh after its merge evaluation completes.',
    );
  }
  return { head, target };
};

/**
 * Fetch objects only: do not switch branches, update tracking refs, or overwrite FETCH_HEAD.
 * Azure exposes a synthetic merge ref, not GitHub's refs/pull/<id>/head.
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pr
 * @param {AzurePullRequest} metadata
 */
const resolveAzureDevOpsContentRefs = async (repoRoot, pr, metadata) => {
  const remote = selectRemote(repoRoot, pr);
  const { head, target } = commitRefs(metadata);
  const fork = metadata.forkSource?.repository?.remoteUrl;
  if (fork && parseRemoteUrl(fork)?.provider !== 'azure-devops') {
    throw new Error('Azure DevOps returned an unsupported source repository URL.');
  }
  for (const [sha, source] of [
    [head, fork || remote.name],
    [target, remote.name],
  ]) {
    if (
      !(await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])).trim()
    ) {
      await git(repoRoot, ['fetch', '--no-tags', '--no-write-fetch-head', '--', source, sha]);
    }
  }
  return { base: (await git(repoRoot, ['merge-base', target, head])).trim(), head };
};

/** @param {AzureIdentity | undefined} author */
const normalizeAuthor = (author) => ({
  avatarUrl: author?.imageUrl,
  login: author?.uniqueName || author?.displayName || 'Azure DevOps user',
  url: author?._links?.web?.href || author?.url,
});

/** @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pr @param {AzurePullRequest} metadata @param {string} baseSha @returns {PullRequestSource} */
const createSource = (pr, metadata, baseSha) => ({
  author: normalizeAuthor(metadata.createdBy),
  baseSha,
  canEditDescription: false,
  canEditReviewers: false,
  canEditTitle: false,
  description: metadata.description?.trim(),
  draft: metadata.isDraft,
  headSha: metadata.lastMergeSourceCommit?.commitId,
  host: pr.host,
  number: pr.number,
  owner: pr.organization,
  projectPath: pr.projectPath,
  provider: 'azure-devops',
  repo: pr.repo,
  reviewers: metadata.reviewers?.map((reviewer) => {
    if (!reviewer.id) {
      throw new Error('Azure DevOps returned a reviewer without an identity.');
    }
    return { ...normalizeAuthor(reviewer), approved: (reviewer.vote || 0) > 0, id: reviewer.id };
  }),
  reviewStatus: {
    close: { disabled: true, reason: 'Close this pull request in Azure DevOps.' },
    markReady: { disabled: true, reason: 'Mark this pull request ready in Azure DevOps.' },
  },
  title: metadata.title,
  type: 'pull-request',
  url: pr.url,
});

/** @param {string} launchPath @param {PullRequestSource} source */
const openReview = async (launchPath, source) => {
  const root = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pr = parseAzureDevOpsPullRequestUrl(source.url);
  selectRemote(root, pr);
  return { root, pr, client: createAzureDevOpsClient(root, pr) };
};

/** @param {PullRequestSource | undefined} source @param {AzurePullRequest} metadata */
const assertCurrentHead = (source, metadata) => {
  if (source?.headSha && metadata.lastMergeSourceCommit?.commitId !== source.headSha) {
    throw new Error('This pull request changed. Refresh it before continuing the review.');
  }
};

/** @param {Awaited<ReturnType<typeof openReview>>} review @param {PullRequestSource} [source] */
const readSnapshotRefs = async (review, source) => {
  const metadata = await review.client.metadata();
  assertCurrentHead(source, metadata);
  const { base, head } = await resolveAzureDevOpsContentRefs(review.root, review.pr, metadata);
  if (source?.baseSha && source.baseSha !== base) {
    throw new Error(
      'The pull request comparison base changed. Refresh it before continuing the review.',
    );
  }
  return { base, head, metadata };
};

/** @param {Awaited<ReturnType<typeof openReview>>} review @param {PullRequestSource} [source] */
const readSnapshot = async (review, source) => {
  const { base, head, metadata } = await readSnapshotRefs(review, source);
  const status = parseCommitNameStatus(
    await git(review.root, ['diff', '--name-status', '-r', '-z', '-M', base, head]),
    // Batch patches follow Git's order; the comparison reader sorts the finished files.
    { sort: false },
  );
  return { base, head, status, source: createSource(review.pr, metadata, base) };
};

/** @param {DiffSection} section @param {string} path @param {number} number @returns {DiffSection} */
const asPullRequestSection = (section, path, number) => ({
  ...section,
  id: `${path}:pull-request:${number}`,
  kind: 'pull-request',
});

/** @param {AzureComment} comment @param {AzureThread} thread @param {string} url @returns {PullRequestReviewComment | null} */
const normalizeAzureDevOpsReviewComment = (comment, thread, url) => {
  if (
    !comment.content ||
    comment.isDeleted ||
    comment.commentType === 'system' ||
    comment.commentType === 3
  ) {
    return null;
  }
  const context = thread.threadContext;
  if (!context?.filePath) {
    return null;
  }
  const path = context.filePath.replace(/^\/+/, '');
  if (!path) {
    return null;
  }
  const right = context.rightFileEnd || context.rightFileStart;
  const end = right || context.leftFileEnd || context.leftFileStart;
  const start = right ? context.rightFileStart : context.leftFileStart;
  const side = right ? /** @type {const} */ ('additions') : /** @type {const} */ ('deletions');
  return {
    author: normalizeAuthor(comment.author),
    body: comment.content,
    filePath: path,
    id: `azure-devops:${thread.id}:${comment.id}`,
    ...(end ? { lineNumber: end.line, side } : { anchor: /** @type {const} */ ('file') }),
    ...(start && end && start.line !== end.line ? { startLineNumber: start.line } : {}),
    submittedAt: comment.publishedDate || comment.lastContentUpdatedDate,
    threadId: String(thread.id),
    url: `${url}?discussionId=${thread.id}`,
  };
};

/** @param {string} launchPath @param {PullRequestSource} source */
const readAzureDevOpsPullRequestState = async (launchPath, source) => {
  const review = await openReview(launchPath, source);
  const [snapshot, threads] = await Promise.all([readSnapshot(review), review.client.threads()]);
  const state = await readComparisonState({
    launchPath,
    repoRoot: review.root,
    newRef: snapshot.head,
    oldRef: snapshot.base,
    source: snapshot.source,
    status: snapshot.status,
  });
  const closed = new Set(['fixed', 'wontfix', 'closed', 'bydesign', '2', '3', '4', '5']);
  return {
    ...state,
    files: state.files.map((file) => ({
      ...file,
      sections: file.sections.map((section) =>
        asPullRequestSection(section, file.path, review.pr.number),
      ),
    })),
    reviewComments: threads
      .filter((thread) => !thread.isDeleted && !closed.has(String(thread.status).toLowerCase()))
      .flatMap((thread) =>
        (thread.comments || []).map((comment) =>
          normalizeAzureDevOpsReviewComment(comment, thread, review.pr.url),
        ),
      )
      .filter((comment) => comment !== null),
  };
};

/** @param {string} launchPath @param {import('../../core/types.ts').DiffSectionContentRequest} request */
const readAzureDevOpsSectionContent = async (launchPath, request) => {
  if (request.source?.type !== 'pull-request') {
    throw new Error('An Azure DevOps pull request source is required.');
  }
  const review = await openReview(launchPath, request.source);
  const snapshot = await readSnapshot(review, request.source);
  const section = await readComparisonSectionContent(
    review.root,
    snapshot.head,
    snapshot.base,
    snapshot.status,
    request.path,
    'pull request',
    { force: request.force },
  );
  return asPullRequestSection(section, request.path, review.pr.number);
};

/** @param {string} launchPath @param {PullRequestSource} source @param {string} path */
const readAzureDevOpsImageContent = async (launchPath, source, path) => {
  const review = await openReview(launchPath, source);
  const snapshot = await readSnapshot(review, source);
  return readComparisonImageContent(
    review.root,
    snapshot.head,
    snapshot.base,
    snapshot.status,
    path,
    'pull request',
  );
};

/** @param {string} launchPath @param {PullRequestSource} source @param {number} [limit] */
const listAzureDevOpsHistory = async (launchPath, source, limit = 200) => {
  const review = await openReview(launchPath, source);
  const snapshot = await readSnapshot(review, source);
  const [history, changes] = await Promise.all([
    listRepositoryHistory(review.root, limit, snapshot.base),
    listRepositoryHistory(review.root, limit, `${snapshot.base}..${snapshot.head}`),
  ]);
  return {
    root: review.root,
    entries: [
      ...changes.entries.map((entry) => ({
        ...entry,
        scope: /** @type {const} */ ('pull-request'),
      })),
      ...history.entries.map((entry) => ({ ...entry, scope: /** @type {const} */ ('base') })),
    ],
  };
};

/** @param {PullRequestReviewComment} comment */
const createAzureDevOpsThreadContext = (comment) => {
  const filePath = `/${comment.filePath.replace(/^\/+/, '')}`;
  if (comment.anchor === 'file' || comment.lineNumber == null || comment.side == null) {
    return { filePath };
  }
  const end = { line: comment.lineNumber, offset: 1 };
  const start = { line: comment.startLineNumber ?? comment.lineNumber, offset: 1 };
  return comment.side === 'deletions'
    ? { filePath, leftFileStart: start, leftFileEnd: end }
    : { filePath, rightFileStart: start, rightFileEnd: end };
};

/** @param {Awaited<ReturnType<typeof openReview>>} review @param {PullRequestSource} source */
const assertReviewSnapshot = async (review, source) => {
  if (source.headSha) {
    await readSnapshotRefs(review, source);
  }
};

/** @param {string} launchPath @param {SubmitPullRequestCommentRequest} request */
const submitAzureDevOpsComment = async (launchPath, request) => {
  const review = await openReview(launchPath, request.source);
  const { comment } = request;
  let submitted;
  let threadId;
  if (comment.threadId) {
    submitted = await review.client.reply(comment.threadId, comment.body);
    threadId = comment.threadId;
  } else {
    await assertReviewSnapshot(review, request.source);
    const thread = await review.client.createThread({
      comments: [{ commentType: 1, content: comment.body, parentCommentId: 0 }],
      status: 1,
      threadContext: createAzureDevOpsThreadContext(comment),
    });
    submitted = thread.comments?.[0];
    if (!Number.isInteger(thread.id)) {
      throw new Error(
        'Azure DevOps accepted the comment but did not return its thread. Refresh before retrying.',
      );
    }
    threadId = String(thread.id);
  }
  if (!submitted?.content || submitted.id == null || !threadId) {
    throw new Error(
      'Azure DevOps accepted the comment but did not return its metadata. Refresh before retrying.',
    );
  }
  return {
    ...comment,
    body: submitted.content,
    author: normalizeAuthor(submitted.author),
    id: `azure-devops:${threadId}:${submitted.id}`,
    submittedAt: submitted.publishedDate || submitted.lastContentUpdatedDate,
    threadId,
    url: `${review.pr.url}?discussionId=${threadId}`,
  };
};

/** @param {string} launchPath @param {SubmitPullRequestReviewRequest} request */
const submitAzureDevOpsReview = async (launchPath, request) => {
  const votes = { APPROVE: 10, COMMENT: 0, REQUEST_CHANGES: -10 };
  if (!(request.event in votes)) {
    throw new Error(`Azure DevOps reviews do not support ${request.event}.`);
  }
  const review = await openReview(launchPath, request.source);
  await assertReviewSnapshot(review, request.source);
  for (const comment of request.comments) {
    await review.client.createThread({
      comments: [{ commentType: 1, content: comment.body, parentCommentId: 0 }],
      status: 1,
      threadContext: createAzureDevOpsThreadContext(comment),
    });
  }
  if (request.body?.trim()) {
    await review.client.createThread({
      comments: [{ commentType: 1, content: request.body.trim(), parentCommentId: 0 }],
      status: 1,
    });
  }
  if (votes[request.event] !== 0) {
    await review.client.vote(votes[request.event]);
  }
};

module.exports = {
  createAzureDevOpsThreadContext,
  listAzureDevOpsHistory,
  normalizeAzureDevOpsReviewComment,
  parseAzureDevOpsPullRequestUrl,
  readAzureDevOpsImageContent,
  readAzureDevOpsPullRequestState,
  readAzureDevOpsSectionContent,
  resolveAzureDevOpsContentRefs,
  submitAzureDevOpsComment,
  submitAzureDevOpsReview,
};
