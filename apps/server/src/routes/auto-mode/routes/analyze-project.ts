/**
 * POST /analyze-project endpoint - Analyze project
 */

import type { Request, Response } from 'express';
import type { AutoModeService } from '../../../services/auto-mode-service.js';
import type { AutoModeServiceFacade } from '../../../services/auto-mode/index.js';
import { createLogger } from '@automaker/utils';
import { getErrorMessage, logError } from '../common.js';

const logger = createLogger('AutoMode');

export function createAnalyzeProjectHandler(
  autoModeService: AutoModeService,
  facadeFactory?: (projectPath: string) => AutoModeServiceFacade
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath } = req.body as { projectPath: string };

      if (!projectPath) {
        res.status(400).json({ success: false, error: 'projectPath is required' });
        return;
      }

      // Use facade if factory is provided, otherwise fall back to autoModeService
      if (facadeFactory) {
        const facade = facadeFactory(projectPath);
        // Start analysis in background
        facade.analyzeProject().catch((error) => {
          logger.error(`[AutoMode] Project analysis error:`, error);
        });

        res.json({ success: true, message: 'Project analysis started' });
        return;
      }

      // Legacy path: use autoModeService directly
      // Start analysis in background
      autoModeService.analyzeProject(projectPath).catch((error) => {
        logger.error(`[AutoMode] Project analysis error:`, error);
      });

      res.json({ success: true, message: 'Project analysis started' });
    } catch (error) {
      logError(error, 'Analyze project failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
