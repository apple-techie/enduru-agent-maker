/**
 * Common utilities for code-review routes
 */

import { createLogger } from '@automaker/utils';
import { getErrorMessage as getErrorMessageShared, createLogError } from '../common.js';

const logger = createLogger('CodeReview');

// Re-export shared utilities
export { getErrorMessageShared as getErrorMessage };
export const logError = createLogError(logger);

/**
 * Review state interface
 */
interface ReviewState {
  isRunning: boolean;
  abortController: AbortController | null;
  projectPath: string | null;
}

/**
 * Shared state for code review operations
 * Using an object to avoid mutable `let` exports which can cause issues in ES modules
 */
const reviewState: ReviewState = {
  isRunning: false,
  abortController: null,
  projectPath: null,
};

/**
 * Check if a review is currently running
 */
export function isRunning(): boolean {
  return reviewState.isRunning;
}

/**
 * Get the current abort controller (for stopping reviews)
 */
export function getAbortController(): AbortController | null {
  return reviewState.abortController;
}

/**
 * Get the current project path being reviewed
 */
export function getCurrentProjectPath(): string | null {
  return reviewState.projectPath;
}

/**
 * Set the running state for code review operations
 */
export function setRunningState(
  running: boolean,
  controller: AbortController | null = null,
  projectPath: string | null = null
): void {
  reviewState.isRunning = running;
  reviewState.abortController = controller;
  reviewState.projectPath = projectPath;
}

/**
 * Get the current review status
 */
export function getReviewStatus(): {
  isRunning: boolean;
  projectPath: string | null;
} {
  return {
    isRunning: reviewState.isRunning,
    projectPath: reviewState.projectPath,
  };
}
