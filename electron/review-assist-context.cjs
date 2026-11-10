// @ts-check

const { git, validateRepositoryPath, MANUAL_TEXT_FILE_LIMIT } = require('./git-state/common.cjs');
const { readGitFiles } = require('./git-state/git-files.cjs');
const { parseCommitNameStatus } = require('./git-state/commit.cjs');

/** @typedef {import('../core/types.ts').RepositoryState} RepositoryState */
/** @typedef {import('../core/types.ts').ReviewAssistantRequest} ReviewAssistantRequest */
/** @typedef {{path: string; view: 'files' | 'changes' | 'before' | 'after'; startLine: number; search: string}} ContextRead */

const INITIAL_CHARS = 64_000;
const INDEX_CHARS = 24_000;
const PAGE_CHARS = 12_000;
const PAGE_LINES = 160;
const TOTAL_CHARS = 160_000;
const FILE_READ_LIMIT = 200;

/** @param {string} text @param {ReviewAssistantRequest['comment']} location */
const selectedPatchLine = (text, location) => {
  if (!location.lineNumber) return 1;
  const lines = text.split('\n');
  let oldLine = 0;
  let newLine = 0;
  let header = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      header = index;
    } else if (header) {
      const position = location.side === 'deletions' ? oldLine : newLine;
      if (position === location.lineNumber) return Math.max(header + 1, index - 20);
      if (!line.startsWith('+') && !line.startsWith('\\')) oldLine += 1;
      if (!line.startsWith('-') && !line.startsWith('\\')) newLine += 1;
    }
  }
  return 1;
};

/** @param {string} text @param {number} startLine @param {number} limit @param {string} [search] */
const readPage = (text, startLine, limit, search = '') => {
  const lines = text.split('\n');
  let start = Math.min(startLine - 1, lines.length);
  if (search) {
    const found = lines.findIndex((line, index) => index >= start && line.includes(search));
    if (found === -1) return { text: 'No matching text found.', partial: false };
    start = Math.max(start, found - 8);
  }
  const selected = [];
  let length = 0;
  for (let index = start; index < lines.length && selected.length < PAGE_LINES; index += 1) {
    const line = lines[index];
    if (length + line.length + 1 > limit) {
      if (selected.length === 0) {
        const match = search ? line.indexOf(search) : 0;
        const offset = Math.max(0, match - Math.floor(limit / 4));
        selected.push(`${index + 1}: ${line.slice(offset, offset + limit - 100)} [line shortened]`);
      }
      break;
    }
    selected.push(`${index + 1}: ${line}`);
    length += line.length + 1;
  }
  const end = start + selected.length;
  const partial =
    start > 0 || end < lines.length || selected.some((line) => line.endsWith('[line shortened]'));
  return {
    partial,
    text: `Lines ${start + 1}–${end} of ${lines.length}.${end < lines.length ? ` Continue at startLine ${end + 1}.` : ''}\n${selected.join('\n')}`,
  };
};

