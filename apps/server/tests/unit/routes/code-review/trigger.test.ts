/**
 * Unit tests for code-review trigger route handler
 *
 * Tests:
 * - Parameter validation
 * - Request body validation (security)
 * - Concurrent review prevention
 * - Review execution
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createTriggerHandler } from '@/routes/code-review/routes/trigger.js';
import type { CodeReviewService } from '@/services/code-review-service.js';
import { createMockExpressContext } from '../../../utils/mocks.js';

// Mock the common module to control running state
vi.mock('@/routes/code-review/common.js', () => {
  let running = false;
  return {
    isRunning: vi.fn(() => running),
    setRunningState: vi.fn((state: boolean) => {
      running = state;
    }),
    getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    logError: vi.fn(),
    getAbortController: vi.fn(() => null),
    getCurrentProjectPath: vi.fn(() => null),
  };
});

// Mock logger
vi.mock('@automaker/utils', async () => {
  const actual = await vi.importActual<typeof import('@automaker/utils')>('@automaker/utils');
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

describe('code-review/trigger route', () => {
  let mockCodeReviewService: CodeReviewService;
  let req: Request;
  let res: Response;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset running state
    const { setRunningState, isRunning } = await import('@/routes/code-review/common.js');
    vi.mocked(setRunningState)(false);
    vi.mocked(isRunning).mockReturnValue(false);

    mockCodeReviewService = {
      executeReview: vi.fn().mockResolvedValue({
        id: 'review-123',
        verdict: 'approved',
        summary: 'No issues found',
        comments: [],
        stats: {
          totalComments: 0,
          bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          byCategory: {},
          autoFixedCount: 0,
        },
        filesReviewed: ['src/index.ts'],
        model: 'claude-sonnet-4-20250514',
        reviewedAt: new Date().toISOString(),
        durationMs: 1000,
      }),
      getProviderStatus: vi.fn(),
      getBestProvider: vi.fn(),
      refreshProviderStatus: vi.fn(),
      initialize: vi.fn(),
    } as any;

    const context = createMockExpressContext();
    req = context.req;
    res = context.res;
  });

  describe('parameter validation', () => {
    it('should return 400 if projectPath is missing', async () => {
      req.body = {};

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'projectPath is required',
      });
      expect(mockCodeReviewService.executeReview).not.toHaveBeenCalled();
    });

    it('should return 400 if files is not an array', async () => {
      req.body = {
        projectPath: '/test/project',
        files: 'not-an-array',
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'files must be an array',
      });
    });

    it('should return 400 if too many files', async () => {
      req.body = {
        projectPath: '/test/project',
        files: Array.from({ length: 150 }, (_, i) => `file${i}.ts`),
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Maximum 100 files allowed per request',
      });
    });

    it('should return 400 if file path is too long', async () => {
      req.body = {
        projectPath: '/test/project',
        files: ['a'.repeat(600)],
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'File path too long',
      });
    });

    it('should return 400 if baseRef is not a string', async () => {
      req.body = {
        projectPath: '/test/project',
        baseRef: 123,
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'baseRef must be a string',
      });
    });

    it('should return 400 if baseRef is too long', async () => {
      req.body = {
        projectPath: '/test/project',
        baseRef: 'a'.repeat(300),
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'baseRef is too long',
      });
    });

    it('should return 400 if categories is not an array', async () => {
      req.body = {
        projectPath: '/test/project',
        categories: 'security',
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'categories must be an array',
      });
    });

    it('should return 400 if category is invalid', async () => {
      req.body = {
        projectPath: '/test/project',
        categories: ['security', 'invalid_category'],
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid category: invalid_category',
      });
    });

    it('should return 400 if autoFix is not a boolean', async () => {
      req.body = {
        projectPath: '/test/project',
        autoFix: 'true',
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'autoFix must be a boolean',
      });
    });

    it('should return 400 if thinkingLevel is invalid', async () => {
      req.body = {
        projectPath: '/test/project',
        thinkingLevel: 'invalid',
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid thinkingLevel: invalid',
      });
    });
  });

  describe('concurrent review prevention', () => {
    it('should return 409 if a review is already in progress', async () => {
      const { isRunning } = await import('@/routes/code-review/common.js');
      vi.mocked(isRunning).mockReturnValue(true);

      req.body = { projectPath: '/test/project' };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'A code review is already in progress',
      });
      expect(mockCodeReviewService.executeReview).not.toHaveBeenCalled();
    });
  });

  describe('successful review execution', () => {
    it('should trigger review and return success immediately', async () => {
      req.body = {
        projectPath: '/test/project',
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Code review started',
      });
    });

    it('should pass all options to executeReview', async () => {
      req.body = {
        projectPath: '/test/project',
        files: ['src/index.ts', 'src/utils.ts'],
        baseRef: 'main',
        categories: ['security', 'performance'],
        autoFix: true,
        model: 'claude-opus-4-5-20251101',
        thinkingLevel: 'high',
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      // Wait for async execution
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCodeReviewService.executeReview).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: '/test/project',
          files: ['src/index.ts', 'src/utils.ts'],
          baseRef: 'main',
          categories: ['security', 'performance'],
          autoFix: true,
          model: 'claude-opus-4-5-20251101',
          thinkingLevel: 'high',
          abortController: expect.any(AbortController),
        })
      );
    });

    it('should accept valid categories', async () => {
      const validCategories = [
        'tech_stack',
        'security',
        'code_quality',
        'implementation',
        'architecture',
        'performance',
        'testing',
        'documentation',
      ];

      req.body = {
        projectPath: '/test/project',
        categories: validCategories,
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Code review started',
      });
    });

    it('should accept valid thinking levels', async () => {
      for (const level of ['low', 'medium', 'high']) {
        req.body = {
          projectPath: '/test/project',
          thinkingLevel: level,
        };

        const handler = createTriggerHandler(mockCodeReviewService);
        await handler(req, res);

        expect(res.json).toHaveBeenCalledWith({
          success: true,
          message: 'Code review started',
        });

        vi.clearAllMocks();
      }
    });
  });

  describe('error handling', () => {
    it('should handle service errors gracefully', async () => {
      mockCodeReviewService.executeReview = vi.fn().mockRejectedValue(new Error('Service error'));

      req.body = {
        projectPath: '/test/project',
      };

      const handler = createTriggerHandler(mockCodeReviewService);
      await handler(req, res);

      // Response is sent immediately (async execution)
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Code review started',
      });

      // Wait for async error handling
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Running state should be reset
      const { setRunningState } = await import('@/routes/code-review/common.js');
      expect(setRunningState).toHaveBeenCalledWith(false);
    });
  });
});
