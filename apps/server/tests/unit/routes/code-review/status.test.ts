/**
 * Unit tests for code-review status route handler
 *
 * Tests:
 * - Returns correct running status
 * - Returns correct project path
 * - Handles errors gracefully
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createStatusHandler } from '@/routes/code-review/routes/status.js';
import { createMockExpressContext } from '../../../utils/mocks.js';

// Mock the common module to control running state
vi.mock('@/routes/code-review/common.js', () => {
  return {
    isRunning: vi.fn(),
    getReviewStatus: vi.fn(),
    getCurrentProjectPath: vi.fn(),
    setRunningState: vi.fn(),
    getAbortController: vi.fn(),
    getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    logError: vi.fn(),
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

describe('code-review/status route', () => {
  let req: Request;
  let res: Response;

  beforeEach(() => {
    vi.clearAllMocks();

    const context = createMockExpressContext();
    req = context.req;
    res = context.res;
  });

  describe('when no review is running', () => {
    it('should return isRunning: false with null projectPath', async () => {
      const { getReviewStatus } = await import('@/routes/code-review/common.js');
      vi.mocked(getReviewStatus).mockReturnValue({
        isRunning: false,
        projectPath: null,
      });

      const handler = createStatusHandler();
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        isRunning: false,
        projectPath: null,
      });
    });
  });

  describe('when a review is running', () => {
    it('should return isRunning: true with the current project path', async () => {
      const { getReviewStatus } = await import('@/routes/code-review/common.js');
      vi.mocked(getReviewStatus).mockReturnValue({
        isRunning: true,
        projectPath: '/test/project',
      });

      const handler = createStatusHandler();
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        isRunning: true,
        projectPath: '/test/project',
      });
    });
  });

  describe('error handling', () => {
    it('should handle errors gracefully', async () => {
      const { getReviewStatus } = await import('@/routes/code-review/common.js');
      vi.mocked(getReviewStatus).mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const handler = createStatusHandler();
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Unexpected error',
      });
    });
  });
});
