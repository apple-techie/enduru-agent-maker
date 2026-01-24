/**
 * GET /providers endpoint - Get available code review providers
 *
 * Returns the status of all available AI providers that can be used for code reviews.
 */

import type { Request, Response } from 'express';
import type { CodeReviewService } from '../../../services/code-review-service.js';
import { createLogger } from '@automaker/utils';
import { getErrorMessage, logError } from '../common.js';

const logger = createLogger('CodeReview');

export function createProvidersHandler(codeReviewService: CodeReviewService) {
  return async (req: Request, res: Response): Promise<void> => {
    logger.debug('========== /providers endpoint called ==========');

    try {
      // Check if refresh is requested
      const forceRefresh = req.query.refresh === 'true';

      const providers = await codeReviewService.getProviderStatus(forceRefresh);
      const bestProvider = await codeReviewService.getBestProvider();

      res.json({
        success: true,
        providers,
        recommended: bestProvider,
      });
    } catch (error) {
      logError(error, 'Providers handler exception');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
