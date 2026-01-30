/**
 * Auto Mode routes - HTTP API for autonomous feature implementation
 *
 * Uses the AutoModeService for real feature execution with Claude Agent SDK.
 * Supports optional facadeFactory for per-project facade creation during migration.
 */

import { Router } from 'express';
import type { AutoModeService } from '../../services/auto-mode-service.js';
import type { AutoModeServiceFacade } from '../../services/auto-mode/index.js';
import { validatePathParams } from '../../middleware/validate-paths.js';
import { createStopFeatureHandler } from './routes/stop-feature.js';
import { createStatusHandler } from './routes/status.js';
import { createRunFeatureHandler } from './routes/run-feature.js';
import { createStartHandler } from './routes/start.js';
import { createStopHandler } from './routes/stop.js';
import { createVerifyFeatureHandler } from './routes/verify-feature.js';
import { createResumeFeatureHandler } from './routes/resume-feature.js';
import { createContextExistsHandler } from './routes/context-exists.js';
import { createAnalyzeProjectHandler } from './routes/analyze-project.js';
import { createFollowUpFeatureHandler } from './routes/follow-up-feature.js';
import { createCommitFeatureHandler } from './routes/commit-feature.js';
import { createApprovePlanHandler } from './routes/approve-plan.js';
import { createResumeInterruptedHandler } from './routes/resume-interrupted.js';

/**
 * Create auto-mode routes with optional facade factory.
 *
 * @param autoModeService - The AutoModeService instance (for backward compatibility)
 * @param facadeFactory - Optional factory for creating per-project facades
 */
export function createAutoModeRoutes(
  autoModeService: AutoModeService,
  facadeFactory?: (projectPath: string) => AutoModeServiceFacade
): Router {
  const router = Router();

  // Auto loop control routes
  router.post(
    '/start',
    validatePathParams('projectPath'),
    createStartHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/stop',
    validatePathParams('projectPath'),
    createStopHandler(autoModeService, facadeFactory)
  );

  // Note: stop-feature doesn't have projectPath, so we pass undefined for facade.
  // When we fully migrate, we can update stop-feature to use a different approach.
  router.post('/stop-feature', createStopFeatureHandler(autoModeService));
  router.post(
    '/status',
    validatePathParams('projectPath?'),
    createStatusHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/run-feature',
    validatePathParams('projectPath'),
    createRunFeatureHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/verify-feature',
    validatePathParams('projectPath'),
    createVerifyFeatureHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/resume-feature',
    validatePathParams('projectPath'),
    createResumeFeatureHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/context-exists',
    validatePathParams('projectPath'),
    createContextExistsHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/analyze-project',
    validatePathParams('projectPath'),
    createAnalyzeProjectHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/follow-up-feature',
    validatePathParams('projectPath', 'imagePaths[]'),
    createFollowUpFeatureHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/commit-feature',
    validatePathParams('projectPath', 'worktreePath?'),
    createCommitFeatureHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/approve-plan',
    validatePathParams('projectPath'),
    createApprovePlanHandler(autoModeService, facadeFactory)
  );
  router.post(
    '/resume-interrupted',
    validatePathParams('projectPath'),
    createResumeInterruptedHandler(autoModeService, facadeFactory)
  );

  return router;
}
