// @ts-check

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { parseJSONMessage } = require('./agent-shared.cjs');
const { createReviewAssistantContext } = require('./review-assist-context.cjs');

/** @typedef {import('../core/types.ts').RepositoryState} RepositoryState */
/** @typedef {import('../core/types.ts').ReviewAssistantRequest} ReviewAssistantRequest */
/** @typedef {import('./review-assist-context.cjs').ContextRead} ContextRead */
/** @typedef {import('./agent.cjs').Agent} Agent */
/** @typedef {import('./agent.cjs').AgentOptions} AgentOptions */

const instructions = readFileSync(join(__dirname, 'prompts', 'review-assistant.md'), 'utf8');
const MAX_READ_ROUNDS = 3;
const views = new Set(['files', 'changes', 'before', 'after']);
const reviewAssistantSchema = {
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    requests: {
      items: {
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          search: { type: 'string' },
          startLine: { minimum: 1, type: 'integer' },
          view: { enum: [...views], type: 'string' },
        },
        required: ['path', 'search', 'startLine', 'view'],
        type: 'object',
      },
      maxItems: 6,
      type: 'array',
    },
    version: { const: 1, type: 'number' },
  },
  required: ['version', 'reply', 'requests'],
  type: 'object',
};

/** @param {unknown} input @returns {{reply: string; requests: ContextRead[]}} */
const readResponse = (input) => {
  if (
    !input ||
    typeof input !== 'object' ||
    !('reply' in input) ||
    typeof input.reply !== 'string' ||
    !('version' in input) ||
    input.version !== 1
  ) {
    throw new Error(
      'The assistant did not return an answer or a valid request for more context. Ask again.',
    );
  }
  const requests = 'requests' in input ? input.requests : undefined;
  if (
    !Array.isArray(requests) ||
    requests.length > 6 ||
    requests.some(
      (read) =>
        !read ||
        typeof read !== 'object' ||
        typeof read.path !== 'string' ||
        typeof read.search !== 'string' ||
        read.search.length > 2000 ||
        !Number.isSafeInteger(read.startLine) ||
        read.startLine < 1 ||
        !views.has(read.view),
    )
  ) {
    throw new Error('The assistant returned an invalid request for review context. Ask again.');
  }
  return { reply: input.reply.replace(/\n{3,}/g, '\n\n').trim(), requests };
};

/**
 * @param {RepositoryState} state
 * @param {ReviewAssistantRequest} request
 * @param {Agent} agent
 * @param {AgentOptions} agentOptions
 * @returns {Promise<import('../core/types.ts').ReviewAssistantResult>}
 */
const readReviewAssistantReply = async (state, request, agent, agentOptions) => {
  let context;
  try {
    if (!request?.comment?.body?.trim() || request.comment.body.length > 16_000) {
      throw new Error('Ask a question of no more than 16,000 characters.');
    }
    const previousTurns = request.previousTurns === undefined ? [] : request.previousTurns;
    if (
      !Array.isArray(previousTurns) ||
      previousTurns.some(
        (turn) =>
          !turn ||
          typeof turn.question !== 'string' ||
          !turn.question.trim() ||
          typeof turn.reply !== 'string' ||
          !turn.reply.trim(),
      )
    ) {
      throw new Error(
        'The earlier conversation is incomplete. Use Ask on the original note to start again.',
      );
    }
    if (
      previousTurns.reduce((size, turn) => size + turn.question.length + turn.reply.length, 0) >
      64_000
    ) {
      throw new Error(
        'This conversation is too long to send in full. Use Ask on the original note to start a new conversation.',
      );
    }
    context = await createReviewAssistantContext(state, request);
    const source = state.source;
    const description = source.type === 'pull-request' ? source.description || '' : '';
    if (description.length > 6000) context.warn('The PR description was shortened for length.');
    const location = request.comment;
    const overview = [
      '# Reviewer’s question',
      location.body,
      previousTurns.length
        ? `# Earlier conversation\n\n${previousTurns
            .map(
              (turn, index) =>
                `## Exchange ${index + 1}\n\n### Reviewer\n${turn.question}\n\n### Assistant\n${turn.reply}`,
            )
            .join('\n\n')}`
        : '',
      '# Selected location',
      `${location.filePath}${location.lineNumber ? `:${location.startLineNumber || location.lineNumber}–${location.lineNumber}` : ''}${location.side ? ` (${location.side})` : ''}`,
      '# Review',
      source.type === 'pull-request'
        ? `${source.title || 'Pull request'}\n${source.url}`
        : source.type,
      context.summary().version ? `Before → after commits: ${context.summary().version}` : '',
      description
        ? `## Author’s description\n${description.slice(0, 6000)}${description.length > 6000 ? '\n[Description shortened for length.]' : ''}`
        : '',
      request.walkthroughNote
        ? `## Earlier review notes\nWhat to check: ${request.walkthroughNote.context}\nWhy: ${request.walkthroughNote.reason}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    let material = `${overview}\n\n${context.material}`;
    const deadline = Date.now() + (agentOptions?.timeoutMs || agent.defaultTimeoutMs || 300_000);
    for (let round = 0; round <= MAX_READ_ROUNDS; round += 1) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0)
        throw new Error('The review answer timed out while reading additional context. Ask again.');
      if (round === MAX_READ_ROUNDS)
        context.warn('This answer has reached the limit for additional context reads.');
      const limits = context.summary().warnings;
      const prompt = instructions
        .replace('{{AGENT_NAME}}', () => agent.label)
        .replace(
          '{{REVIEW_MATERIAL}}',
          () =>
            `${material}\n\n# Context limits\n${limits.length ? limits.map((warning) => `- ${warning}`).join('\n') : 'All changed files and their text changes are included.'}${round === MAX_READ_ROUNDS ? '\nNo further reads are available. Answer using the supplied material and explain any remaining gaps.' : ''}`,
        );
      const response = readResponse(
        parseJSONMessage(
          await agent.run(
            state.root,
            prompt,
            reviewAssistantSchema,
            'review-assistant.json',
            `${agent.label} review reply timed out.`,
            { ...agentOptions, timeoutMs },
          ),
        ),
      );
      if (response.requests.length === 0) {
        if (!response.reply) throw new Error('The assistant returned an empty answer. Ask again.');
        return { context: context.summary(), reply: response.reply, status: 'ready' };
      }
      if (round === MAX_READ_ROUNDS) {
        throw new Error(
          'The assistant needs more context than this answer can include. Ask a narrower question.',
        );
      }
      const additions = [];
      for (const read of response.requests) additions.push(await context.read(read));
      material += `\n\n# Additional review material\n${additions.join('\n\n')}`;
    }
    throw new Error('The assistant could not finish this answer.');
  } catch (error) {
    return {
      ...(context ? { context: context.summary() } : {}),
      ...(agent.isNotFoundError(error) ? { code: agent.notFoundCode } : {}),
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
};

module.exports = { readReviewAssistantReply };
