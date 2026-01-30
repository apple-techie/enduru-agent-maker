/**
 * POST /stop-feature endpoint - Stop a specific feature
 */

import type { Request, Response } from 'express';
import type { AutoModeService } from '../../../services/auto-mode-service.js';
import type { AutoModeServiceFacade } from '../../../services/auto-mode/index.js';
import { getErrorMessage, logError } from '../common.js';

/**
 * Create stop feature handler with transition compatibility.
 * Accepts either autoModeService (legacy) or facade (new).
 * Note: stopFeature is feature-scoped (not project-scoped), so a single facade can be used.
 */
export function createStopFeatureHandler(
  autoModeService: AutoModeService,
  facade?: AutoModeServiceFacade
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { featureId } = req.body as { featureId: string };

      if (!featureId) {
        res.status(400).json({ success: false, error: 'featureId is required' });
        return;
      }

      // Use facade if provided, otherwise fall back to autoModeService
      const stopped = facade
        ? await facade.stopFeature(featureId)
        : await autoModeService.stopFeature(featureId);
      res.json({ success: true, stopped });
    } catch (error) {
      logError(error, 'Stop feature failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
