/**
 * useCodeReview Hook
 *
 * Custom hook for interacting with the code review API.
 * Provides functionality to trigger, monitor, and manage code reviews.
 *
 * Features:
 * - Trigger code reviews with customizable options
 * - Real-time progress updates via WebSocket events
 * - Stop in-progress reviews
 * - Check available providers
 * - Track review status and results
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { createLogger } from '@automaker/utils/logger';
import { useAppStore } from '@/store/app-store';
import { getHttpApiClient } from '@/lib/http-api-client';
import { pathsEqual } from '@/lib/utils';
import type {
  CodeReviewResult,
  CodeReviewComment,
  CodeReviewCategory,
  CodeReviewEvent,
  ModelId,
  ThinkingLevel,
} from '@automaker/types';

const logger = createLogger('useCodeReview');

/**
 * Options for triggering a code review
 */
export interface TriggerReviewOptions {
  /** Project path to review (overrides default). Use this for worktree paths. */
  projectPath?: string;
  /** Specific files to review (if empty, reviews git diff) */
  files?: string[];
  /** Git ref to compare against. If not provided and reviewing a worktree, auto-detects base branch. */
  baseRef?: string;
  /** Categories to focus on */
  categories?: CodeReviewCategory[];
  /** Whether to attempt auto-fixes for issues found */
  autoFix?: boolean;
  /** Model to use for the review */
  model?: ModelId;
  /** Thinking level for extended reasoning */
  thinkingLevel?: ThinkingLevel;
}

/**
 * Review progress information
 */
export interface ReviewProgress {
  currentFile: string;
  filesCompleted: number;
  filesTotal: number;
  content?: string;
}

/**
 * Provider status information
 */
export interface ReviewProviderStatus {
  provider: 'claude' | 'codex' | 'cursor' | 'coderabbit';
  available: boolean;
  authenticated: boolean;
  version?: string;
  issues: string[];
}

/**
 * Return type for the useCodeReview hook
 */
export interface UseCodeReviewResult {
  // State
  /** Whether the initial data is loading */
  loading: boolean;
  /** Whether a review is currently in progress */
  reviewing: boolean;
  /** Current error message, if any */
  error: string | null;

  // Data
  /** The most recent review result */
  review: CodeReviewResult | null;
  /** Current review progress (during review) */
  progress: ReviewProgress | null;
  /** Comments accumulated during the review */
  comments: CodeReviewComment[];
  /** Available review providers */
  providers: ReviewProviderStatus[];
  /** Recommended provider for code reviews */
  recommendedProvider: string | null;

  // Actions
  /** Start a new code review */
  triggerReview: (options?: TriggerReviewOptions) => Promise<void>;
  /** Stop the current review */
  stopReview: () => Promise<void>;
  /** Refresh provider status */
  refreshProviders: (forceRefresh?: boolean) => Promise<void>;
  /** Clear the current error */
  clearError: () => void;
  /** Clear the review results */
  clearReview: () => void;
}

/**
 * Hook for managing code reviews
 *
 * @param projectPath - Optional project path override. If not provided, uses current project from store.
 * @returns Code review state and actions
 *
 * @example
 * ```tsx
 * const { triggerReview, reviewing, review, progress, error } = useCodeReview();
 *
 * // Trigger a review with default options
 * await triggerReview();
 *
 * // Trigger a review with specific options
 * await triggerReview({
 *   categories: ['security', 'performance'],
 *   model: 'claude-sonnet-4-20250514',
 * });
 * ```
 */
