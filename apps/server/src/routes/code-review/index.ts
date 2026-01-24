/**
 * Code Review routes - HTTP API for triggering and managing code reviews
 *
 * Provides endpoints for:
 * - Triggering code reviews on projects
 * - Checking review status
 * - Stopping in-progress reviews
 *
 * Uses the CodeReviewService for actual review execution with AI providers.
 */

import { Router } from 'express';
import type { CodeReviewService } from '../../services/code-review-service.js';
import { validatePathParams } from '../../middleware/validate-paths.js';
import { createTriggerHandler } from './routes/trigger.js';
import { createStatusHandler } from './routes/status.js';
import { createStopHandler } from './routes/stop.js';
import { createProvidersHandler } from './routes/providers.js';

export function createCodeReviewRoutes(codeReviewService: CodeReviewService): Router {
  const router = Router();

  // POST /trigger - Start a new code review
  router.post(
    '/trigger',
    validatePathParams('projectPath'),
    createTriggerHandler(codeReviewService)
  );

  // GET /status - Get current review status
  router.get('/status', createStatusHandler());

  // POST /stop - Stop current review
  router.post('/stop', createStopHandler());

  // GET /providers - Get available providers and their status
  router.get('/providers', createProvidersHandler(codeReviewService));

  return router;
}
