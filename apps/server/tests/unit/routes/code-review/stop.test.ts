/**
 * Unit tests for code-review stop route handler
 *
 * Tests:
 * - Stopping when no review is running
 * - Stopping a running review
 * - Abort controller behavior
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createStopHandler } from '@/routes/code-review/routes/stop.js';
import { createMockExpressContext } from '../../../utils/mocks.js';

// Mock the common module
vi.mock('@/routes/code-review/common.js', () => {
  return {
    isRunning: vi.fn(),
    getAbortController: vi.fn(),
    setRunningState: vi.fn(),
    getReviewStatus: vi.fn(),
    getCurrentProjectPath: vi.fn(),
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

describe('code-review/stop route', () => {
  let req: Request;
  let res: Response;

  beforeEach(() => {
    vi.clearAllMocks();

    const context = createMockExpressContext();
    req = context.req;
    res = context.res;
  });

  describe('when no review is running', () => {
    it('should return success with message that nothing is running', async () => {
      const { isRunning } = await import('@/routes/code-review/common.js');
      vi.mocked(isRunning).mockReturnValue(false);

      const handler = createStopHandler();
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'No code review is currently running',
      });
    });
  });

  describe('when a review is running', () => {
    it('should abort the review and reset running state', async () => {
      const { isRunning, getAbortController, setRunningState } =
        await import('@/routes/code-review/common.js');

      const mockAbortController = {
        abort: vi.fn(),
        signal: { aborted: false },
      };

      vi.mocked(isRunning).mockReturnValue(true);
      vi.mocked(getAbortController).mockReturnValue(mockAbortController as any);

      const handler = createStopHandler();
      await handler(req, res);

      expect(mockAbortController.abort).toHaveBeenCalled();
      expect(setRunningState).toHaveBeenCalledWith(false, null, null);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Code review stopped',
      });
    });

    it('should handle case when abort controller is null', async () => {
      const { isRunning, getAbortController, setRunningState } =
        await import('@/routes/code-review/common.js');

      vi.mocked(isRunning).mockReturnValue(true);
      vi.mocked(getAbortController).mockReturnValue(null);

      const handler = createStopHandler();
      await handler(req, res);

      expect(setRunningState).toHaveBeenCalledWith(false, null, null);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Code review stopped',
      });
    });
  });

  describe('error handling', () => {
    it('should handle errors gracefully', async () => {
      const { isRunning } = await import('@/routes/code-review/common.js');
      vi.mocked(isRunning).mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const handler = createStopHandler();
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Unexpected error',
      });
    });
  });
});
