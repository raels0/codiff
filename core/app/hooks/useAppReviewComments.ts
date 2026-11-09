import { useCallback, useRef, useState, type RefObject } from 'react';
import type { ReviewComment } from '../../lib/app-types.ts';
import {
  getPendingPullRequestReviewComments,
  getReviewCommentRangeProps,
  toPullRequestReviewComment,
} from '../../lib/review-comments.ts';
import { getSourceKey } from '../../lib/source.ts';
import type {
  PullRequestReviewEvent,
  PullRequestReviewStatus,
  RepositoryState,
  ReviewAssistantRequest,
} from '../../types.ts';
import { useReviewCommentDrafts } from './useReviewCommentDrafts.ts';

type UseAppReviewCommentsOptions = {
  isReviewActionDisabled: (
    reviewStatus: PullRequestReviewStatus | undefined,
    event: PullRequestReviewEvent,
  ) => boolean;
  onCommentFileChange: (filePath: string) => void;
  stateRef: RefObject<RepositoryState | null>;
};

const getReviewVersion = (state: RepositoryState) =>
  state.source.type === 'pull-request'
    ? `${state.source.baseSha || ''}:${state.source.headSha || ''}`
    : state.files.map((file) => `${file.path}:${file.fingerprint}`).join('\n');

export function useAppReviewComments({
  isReviewActionDisabled,
  onCommentFileChange,
  stateRef,
}: UseAppReviewCommentsOptions) {
  const [reviewComments, setReviewComments] = useState<ReadonlyArray<ReviewComment>>([]);
  const pendingAnswers = useRef(new Set<string>());
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const commentDrafts = useReviewCommentDrafts({
    comments: reviewComments,
    onCommentFileChange,
    setComments: setReviewComments,
  });
  const {
    activeReviewCommentDraftRef,
    activeReviewCommentDraftState,
    clearCommentFocus,
    reviewCommentsRef,
    updateActiveReviewCommentDraft,
  } = commentDrafts;

  const updateCodexReply = useCallback(
    (commentId: string, filePath: string, codexReply: NonNullable<ReviewComment['codexReply']>) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                codexReply,
              }
            : comment,
        ),
      );
      onCommentFileChange(filePath);
    },
    [onCommentFileChange],
  );

  const updateRemoteSubmit = useCallback(
    (commentId: string, remoteSubmit: ReviewComment['remoteSubmit']) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                remoteSubmit,
              }
            : comment,
        ),
      );
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (comment) {
        onCommentFileChange(comment.filePath);
      }
    },
    [onCommentFileChange, reviewCommentsRef],
  );

  const askCodex = useCallback(
    (commentId: string) => {
      const currentState = stateRef.current;
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        !currentState ||
        !comment ||
        pendingAnswers.current.has(commentId) ||
        comment.body.trim().length === 0 ||
        comment.codexReply?.status === 'loading'
      ) {
        return;
      }

      const request: ReviewAssistantRequest = {
        comment: {
          ...(comment.anchor ? { anchor: comment.anchor } : {}),
          body: comment.body,
          filePath: comment.filePath,
          ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
          sectionId: comment.sectionId,
          ...(comment.side ? { side: comment.side } : {}),
          ...getReviewCommentRangeProps(comment),
        },
        source: currentState.source,
      };

      const reviewKey = `${currentState.root}:${getSourceKey(currentState.source)}`;
      const reviewVersion = getReviewVersion(currentState);
      const acceptReply = () => {
        const latestState = stateRef.current;
        const latestComment = reviewCommentsRef.current.find(
          (candidate) => candidate.id === commentId,
        );
        if (
          !latestState ||
          !latestComment ||
          `${latestState.root}:${getSourceKey(latestState.source)}` !== reviewKey
        ) {
          return false;
        }
        if (
          getReviewVersion(latestState) !== reviewVersion ||
          latestComment.body !== comment.body ||
          latestComment.filePath !== comment.filePath ||
          latestComment.sectionId !== comment.sectionId ||
          latestComment.lineNumber !== comment.lineNumber ||
          latestComment.side !== comment.side ||
          latestComment.startLineNumber !== comment.startLineNumber ||
          latestComment.startSide !== comment.startSide
        ) {
          updateCodexReply(commentId, comment.filePath, {
            error:
              'The review or question changed while the answer was being prepared. Ask again for the current version.',
            status: 'error',
          });
          return false;
        }
        return true;
      };
      pendingAnswers.current.add(commentId);
      updateCodexReply(comment.id, comment.filePath, { status: 'loading' });
      void window.codiff
        .askReviewAssistant(request)
        .then((result) => {
          if (!acceptReply()) {
            return;
          }
          updateCodexReply(
            comment.id,
            comment.filePath,
            result.status === 'ready'
              ? {
                  body: result.reply,
                  ...(result.context ? { context: result.context } : {}),
                  status: 'ready',
                }
              : {
                  error: result.reason,
                  ...(result.context ? { context: result.context } : {}),
                  status: 'error',
                },
          );
        })
        .catch((error: unknown) => {
          if (!acceptReply()) {
            return;
          }
          updateCodexReply(comment.id, comment.filePath, {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        })
        .finally(() => pendingAnswers.current.delete(commentId));
    },
    [reviewCommentsRef, stateRef, updateCodexReply],
  );

  const submitPullRequestComment = useCallback(
    (commentId: string) => {
      const currentState = stateRef.current;
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        currentState?.source.type !== 'pull-request' ||
        !comment ||
        comment.body.trim().length === 0 ||
        comment.remoteSubmit?.status === 'submitting'
      ) {
        return;
      }

      updateRemoteSubmit(comment.id, { status: 'submitting' });
      updateActiveReviewCommentDraft(null);
      void window.codiff
        .submitPullRequestComment({
          comment: toPullRequestReviewComment(comment),
          source: currentState.source,
        })
        .then((submittedComment) => {
          clearCommentFocus(comment.id);
          setReviewComments((current) =>
            current.map((candidate) =>
              candidate.id === comment.id
                ? {
                    author: submittedComment.author,
                    body: submittedComment.body,
                    filePath: submittedComment.filePath,
                    id: submittedComment.id,
                    isReadOnly: true,
                    ...(submittedComment.anchor === 'file' ? { anchor: 'file' as const } : {}),
                    ...(submittedComment.lineNumber != null
                      ? { lineNumber: submittedComment.lineNumber }
                      : {}),
                    sectionId: comment.sectionId,
                    ...(submittedComment.side ? { side: submittedComment.side } : {}),
                    ...getReviewCommentRangeProps(submittedComment),
                    submittedAt: submittedComment.submittedAt,
                    url: submittedComment.url,
                  }
                : candidate,
            ),
          );
          onCommentFileChange(comment.filePath);
        })
        .catch((error: unknown) => {
          updateRemoteSubmit(comment.id, {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        });
    },
    [
      clearCommentFocus,
      onCommentFileChange,
      reviewCommentsRef,
      stateRef,
      updateActiveReviewCommentDraft,
      updateRemoteSubmit,
    ],
  );

  const submitPullRequestReview = useCallback(
    (event: PullRequestReviewEvent, body?: string) => {
      const currentState = stateRef.current;
      if (
        currentState?.source.type !== 'pull-request' ||
        pullRequestReviewSubmitting ||
        isReviewActionDisabled(currentState.source.reviewStatus, event)
      ) {
        return;
      }

      const pendingComments = getPendingPullRequestReviewComments(
        reviewCommentsRef.current,
        activeReviewCommentDraftRef.current,
      );
      if (event === 'COMMENT' && pendingComments.length === 0 && !body?.trim()) {
        return;
      }
      const pendingCommentIds = new Set(pendingComments.map((comment) => comment.id));
      setPullRequestReviewSubmitting(event);
      return window.codiff
        .submitPullRequestReview({
          ...(body ? { body } : {}),
          comments: pendingComments.map((comment) => toPullRequestReviewComment(comment)),
          event,
          source: currentState.source,
        })
        .then(() => {
          updateActiveReviewCommentDraft(null);
          setReviewComments((current) =>
            current.filter((comment) => !pendingCommentIds.has(comment.id)),
          );
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
          throw error;
        })
        .finally(() => {
          setPullRequestReviewSubmitting(null);
        });
    },
    [
      activeReviewCommentDraftRef,
      isReviewActionDisabled,
      pullRequestReviewSubmitting,
      reviewCommentsRef,
      stateRef,
      updateActiveReviewCommentDraft,
    ],
  );

  const hasPendingReviewComments =
    getPendingPullRequestReviewComments(reviewComments, activeReviewCommentDraftState).length > 0;

  return {
    ...commentDrafts,
    askCodex,
    hasPendingReviewComments,
    pullRequestReviewSubmitting,
    reviewComments,
    setReviewComments,
    submitPullRequestComment,
    submitPullRequestReview,
  };
}
