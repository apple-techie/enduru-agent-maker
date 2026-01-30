/**
 * POST /context-exists endpoint - Check if context exists for a feature
 */

import type { Request, Response } from 'express';
import type { AutoModeService } from '../../../services/auto-mode-service.js';
import type { AutoModeServiceFacade } from '../../../services/auto-mode/index.js';
import { getErrorMessage, logError } from '../common.js';

/**
 * Create context exists handler with transition compatibility.
 * Accepts either autoModeService (legacy) or facadeFactory (new).
 */
export function createContextExistsHandler(
  autoModeService: AutoModeService,
  facadeFactory?: (projectPath: string) => AutoModeServiceFacade
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body as {
        projectPath: string;
        featureId: string;
      };

      if (!projectPath || !featureId) {
        res.status(400).json({
          success: false,
          error: 'projectPath and featureId are required',
        });
        return;
      }

      // Use facade if factory is provided, otherwise fall back to autoModeService
      if (facadeFactory) {
        const facade = facadeFactory(projectPath);
        const exists = await facade.contextExists(featureId);
        res.json({ success: true, exists });
        return;
      }

      // Legacy path: use autoModeService directly
      const exists = await autoModeService.contextExists(projectPath, featureId);
      res.json({ success: true, exists });
    } catch (error) {
      logError(error, 'Check context exists failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