export function useCodeReview(projectPath?: string): UseCodeReviewResult {
  const { currentProject } = useAppStore();
  const effectiveProjectPath = projectPath ?? currentProject?.path ?? null;

  // State
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<CodeReviewResult | null>(null);
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [comments, setComments] = useState<CodeReviewComment[]>([]);
  const [providers, setProviders] = useState<ReviewProviderStatus[]>([]);
  const [recommendedProvider, setRecommendedProvider] = useState<string | null>(null);

  // Refs for cleanup and tracking
  const isMountedRef = useRef(true);
  // Track the active review path for event matching (may differ from effectiveProjectPath for worktrees)
  const activeReviewPathRef = useRef<string | null>(null);

  /**
   * Refresh provider status
   */
  const refreshProviders = useCallback(async (forceRefresh = false) => {
    if (!isMountedRef.current) return;

    try {
      setLoading(true);
      const api = getHttpApiClient();
      const response = await api.codeReview.getProviders(forceRefresh);

      if (isMountedRef.current) {
        if (response.success) {
          setProviders(response.providers || []);
          setRecommendedProvider(response.recommended || null);
        } else {
          logger.warn('Failed to fetch providers:', response.error);
        }
      }
    } catch (err) {
      if (isMountedRef.current) {
        logger.error('Error fetching providers:', err);
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  /**
   * Check review status
   */
  const checkStatus = useCallback(async () => {
    try {
      const api = getHttpApiClient();
      const response = await api.codeReview.status();

      if (isMountedRef.current && response.success) {
        setReviewing(response.isRunning || false);
      }
    } catch (err) {
      logger.error('Error checking status:', err);
    }
  }, []);

  /**
   * Trigger a new code review
   */
  const triggerReview = useCallback(
    async (options: TriggerReviewOptions = {}) => {
      // Use provided projectPath if available, otherwise fall back to effective path
      const reviewPath = options.projectPath ?? effectiveProjectPath;

      if (!reviewPath) {
        setError('No project selected');
        return;
      }

      if (reviewing) {
        setError('A code review is already in progress');
        return;
      }

      try {
        if (isMountedRef.current) {
          // Track the path being reviewed for event matching
          activeReviewPathRef.current = reviewPath;
          setError(null);
          setReview(null);
          setProgress(null);
          setComments([]);
          setReviewing(true);
        }

        const api = getHttpApiClient();
        const response = await api.codeReview.trigger(reviewPath, {
          files: options.files,
          baseRef: options.baseRef,
          categories: options.categories,
          autoFix: options.autoFix,
          model: options.model,
          thinkingLevel: options.thinkingLevel,
        });

        if (!response.success) {
          throw new Error(response.error || 'Failed to start code review');
        }

        logger.info('Code review triggered successfully', { projectPath: reviewPath });
      } catch (err) {
        if (isMountedRef.current) {
          const errorMessage = err instanceof Error ? err.message : 'Failed to trigger code review';
          logger.error('Error triggering review:', err);
          setError(errorMessage);
          setReviewing(false);
          activeReviewPathRef.current = null;
        }
      }
    },
    [effectiveProjectPath, reviewing]
  );

  /**
   * Stop the current review
   */
  const stopReview = useCallback(async () => {
    try {
      const api = getHttpApiClient();
      const response = await api.codeReview.stop();

      if (isMountedRef.current) {
        if (response.success) {
          setReviewing(false);
          setProgress(null);
          activeReviewPathRef.current = null;
          logger.info('Code review stopped');
        } else {
          setError(response.error || 'Failed to stop review');
        }
      }
    } catch (err) {
      if (isMountedRef.current) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to stop review';
        logger.error('Error stopping review:', err);
        setError(errorMessage);
      }
    }
  }, []);

  /**
   * Clear the current error
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /**
   * Clear the review results
   */
  const clearReview = useCallback(() => {
    setReview(null);
    setComments([]);
    setProgress(null);
    setError(null);
    activeReviewPathRef.current = null;
  }, []);

  /**
   * Handle code review events from WebSocket
   */
  const handleCodeReviewEvent = useCallback(
    (event: CodeReviewEvent) => {
      if (!isMountedRef.current) return;

      // Match events against the active review path (for worktrees) or effective project path
      const matchPath = activeReviewPathRef.current ?? effectiveProjectPath;
      if (matchPath && !pathsEqual(event.projectPath, matchPath)) {
        return;
      }

      switch (event.type) {
        case 'code_review_start':
          logger.info('Code review started', { filesCount: event.filesCount });
          setReviewing(true);
          setProgress({
            currentFile: '',
            filesCompleted: 0,
            filesTotal: event.filesCount,
          });
          setComments([]);
          break;

        case 'code_review_progress':
          setProgress({
            currentFile: event.currentFile,
            filesCompleted: event.filesCompleted,
            filesTotal: event.filesTotal,
            content: event.content,
          });
          break;

        case 'code_review_comment':
          setComments((prev) => [...prev, event.comment]);
          break;

        case 'code_review_complete':
          logger.info('Code review completed', {
            verdict: event.result.verdict,
            commentsCount: event.result.comments.length,
          });
          setReview(event.result);
          setReviewing(false);
          setProgress(null);
          activeReviewPathRef.current = null;
          break;

        case 'code_review_error':
          logger.error('Code review error:', event.error);
          setError(event.error);
          setReviewing(false);
          setProgress(null);
          activeReviewPathRef.current = null;
          break;
      }
    },
    [effectiveProjectPath]
  );

  // Subscribe to WebSocket events
  useEffect(() => {
    isMountedRef.current = true;

    const api = getHttpApiClient();

    // Subscribe to code review events using the codeReview API
    const unsubscribe = api.codeReview.onEvent(handleCodeReviewEvent);

    // Initial status check
    checkStatus();

    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, [handleCodeReviewEvent, checkStatus]);

  // Load providers on mount
  useEffect(() => {
    refreshProviders();
  }, [refreshProviders]);

  return {
    // State
    loading,
    reviewing,
    error,

    // Data
    review,
    progress,
    comments,
    providers,
    recommendedProvider,

    // Actions
    triggerReview,
    stopReview,
    refreshProviders,
    clearError,
    clearReview,
  };
}
