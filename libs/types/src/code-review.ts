/**
 * Code Review Types
 *
 * Types for code review functionality in AutoMaker.
 * Used for automated code review results and comments.
 */

import type { ModelId } from './model.js';

/**
 * Severity level of a code review comment
 */
export type CodeReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Category of code review finding
 */
export type CodeReviewCategory =
  | 'tech_stack'
  | 'security'
  | 'code_quality'
  | 'implementation'
  | 'architecture'
  | 'performance'
  | 'testing'
  | 'documentation';

/**
 * Overall verdict of a code review
 */
export type CodeReviewVerdict = 'approved' | 'changes_requested' | 'needs_discussion';

/**
 * A single comment in a code review
 */
export interface CodeReviewComment {
  /** Unique identifier for the comment */
  id: string;
  /** File path relative to project root */
  filePath: string;
  /** Starting line number (1-based) */
  startLine: number;
  /** Ending line number (1-based), same as startLine for single-line comments */
  endLine: number;
  /** The comment text/feedback */
  body: string;
  /** Severity level of the issue */
  severity: CodeReviewSeverity;
  /** Category of the finding */
  category: CodeReviewCategory;
  /** Suggested fix or improvement (if applicable) */
  suggestedFix?: string;
  /** Code snippet showing the suggested change */
  suggestedCode?: string;
  /** Whether this issue was auto-fixed */
  autoFixed?: boolean;
  /** ISO timestamp when the comment was created */
  createdAt: string;
}

/**
 * Summary statistics for a code review
 */
export interface CodeReviewSummary {
  /** Total number of comments */
  totalComments: number;
  /** Count by severity */
  bySeverity: Record<CodeReviewSeverity, number>;
  /** Count by category */
  byCategory: Record<CodeReviewCategory, number>;
  /** Number of issues that were auto-fixed */
  autoFixedCount: number;
}

/**
 * Result of a code review analysis
 */
export interface CodeReviewResult {
  /** Unique identifier for this review */
  id: string;
  /** Overall verdict of the review */
  verdict: CodeReviewVerdict;
  /** Summary of the review findings */
  summary: string;
  /** Detailed review comments */
  comments: CodeReviewComment[];
  /** Aggregated statistics */
  stats: CodeReviewSummary;
  /** Files that were reviewed */
  filesReviewed: string[];
  /** Model used for the review */
  model: ModelId;
  /** ISO timestamp when the review was performed */
  reviewedAt: string;
  /** Git commit SHA or branch that was reviewed (if applicable) */
  gitRef?: string;
  /** Duration of the review in milliseconds */
  durationMs?: number;
}

/**
 * Request payload for code review endpoint
 */
export interface CodeReviewRequest {
  /** Project path to review */
  projectPath: string;
  /** Specific files to review (if empty, reviews git diff) */
  files?: string[];
  /** Git ref to compare against (default: HEAD) */
  baseRef?: string;
  /** Categories to focus on (if empty, reviews all categories) */
  categories?: CodeReviewCategory[];
  /** Whether to attempt auto-fixes for issues found */
  autoFix?: boolean;
}

/**
 * Successful response from code review endpoint
 */
export interface CodeReviewResponse {
  success: true;
  review: CodeReviewResult;
}

/**
 * Error response from code review endpoint
 */
export interface CodeReviewErrorResponse {
  success: false;
  error: string;
}

/**
 * Events emitted during async code review
 */
export type CodeReviewEvent =
  | {
      type: 'code_review_start';
      projectPath: string;
      filesCount: number;
    }
  | {
      type: 'code_review_progress';
      projectPath: string;
      currentFile: string;
      filesCompleted: number;
      filesTotal: number;
      content?: string;
    }
  | {
      type: 'code_review_comment';
      projectPath: string;
      comment: CodeReviewComment;
    }
  | {
      type: 'code_review_complete';
      projectPath: string;
      result: CodeReviewResult;
    }
  | {
      type: 'code_review_error';
      projectPath: string;
      error: string;
    };

/**
 * Stored code review data with metadata for cache
 */
export interface StoredCodeReview {
  /** Unique identifier */
  id: string;
  /** Project path that was reviewed */
  projectPath: string;
  /** Git ref that was reviewed */
  gitRef?: string;
  /** ISO timestamp when review was performed */
  reviewedAt: string;
  /** Model used for review */
  model: ModelId;
  /** The review result */
  result: CodeReviewResult;
  /** ISO timestamp when user viewed this review (undefined = not yet viewed) */
  viewedAt?: string;
}
