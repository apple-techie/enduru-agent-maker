/**
 * POST /stop endpoint - Stop the current code review
 *
 * Aborts any running code review operation.
 */

import type { Request, Response } from 'express';
import { createLogger } from '@automaker/utils';
import {
  isRunning,
  getAbortController,
  setRunningState,
  getErrorMessage,
  logError,
} from '../common.js';

const logger = createLogger('CodeReview');

export function createStopHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    logger.info('========== /stop endpoint called ==========');

    try {
      if (!isRunning()) {
        res.json({
          success: true,
          message: 'No code review is currently running',
        });
        return;
      }

      // Abort the current operation
      const abortController = getAbortController();
      if (abortController) {
        abortController.abort();
        logger.info('Code review aborted');
      }

      // Reset state
      setRunningState(false, null, null);

      res.json({
        success: true,
        message: 'Code review stopped',
      });
    } catch (error) {
      logError(error, 'Stop handler exception');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
