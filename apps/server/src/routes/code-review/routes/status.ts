/**
 * GET /status endpoint - Get current code review status
 *
 * Returns whether a code review is currently running and which project.
 */

import type { Request, Response } from 'express';
import { createLogger } from '@automaker/utils';
import { getReviewStatus, getErrorMessage, logError } from '../common.js';

const logger = createLogger('CodeReview');

export function createStatusHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    logger.debug('========== /status endpoint called ==========');

    try {
      const status = getReviewStatus();

      res.json({
        success: true,
        ...status,
      });
    } catch (error) {
      logError(error, 'Status handler exception');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
