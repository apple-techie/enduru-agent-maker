/**
 * POST /trigger endpoint - Trigger a code review
 *
 * Starts an asynchronous code review on the specified project.
 * Progress updates are streamed via WebSocket events.
 */

import type { Request, Response } from 'express';
import type { CodeReviewService } from '../../../services/code-review-service.js';
import type { CodeReviewCategory, ThinkingLevel, ModelId } from '@automaker/types';
import { createLogger } from '@automaker/utils';
import { isRunning, setRunningState, getErrorMessage, logError } from '../common.js';

const logger = createLogger('CodeReview');

/**
 * Maximum number of files allowed per review request
 */
const MAX_FILES_PER_REQUEST = 100;

/**
 * Maximum length for baseRef parameter
 */
const MAX_BASE_REF_LENGTH = 256;

/**
 * Valid categories for code review
 */
const VALID_CATEGORIES: CodeReviewCategory[] = [
  'tech_stack',
  'security',
  'code_quality',
  'implementation',
  'architecture',
  'performance',
  'testing',
  'documentation',
];

/**
 * Valid thinking levels
 */
const VALID_THINKING_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high'];

interface TriggerRequestBody {
  projectPath: string;
  files?: string[];
  baseRef?: string;
  categories?: CodeReviewCategory[];
  autoFix?: boolean;
  model?: ModelId;
  thinkingLevel?: ThinkingLevel;
}

/**
 * Validate and sanitize the request body
 */
function validateRequestBody(body: TriggerRequestBody): { valid: boolean; error?: string } {
  const { files, baseRef, categories, autoFix, thinkingLevel } = body;

  // Validate files array
  if (files !== undefined) {
    if (!Array.isArray(files)) {
      return { valid: false, error: 'files must be an array' };
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      return { valid: false, error: `Maximum ${MAX_FILES_PER_REQUEST} files allowed per request` };
    }
    for (const file of files) {
      if (typeof file !== 'string') {
        return { valid: false, error: 'Each file must be a string' };
      }
      if (file.length > 500) {
        return { valid: false, error: 'File path too long' };
      }
    }
  }

  // Validate baseRef
  if (baseRef !== undefined) {
    if (typeof baseRef !== 'string') {
      return { valid: false, error: 'baseRef must be a string' };
    }
    if (baseRef.length > MAX_BASE_REF_LENGTH) {
      return { valid: false, error: 'baseRef is too long' };
    }
  }

  // Validate categories
  if (categories !== undefined) {
    if (!Array.isArray(categories)) {
      return { valid: false, error: 'categories must be an array' };
    }
    for (const category of categories) {
      if (!VALID_CATEGORIES.includes(category)) {
        return { valid: false, error: `Invalid category: ${category}` };
      }
    }
  }

  // Validate autoFix
  if (autoFix !== undefined && typeof autoFix !== 'boolean') {
    return { valid: false, error: 'autoFix must be a boolean' };
  }

  // Validate thinkingLevel
  if (thinkingLevel !== undefined) {
    if (!VALID_THINKING_LEVELS.includes(thinkingLevel)) {
      return { valid: false, error: `Invalid thinkingLevel: ${thinkingLevel}` };
    }
  }

  return { valid: true };
}

export function createTriggerHandler(codeReviewService: CodeReviewService) {
  return async (req: Request, res: Response): Promise<void> => {
    logger.info('========== /trigger endpoint called ==========');

    try {
      const body = req.body as TriggerRequestBody;
      const { projectPath, files, baseRef, categories, autoFix, model, thinkingLevel } = body;

      // Validate required parameters
      if (!projectPath) {
        res.status(400).json({
          success: false,
          error: 'projectPath is required',
        });
        return;
      }

      // SECURITY: Validate all input parameters
      const validation = validateRequestBody(body);
      if (!validation.valid) {
        res.status(400).json({
          success: false,
          error: validation.error,
        });
        return;
      }

      // Check if a review is already running
      if (isRunning()) {
        res.status(409).json({
          success: false,
          error: 'A code review is already in progress',
        });
        return;
      }

      // Set up abort controller for cancellation
      const abortController = new AbortController();
      setRunningState(true, abortController, projectPath);

      // Start the review in the background
      codeReviewService
        .executeReview({
          projectPath,
          files,
          baseRef,
          categories,
          autoFix,
          model,
          thinkingLevel,
          abortController,
        })
        .catch((error) => {
          logError(error, 'Code review failed');
        })
        .finally(() => {
          setRunningState(false, null, null);
        });

      // Return immediate response
      res.json({
        success: true,
        message: 'Code review started',
      });
    } catch (error) {
      logError(error, 'Trigger handler exception');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
