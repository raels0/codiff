// @ts-check

const { sep } = require('node:path');
const {
  fileSort,
  getFingerprint,
  git,
  readGitImageFile,
  summarizeContent,
  validateRepositoryPath,
} = require('./common.cjs');
const { createEmptyFileContent, readGitFiles } = require('./git-files.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 */

/** @param {string} newRef @param {string | undefined} oldRef @param {ReadonlyArray<string>} paths */
const createComparisonPatchArgs = (newRef, oldRef, paths) =>
  oldRef
    ? ['diff', '--patch', '--no-ext-diff', '--find-renames', oldRef, newRef, '--', ...paths]
    : ['show', '--format=', '--patch', '--no-ext-diff', '--find-renames', newRef, '--', ...paths];

/** @param {string} repoRoot @param {string} newRef @param {string | undefined} oldRef @param {string} path */
const readComparisonPatch = (repoRoot, newRef, oldRef, path) =>
  git(repoRoot, createComparisonPatchArgs(newRef, oldRef, [path]));

/** @param {ReadonlyArray<string>} values @param {number} size */
const chunk = (values, size) => {
  /** @type {Array<Array<string>>} */
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

/** @param {string} patch */
const splitCommitPatch = (patch) =>
  patch
    .split(/(?=^diff --git )/m)
    .map((part) => part.trimEnd())
    .filter((part) => part.startsWith('diff --git '))
    .map((part) => `${part}\n`);

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<Pick<StatusItem, 'path'>>} items
 */
const readComparisonPatches = async (repoRoot, newRef, oldRef, items) => {
  /** @type {Map<string, string>} */
  const patches = new Map();

  for (const itemChunk of chunk(
    items.map((item) => item.path),
    200,
  )) {
    if (itemChunk.length === 0) {
      continue;
    }

    const patch = await git(repoRoot, createComparisonPatchArgs(newRef, oldRef, itemChunk));
    const patchChunks = splitCommitPatch(patch);

    if (patchChunks.length === itemChunk.length) {
      for (let index = 0; index < itemChunk.length; index += 1) {
        patches.set(itemChunk[index], patchChunks[index]);
      }
    } else {
      await Promise.all(
        itemChunk.map(async (path) => {
          patches.set(path, await readComparisonPatch(repoRoot, newRef, oldRef, path));
        }),
      );
    }
  }

  return patches;
};

/**
 * @param {string} ref
 * @param {Pick<StatusItem, 'oldPath' | 'path' | 'status'>} item
 * @param {ReturnType<typeof createEmptyFileContent>} oldFile
 * @param {ReturnType<typeof createEmptyFileContent>} newFile
 * @param {string} patch
 */
const createComparisonFile = (ref, item, oldFile, newFile, patch) => {
  const summary = summarizeContent(oldFile, newFile);

  return {
    fingerprint: getFingerprint(
      `${ref}\n${item.status}\n${item.oldPath || ''}\n${summary.loadState || 'ready'}\n${
        summary.summary?.reason || ''
      }\n${summary.summary?.fingerprint || ''}\n${patch}\n${oldFile.file?.contents || ''}\n${
        newFile.file?.contents || ''
      }`,
    ),
    oldPath: item.oldPath,
    path: item.path,
    sections: [
      {
        binary: summary.binary || /Binary files .* differ/.test(patch),
        id: `${item.path}:${ref}`,
        kind: 'commit',
        loadState: summary.loadState,
        newFile: newFile.file,
        oldFile: oldFile.file,
        patch,
        summary: summary.summary,
      },
    ],
    status: item.status,
  };
};

/**
 * @param {string} ref
 * @param {Pick<StatusItem, 'oldPath' | 'path' | 'status'>} item
 * @param {ReturnType<typeof createEmptyFileContent>} oldFile
 * @param {ReturnType<typeof createEmptyFileContent>} newFile
 * @param {string} patch
 */
const createComparisonSection = (ref, item, oldFile, newFile, patch) =>
  createComparisonFile(ref, item, oldFile, newFile, patch).sections[0];

/**
 * @param {Map<string, ReturnType<typeof createEmptyFileContent> | import('./common.cjs').FileContentResult>} oldFiles
 * @param {string | undefined} oldRef
 * @param {Pick<StatusItem, 'oldPath' | 'path'>} item
 */
const getOldComparisonFile = (oldFiles, oldRef, item) =>
  oldRef
    ? oldFiles.get(item.oldPath || item.path) || createEmptyFileContent(item.oldPath || item.path)
    : createEmptyFileContent(item.oldPath || item.path);

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} status
 * @param {{force?: boolean}} [options]
 */
