/**
 * @vitest-environment jsdom
 */

import { act, useRef } from 'react';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { useAppReviewComments } from '../app/hooks/useAppReviewComments.ts';
import type { ReviewComment } from '../lib/app-types.ts';
import type { RepositoryState, ReviewAssistantResult } from '../types.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

type AppReviewComments = ReturnType<typeof useAppReviewComments>;

const originalCodiff = window.codiff;
const workingTreeState = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;
const pullRequestState = {
  ...workingTreeState,
  source: {
    number: 42,
    owner: 'nkzw-tech',
    provider: 'github',
    repo: 'codiff',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/42',
  },
} satisfies RepositoryState;
const comment: ReviewComment = {
  body: 'Review this',
  filePath: 'src/app.ts',
  id: 'comment-1',
  lineNumber: 4,
  sectionId: 'src/app.ts:pull-request',
  side: 'additions',
};

function AppReviewCommentsHarness({
  onCommentFileChange,
  onState,
  state,
}: {
  onCommentFileChange: (filePath: string) => void;
  onState: (comments: AppReviewComments) => void;
  state: RepositoryState;
}) {
  const stateRef = useRef<RepositoryState | null>(state);
  stateRef.current = state;
  const comments = useAppReviewComments({
    isReviewActionDisabled: () => false,
    onCommentFileChange,
    stateRef,
  });
  onState(comments);
  return null;
}

const renderAppReviewComments = async (state: RepositoryState) => {
  const onCommentFileChange = vi.fn();
  const stateRef: { current: AppReviewComments | null } = { current: null };
  const getState = () => {
    if (!stateRef.current) {
      throw new Error('App review comments did not render.');
    }
    return stateRef.current;
  };
  const render = (nextState: RepositoryState) => (
    <AppReviewCommentsHarness
      onCommentFileChange={onCommentFileChange}
      onState={(comments) => (stateRef.current = comments)}
      state={nextState}
    />
  );
  const view = await renderReact(render(state));
  return {
    ...view,
    getState,
    onCommentFileChange,
    rerenderState: (nextState: RepositoryState) => view.rerender(render(nextState)),
  };
};

afterEach(() => {
  window.codiff = originalCodiff;
});

test('app review comments request and store assistant replies', async () => {
  const context = {
    fileCount: 8,
    filesRead: 8,
    label: 'PR context',
    version: 'before → after',
    warnings: [],
  };
  const askReviewAssistant = vi.fn(async () => ({
    context,
    reply: 'Use the shared parser.',
    status: 'ready' as const,
  }));
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(workingTreeState);
  const { getState, onCommentFileChange } = view;

  await act(async () => {
    getState().setReviewComments([comment]);
  });
  await act(async () => {
    getState().askCodex(comment.id);
  });
  expect(askReviewAssistant).toHaveBeenCalledWith({
    comment: {
      body: comment.body,
      filePath: comment.filePath,
      lineNumber: comment.lineNumber,
      sectionId: comment.sectionId,
      side: comment.side,
    },
    source: workingTreeState.source,
  });
  await waitFor(() => {
    expect(getState().reviewComments[0]?.codexReply).toEqual({
      body: 'Use the shared parser.',
      context,
      status: 'ready',
    });
  });
  expect(onCommentFileChange).toHaveBeenCalledTimes(2);
});

test.each(['commits', 'question', 'review', 'hydration'])(
  'assistant replies respect in-flight %s changes and prevent duplicate requests',
  async (change) => {
    const pending = Promise.withResolvers<ReviewAssistantResult>();
    const askReviewAssistant = vi.fn(() => pending.promise);
    window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
    const initial: RepositoryState = {
      ...pullRequestState,
      source: { ...pullRequestState.source, baseSha: 'before', headSha: 'after' },
    };
    await using view = await renderAppReviewComments(initial);
    await act(async () => view.getState().setReviewComments([comment]));
    await act(async () => {
      view.getState().askCodex(comment.id);
      view.getState().askCodex(comment.id);
    });
    expect(askReviewAssistant).toHaveBeenCalledTimes(1);
    if (change === 'question') {
      await act(async () => view.getState().updateComment(comment.id, 'A different question'));
    } else {
      await view.rerenderState({
        ...initial,
        ...(change === 'hydration'
          ? {
              files: [
                {
                  fingerprint: 'loaded',
                  oldPath: undefined,
                  path: 'src/app.ts',
                  sections: [],
                  status: 'modified',
                },
              ],
            }
          : {}),
        source: {
          ...initial.source,
          ...(change === 'commits' ? { headSha: 'new-after' } : {}),
          ...(change === 'review'
            ? { number: 43, url: 'https://github.com/nkzw-tech/codiff/pull/43' }
            : {}),
        },
      });
    }
    await act(async () => pending.resolve({ reply: 'Previous answer', status: 'ready' }));
    const reply = view.getState().reviewComments[0]?.codexReply;
    if (change === 'hydration') {
      expect(reply).toMatchObject({ body: 'Previous answer', status: 'ready' });
    } else if (change === 'review') {
      expect(reply?.body).toBeUndefined();
    } else {
      expect(reply).toMatchObject({ error: expect.stringContaining('Ask again'), status: 'error' });
      expect(reply?.body).toBeUndefined();
    }
  },
);

test('app review comments submit a draft and replace it with the remote comment', async () => {
  const submitPullRequestComment = vi.fn(async () => ({
    author: {
      login: 'reviewer',
      name: 'Reviewer',
    },
    body: comment.body,
    filePath: comment.filePath,
    id: 'remote-comment',
    lineNumber: comment.lineNumber,
    side: comment.side,
    submittedAt: '2026-07-15T00:00:00.000Z',
    url: 'https://github.com/nkzw-tech/codiff/pull/42#discussion_r1',
  }));
  window.codiff = { submitPullRequestComment } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState, onCommentFileChange } = view;

  await act(async () => {
    getState().setReviewComments([comment]);
  });
  await act(async () => {
    getState().submitPullRequestComment(comment.id);
  });
  expect(submitPullRequestComment).toHaveBeenCalledWith({
    comment: {
      body: comment.body,
      filePath: comment.filePath,
      lineNumber: comment.lineNumber,
      side: comment.side,
    },
    source: pullRequestState.source,
  });
  await waitFor(() => {
    expect(getState().reviewComments).toEqual([
      {
        author: {
          login: 'reviewer',
          name: 'Reviewer',
        },
        body: comment.body,
        filePath: comment.filePath,
        id: 'remote-comment',
        isReadOnly: true,
        lineNumber: comment.lineNumber,
        sectionId: comment.sectionId,
        side: comment.side,
        submittedAt: '2026-07-15T00:00:00.000Z',
        url: 'https://github.com/nkzw-tech/codiff/pull/42#discussion_r1',
      },
    ]);
  });
  expect(onCommentFileChange).toHaveBeenCalledTimes(2);
});

test('app review comments submit and clear pending review drafts', async () => {
  const submitPullRequestReview = vi.fn(async () => {});
  window.codiff = { submitPullRequestReview } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState } = view;

  await act(async () => {
    getState().setReviewComments([comment]);
  });
  await act(async () => {
    await getState().submitPullRequestReview('COMMENT');
  });
  expect(submitPullRequestReview).toHaveBeenCalledWith({
    comments: [
      {
        body: comment.body,
        filePath: comment.filePath,
        lineNumber: comment.lineNumber,
        side: comment.side,
      },
    ],
    event: 'COMMENT',
    source: pullRequestState.source,
  });
  expect(getState().reviewComments).toEqual([]);
  expect(getState().pullRequestReviewSubmitting).toBeNull();
});
