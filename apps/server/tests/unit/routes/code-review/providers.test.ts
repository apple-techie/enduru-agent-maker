/**
 * Unit tests for code-review providers route handler
 *
 * Tests:
 * - Returns provider status list
 * - Returns recommended provider
 * - Force refresh functionality
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createProvidersHandler } from '@/routes/code-review/routes/providers.js';
import type { CodeReviewService } from '@/services/code-review-service.js';
import { createMockExpressContext } from '../../../utils/mocks.js';

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

describe('code-review/providers route', () => {
  let mockCodeReviewService: CodeReviewService;
  let req: Request;
  let res: Response;

  const mockProviderStatuses = [
    {
      provider: 'claude' as const,
      available: true,
      authenticated: true,
      version: '1.0.0',
      issues: [],
    },
    {
      provider: 'codex' as const,
      available: true,
      authenticated: false,
      version: '0.5.0',
      issues: ['Not authenticated'],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    mockCodeReviewService = {
      getProviderStatus: vi.fn().mockResolvedValue(mockProviderStatuses),
      getBestProvider: vi.fn().mockResolvedValue('claude'),
      executeReview: vi.fn(),
      refreshProviderStatus: vi.fn(),
      initialize: vi.fn(),
    } as any;

    const context = createMockExpressContext();
    req = context.req;
    res = context.res;
    req.query = {};
  });

  describe('successful responses', () => {
    it('should return provider status and recommended provider', async () => {
      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        providers: mockProviderStatuses,
        recommended: 'claude',
      });
    });

    it('should use cached status by default', async () => {
      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(mockCodeReviewService.getProviderStatus).toHaveBeenCalledWith(false);
    });

    it('should force refresh when refresh=true query param is set', async () => {
      req.query = { refresh: 'true' };

      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(mockCodeReviewService.getProviderStatus).toHaveBeenCalledWith(true);
    });

    it('should handle no recommended provider', async () => {
      mockCodeReviewService.getBestProvider = vi.fn().mockResolvedValue(null);

      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        providers: mockProviderStatuses,
        recommended: null,
      });
    });

    it('should handle empty provider list', async () => {
      mockCodeReviewService.getProviderStatus = vi.fn().mockResolvedValue([]);
      mockCodeReviewService.getBestProvider = vi.fn().mockResolvedValue(null);

      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        providers: [],
        recommended: null,
      });
    });
  });

  describe('error handling', () => {
    it('should handle getProviderStatus errors', async () => {
      mockCodeReviewService.getProviderStatus = vi
        .fn()
        .mockRejectedValue(new Error('Failed to detect CLIs'));

      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to detect CLIs',
      });
    });

    it('should handle getBestProvider errors gracefully', async () => {
      mockCodeReviewService.getBestProvider = vi
        .fn()
        .mockRejectedValue(new Error('Detection failed'));

      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Detection failed',
      });
    });
  });

  describe('provider priority', () => {
    it('should recommend claude when available and authenticated', async () => {
      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          recommended: 'claude',
        })
      );
    });

    it('should recommend codex when claude is not available', async () => {
      mockCodeReviewService.getBestProvider = vi.fn().mockResolvedValue('codex');

      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          recommended: 'codex',
        })
      );
    });

    it('should recommend cursor as fallback', async () => {
      mockCodeReviewService.getBestProvider = vi.fn().mockResolvedValue('cursor');

      const handler = createProvidersHandler(mockCodeReviewService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          recommended: 'cursor',
        })
      );
    });
  });
});
