/**
 * POST /run-feature endpoint - Run a single feature
 */

import type { Request, Response } from 'express';
import type { AutoModeService } from '../../../services/auto-mode-service.js';
import type { AutoModeServiceFacade } from '../../../services/auto-mode/index.js';
import { createLogger } from '@automaker/utils';
import { getErrorMessage, logError } from '../common.js';

const logger = createLogger('AutoMode');

export function createRunFeatureHandler(
  autoModeService: AutoModeService,
  facadeFactory?: (projectPath: string) => AutoModeServiceFacade
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId, useWorktrees } = req.body as {
        projectPath: string;
        featureId: string;
        useWorktrees?: boolean;
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

        // Check per-worktree capacity before starting
        const capacity = await facade.checkWorktreeCapacity(featureId);
        if (!capacity.hasCapacity) {
          const worktreeDesc = capacity.branchName
            ? `worktree "${capacity.branchName}"`
            : 'main worktree';
          res.status(429).json({
            success: false,
            error: `Agent limit reached for ${worktreeDesc} (${capacity.currentAgents}/${capacity.maxAgents}). Wait for running tasks to complete or increase the limit.`,
            details: {
              currentAgents: capacity.currentAgents,
              maxAgents: capacity.maxAgents,
              branchName: capacity.branchName,
            },
          });
          return;
        }

        // Start execution in background
        // executeFeature derives workDir from feature.branchName
        facade
          .executeFeature(featureId, useWorktrees ?? false, false)
          .catch((error) => {
            logger.error(`Feature ${featureId} error:`, error);
          })
          .finally(() => {
            // Release the starting slot when execution completes (success or error)
            // Note: The feature should be in runningFeatures by this point
          });

        res.json({ success: true });
        return;
      }

      // Legacy path: use autoModeService directly
      // Check per-worktree capacity before starting
      const capacity = await autoModeService.checkWorktreeCapacity(projectPath, featureId);
      if (!capacity.hasCapacity) {
        const worktreeDesc = capacity.branchName
          ? `worktree "${capacity.branchName}"`
          : 'main worktree';
        res.status(429).json({
          success: false,
          error: `Agent limit reached for ${worktreeDesc} (${capacity.currentAgents}/${capacity.maxAgents}). Wait for running tasks to complete or increase the limit.`,
          details: {
            currentAgents: capacity.currentAgents,
            maxAgents: capacity.maxAgents,
            branchName: capacity.branchName,
          },
        });
        return;
      }

      // Start execution in background
      // executeFeature derives workDir from feature.branchName
      autoModeService
        .executeFeature(projectPath, featureId, useWorktrees ?? false, false)
        .catch((error) => {
          logger.error(`Feature ${featureId} error:`, error);
        })
        .finally(() => {
          // Release the starting slot when execution completes (success or error)
          // Note: The feature should be in runningFeatures by this point
        });

      res.json({ success: true });
    } catch (error) {
      logError(error, 'Run feature failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