const readComparisonFiles = async (repoRoot, newRef, oldRef, status, options = {}) => {
  const [oldFiles, newFiles] = await Promise.all([
    oldRef
      ? readGitFiles(
          repoRoot,
          oldRef,
          status.map((item) => item.oldPath || item.path),
          options,
        )
      : Promise.resolve(new Map()),
    readGitFiles(
      repoRoot,
      newRef,
      status.map((item) => item.path),
      options,
    ),
  ]);

  return { newFiles, oldFiles };
};

/**
 * @param {{
 *   launchPath: string;
 *   newRef: string;
 *   oldRef?: string;
 *   repoRoot: string;
 *   source: ReviewSource;
 *   status: ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>;
 * }} input
 * @returns {Promise<RepositoryState>}
 */
const readComparisonState = async ({ launchPath, newRef, oldRef, repoRoot, source, status }) => {
  const { oldFiles, newFiles } = await readComparisonFiles(repoRoot, newRef, oldRef, status);
  const readyItems = status.filter((item) => {
    const oldFile = getOldComparisonFile(oldFiles, oldRef, item);
    const newFile = newFiles.get(item.path) || createEmptyFileContent(item.path);
    return summarizeContent(oldFile, newFile).loadState === 'ready';
  });
  const patches = await readComparisonPatches(repoRoot, newRef, oldRef, readyItems);
  /** @type {Array<ChangedFile>} */
  const files = status
    .map((item) =>
      createComparisonFile(
        newRef,
        item,
        getOldComparisonFile(oldFiles, oldRef, item),
        newFiles.get(item.path) || createEmptyFileContent(item.path),
        patches.get(item.path) || '',
      ),
    )
    .sort(fileSort);

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source,
  };
};

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} status
 * @param {string} requestedPath
 * @param {string} sourceLabel
 * @param {{force?: boolean}} [options]
 */
const readComparisonSectionContent = async (
  repoRoot,
  newRef,
  oldRef,
  status,
  requestedPath,
  sourceLabel,
  options = {},
) => {
  const path = validateRepositoryPath(requestedPath).split(sep).join('/');
  const item = status.find((candidate) => candidate.path === path);
  if (!item) {
    throw new Error(`File is not part of this ${sourceLabel}.`);
  }

  const { oldFiles, newFiles } = await readComparisonFiles(
    repoRoot,
    newRef,
    oldRef,
    [item],
    options,
  );
  const oldFile = getOldComparisonFile(oldFiles, oldRef, item);
  const newFile = newFiles.get(item.path) || createEmptyFileContent(item.path);
  const summary = summarizeContent(oldFile, newFile);
  const patch =
    summary.loadState === 'ready'
      ? await readComparisonPatch(repoRoot, newRef, oldRef, item.path)
      : '';

  return createComparisonSection(newRef, item, oldFile, newFile, patch);
};

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} status
 * @param {string} requestedPath
 * @param {string} sourceLabel
 * @returns {Promise<DiffImageContentResult>}
 */
const readComparisonImageContent = async (
  repoRoot,
  newRef,
  oldRef,
  status,
  requestedPath,
  sourceLabel,
) => {
  try {
    const path = validateRepositoryPath(requestedPath).split(sep).join('/');
    const item = status.find((candidate) => candidate.path === path);
    if (!item) {
      throw new Error(`File is not part of this ${sourceLabel}.`);
    }

    const [oldImage, newImage] = await Promise.all([
      oldRef ? readGitImageFile(repoRoot, oldRef, item.oldPath || item.path) : undefined,
      readGitImageFile(repoRoot, newRef, item.path),
    ]);

    if (!oldImage && !newImage) {
      return {
        reason: 'Codiff could not load either side of this image.',
        status: 'unavailable',
      };
    }

    return {
      ...(newImage ? { newImage } : {}),
      ...(oldImage ? { oldImage } : {}),
      status: 'ready',
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
};

module.exports = {
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonState,
};