/** @param {RepositoryState} state @param {ReviewAssistantRequest} request */
const createReviewAssistantContext = async (state, request) => {
  const source = state.source;
  const expected = request.source;
  if (source.type === 'pull-request' && expected?.type === 'pull-request') {
    if (
      source.url !== expected.url ||
      (expected.headSha && source.headSha !== expected.headSha) ||
      (expected.baseSha && source.baseSha !== expected.baseSha)
    ) {
      throw new Error(
        'This pull request changed. Refresh it and ask again for the current version.',
      );
    }
  }

  /** @type {Set<string>} */
  const warnings = new Set();
  /** @type {Set<string>} */
  const filesRead = new Set();
  /** @type {Map<string, string>} */
  const documents = new Map();
  let cachedChars = 0;
  let suppliedChars = 0;
  const commits =
    source.type === 'pull-request' &&
    source.baseSha &&
    source.headSha &&
    /^[a-f0-9]{40,64}$/i.test(source.baseSha || '') &&
    /^[a-f0-9]{40,64}$/i.test(source.headSha || '')
      ? { before: source.baseSha, after: source.headSha }
      : null;
  if (commits) {
    for (const ref of [commits.before, commits.after]) {
      const resolved = (await git(state.root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
      if (resolved.toLowerCase() !== ref.toLowerCase()) {
        throw new Error(
          'The saved pull request commits are not available. Refresh it and ask again.',
        );
      }
    }
  } else if (source.type === 'pull-request') {
    warnings.add(
      'Saved before/after commits are unavailable. Only the supplied PR changes can be read.',
    );
  }

  const files = commits
    ? parseCommitNameStatus(
        await git(state.root, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--name-status',
          '-z',
          '-M',
          commits.before,
          commits.after,
        ]),
      ).map((file) => ({
        ...file,
        sections: state.files.find((candidate) => candidate.path === file.path)?.sections || [],
      }))
    : state.files;
  const index = files
    .map(
      (file) =>
        `${file.status}: ${file.path}${file.oldPath ? ` (previously ${file.oldPath})` : ''}`,
    )
    .join('\n');

  /** @param {string} path @param {'changes' | 'before' | 'after'} view */
  const getDocument = async (path, view) => {
    const safePath = validateRepositoryPath(path).replaceAll('\\', '/');
    const file = files.find(
      (candidate) => candidate.path === safePath || candidate.oldPath === safePath,
    );
    const key = `${view}:${safePath}`;
    const cached = documents.get(key);
    if (cached !== undefined) return cached;
    let text;
    if (view === 'changes') {
      if (!file)
        throw new Error('That file is not in this review. Read its before/after version instead.');
      if (file.sections.length && file.sections.every((section) => section.binary))
        throw new Error('Binary file contents cannot be read as text.');
      if (file.sections.some((section) => section.loadState === 'too-large')) {
        throw new Error('This file exceeds Codiff’s text-file size limit.');
      }
      text = commits
        ? await git(state.root, [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--unified=3',
            '--find-renames',
            commits.before,
            commits.after,
            '--',
            ...[...new Set([file.oldPath, file.path].filter(Boolean))].map(
              (item) => `:(literal)${item}`,
            ),
          ])
        : file.sections
            .map((section) => section.patch)
            .filter(Boolean)
            .join('\n');
      if (!text.trim())
        throw new Error('No text changes are available for this file in the saved review.');
      if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(text))
        throw new Error('Binary file contents cannot be read as text.');
    } else if (commits) {
      const pathAtVersion = view === 'before' ? file?.oldPath || safePath : file?.path || safePath;
      const ref = commits[view];
      const result = (
        await readGitFiles(state.root, ref, [pathAtVersion], {
          force: true,
          refScopedEmptyCacheKey: true,
        })
      ).get(pathAtVersion);
      if (!result?.file || result.file.cacheKey === `${ref}:${pathAtVersion}:empty`) {
        throw new Error(
          result?.summary?.reason || 'This file is absent or not readable as text in that version.',
        );
      }
      text = result.file.contents;
    } else {
      const contents = file?.sections.map((section) =>
        view === 'before' ? section.oldFile : section.newFile,
      );
      const content = view === 'before' ? contents?.[0] : contents?.at(-1);
      if (!content)
        throw new Error(
          'This source file is not available in the captured review. No working-folder file was read.',
        );
      text = content.contents;
    }
    if (text.length > MANUAL_TEXT_FILE_LIMIT * 2)
      throw new Error('This text exceeds Codiff’s review-context size limit.');
    if (cachedChars + text.length <= MANUAL_TEXT_FILE_LIMIT) {
      documents.set(key, text);
      cachedChars += text.length;
    }
    return text;
  };

  /** @param {string} heading @param {string} text @param {string} [filePath] */
  const supply = (heading, text, filePath) => {
    const block = `## ${heading}\n${text}\n`;
    if (suppliedChars + block.length > TOTAL_CHARS) {
      warnings.add(
        'The answer context reached its text limit. Some requested material could not be included.',
      );
      return `## ${heading}\nNot supplied: the answer context reached its text limit.\n`;
    }
    suppliedChars += block.length;
    if (filePath) filesRead.add(filePath);
    return block;
  };

  const fileList = readPage(index, 1, INDEX_CHARS);
  if (fileList.partial)
    warnings.add(
      'The changed-file list is shortened. The assistant can request the remaining file names.',
    );
  const parts = [supply('Changed files', fileList.text)];
  let remaining = INITIAL_CHARS;
  const orderedFiles = [...files]
    .sort(
      (a, b) =>
        Number(b.path === request.comment.filePath) - Number(a.path === request.comment.filePath),
    )
    .slice(0, FILE_READ_LIMIT);
  for (const file of orderedFiles) {
    if (remaining < 512) break;
    try {
      const text = await getDocument(file.path, 'changes');
      if (text.length <= remaining) {
        parts.push(supply(`Changes: ${file.path}`, text, file.path));
        remaining -= text.length;
      } else {
        const page = readPage(
          text,
          file.path === request.comment.filePath ? selectedPatchLine(text, request.comment) : 1,
          Math.min(PAGE_CHARS, remaining),
        );
        parts.push(supply(`Changes: ${file.path}`, page.text, file.path));
        remaining -= Math.min(PAGE_CHARS, remaining);
        warnings.add(
          'Some file changes are only partly included. The assistant can request more lines.',
        );
      }
    } catch (error) {
      warnings.add(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (filesRead.size < files.length)
    warnings.add(
      'Not every file’s changes are included. Additional text changes can be requested.',
    );

  /** @param {ContextRead} read */
  const readContext = async (read) => {
    if (read.view === 'files')
      return supply(
        'Changed-file list',
        readPage(index, read.startLine, PAGE_CHARS, read.search).text,
      );
    if (!read.path) {
      if (read.view !== 'changes' || !read.search)
        throw new Error('Searching all changed files requires text to search for.');
      const matches = [];
      let next = read.startLine - 1;
      const end = Math.min(next + FILE_READ_LIMIT, files.length);
      for (; next < end; next += 1) {
        const file = files[next];
        try {
          const text = await getDocument(file.path, 'changes');
          if (text.includes(read.search)) {
            const page = readPage(text, 1, PAGE_CHARS, read.search);
            matches.push(supply(`Matching changes: ${file.path}`, page.text, file.path));
            if (matches.length === 6) {
              next += 1;
              break;
            }
          }
        } catch (error) {
          warnings.add(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const continuation =
        next < files.length ? ` Continue searching at startLine ${next + 1}.` : '';
      return `Searched changed files ${read.startLine}–${next} of ${files.length}.${continuation}\n${matches.join('\n') || 'No matching text found in the readable changed files.'}`;
    }
    try {
      const text = await getDocument(read.path, read.view);
      const page = readPage(text, read.startLine, PAGE_CHARS, read.search);
      if (page.partial)
        warnings.add(
          'Some requested file contents are shortened. Do not assume unread lines were checked.',
        );
      return supply(
        `${read.view}: ${read.path}`,
        page.text,
        read.view === 'changes' && (!read.search || text.includes(read.search))
          ? read.path
          : undefined,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.add(`${read.path}: ${reason}`);
      return `Could not read ${read.path}: ${reason}`;
    }
  };

  return {
    material: parts.join('\n'),
    read: readContext,
    /** @param {string} warning */
    warn: (warning) => warnings.add(warning),
    summary: () => ({
      fileCount: files.length,
      filesRead: filesRead.size,
      label: source.type === 'pull-request' ? 'PR context' : 'Review context',
      ...(commits
        ? { version: `${commits.before.slice(0, 7)} → ${commits.after.slice(0, 7)}` }
        : {}),
      warnings: [...warnings],
    }),
  };
};

module.exports = { createReviewAssistantContext };
