/**
 * Code Review Service
 *
 * Orchestrates code reviews using AI providers (Claude, Codex, etc.).
 * Detects available CLIs and executes reviews with structured output.
 *
 * Features:
 * - CLI detection for Claude, Codex, and Cursor
 * - Git diff-based review for changed files
 * - Structured output parsing for review comments
 * - Event streaming for real-time progress updates
 */

import { spawn } from 'child_process';
import { createLogger } from '@automaker/utils';
import { detectAllCLis, type CliDetectionResult } from '../lib/cli-detection.js';
import { streamingQuery, type StreamingQueryOptions } from '../providers/simple-query-service.js';
import type { EventEmitter } from '../lib/events.js';
import type { SettingsService } from './settings-service.js';
import type {
  CodeReviewResult,
  CodeReviewComment,
  CodeReviewSummary,
  CodeReviewVerdict,
  CodeReviewSeverity,
  CodeReviewCategory,
  CodeReviewEvent,
  ModelId,
  ThinkingLevel,
} from '@automaker/types';

const logger = createLogger('CodeReviewService');

/**
 * Maximum number of files allowed in a single review request
 * Prevents DoS attacks via excessive file processing
 */
const MAX_FILES_PER_REVIEW = 100;

/**
 * Maximum length for baseRef string to prevent buffer overflow attacks
 */
const MAX_BASE_REF_LENGTH = 256;

/**
 * Pattern for valid git refs - prevents command injection
 * Allows: HEAD, HEAD~N, branch names, tag names, commit SHAs
 * Disallows: shell metacharacters, spaces, and potentially dangerous characters
 */
const VALID_GIT_REF_PATTERN = /^[a-zA-Z0-9_.~^@/-]+$/;

/**
 * Dangerous patterns that could be used for command injection in git refs
 */
const DANGEROUS_GIT_REF_PATTERNS = [
  /\.\./, // Path traversal
  /^-/, // Flags that could modify git behavior
  /[;&|`$]/, // Shell metacharacters
  /\s/, // Whitespace
];

/**
 * Sanitize and validate a git ref to prevent command injection
 * @throws Error if the ref is invalid or potentially malicious
 */
function sanitizeGitRef(ref: string): string {
  // Check length
  if (ref.length > MAX_BASE_REF_LENGTH) {
    throw new Error('Git reference is too long');
  }

  // Check for empty or whitespace-only refs
  if (!ref.trim()) {
    throw new Error('Git reference cannot be empty');
  }

  // Check against dangerous patterns
  for (const pattern of DANGEROUS_GIT_REF_PATTERNS) {
    if (pattern.test(ref)) {
      throw new Error('Git reference contains invalid characters');
    }
  }

  // Validate against allowed pattern
  if (!VALID_GIT_REF_PATTERN.test(ref)) {
    throw new Error('Git reference contains invalid characters');
  }

  return ref;
}

/**
 * Sanitize file paths to prevent path traversal attacks
 * @throws Error if any file path is potentially malicious
 */
function sanitizeFilePaths(files: string[]): string[] {
  // Limit number of files
  if (files.length > MAX_FILES_PER_REVIEW) {
    throw new Error(`Too many files specified. Maximum is ${MAX_FILES_PER_REVIEW}`);
  }

  return files.map((file) => {
    // Reject absolute paths
    if (file.startsWith('/') || /^[a-zA-Z]:/.test(file)) {
      throw new Error('Absolute file paths are not allowed');
    }

    // Reject path traversal
    if (file.includes('..')) {
      throw new Error('Path traversal is not allowed');
    }

    // Reject null bytes and other control characters
    if (/[\x00-\x1f\x7f]/.test(file)) {
      throw new Error('File path contains invalid characters');
    }

    return file;
  });
}

/**
 * Available CLI providers for code review
 */
export type ReviewProvider = 'claude' | 'codex' | 'cursor' | 'coderabbit';

/**
 * Status of available review providers
 */
export interface ReviewProviderStatus {
  provider: ReviewProvider;
  available: boolean;
  authenticated: boolean;
  version?: string;
  issues: string[];
}

/**
 * Options for executing a code review
 */
export interface ExecuteReviewOptions {
  /** Project path to review */
  projectPath: string;
  /** Specific files to review (if empty, uses git diff) */
  files?: string[];
  /** Git ref to compare against (default: HEAD~1) */
  baseRef?: string;
  /** Categories to focus on */
  categories?: CodeReviewCategory[];
  /** Whether to attempt auto-fixes */
  autoFix?: boolean;
  /** Model to use for the review */
  model?: ModelId;
  /** Thinking level for extended reasoning */
  thinkingLevel?: ThinkingLevel;
  /** Abort controller for cancellation */
  abortController?: AbortController;
}

/**
 * Code Review Service
 *
 * Provides code review functionality using available AI CLI tools.
 * Supports Claude CLI, Codex CLI, and Cursor CLI.
 */
export class CodeReviewService {
  private events: EventEmitter;
  private settingsService: SettingsService | null;
  private cachedProviderStatus: Map<ReviewProvider, ReviewProviderStatus> = new Map();
  private lastStatusCheck: number = 0;
  private readonly STATUS_CACHE_TTL = 60000; // 1 minute

  constructor(events: EventEmitter, settingsService?: SettingsService) {
    this.events = events;
    this.settingsService = settingsService ?? null;
  }

  /**
   * Initialize the service and detect available providers
   */
  async initialize(): Promise<void> {
    logger.info('Initializing CodeReviewService');
    await this.refreshProviderStatus();
  }

  /**
   * Check if the given path is a git worktree (not the main repository)
   */
  async isWorktree(projectPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const gitPath = `${projectPath}/.git`;
      // In a worktree, .git is a file pointing to the main repo, not a directory
      const child = spawn('test', ['-f', gitPath], {
        cwd: projectPath,
        stdio: 'pipe',
      });

      child.on('close', (code) => {
        resolve(code === 0);
      });

      child.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Detect the base branch for comparison
   *
   * Detection strategy:
   * 1. Try to extract base from branch name pattern (e.g., feature/v0.13.0rc-xxx -> v0.13.0rc)
   * 2. Try git merge-base to find common ancestor with likely base branches
   * 3. Fall back to origin default, main, master, or HEAD~1
   */
  async detectBaseBranch(projectPath: string): Promise<string> {
    // Get current branch name
    let currentBranch = '';
    try {
      currentBranch = await this.runGitCommand(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    } catch {
      // Can't get current branch
    }

    // Strategy 1: Extract base from branch naming convention
    // Common patterns: feature/base-xxx, feature/base_xxx, bugfix/base-xxx
    if (currentBranch) {
      // Pattern: feature/v0.13.0rc-1234 -> v0.13.0rc
      // Pattern: feature/main-1234 -> main
      const branchMatch = currentBranch.match(/^(?:feature|bugfix|hotfix)\/([^-_]+(?:\.[^-_]+)*)/i);
      if (branchMatch) {
        const potentialBase = branchMatch[1];
        // Verify this branch exists
        try {
          await this.runGitCommand(projectPath, ['rev-parse', '--verify', potentialBase]);
          logger.debug(`Detected base branch from naming convention: ${potentialBase}`);
          return potentialBase;
        } catch {
          // Branch doesn't exist, continue to other strategies
        }
      }
    }

    // Strategy 2: Try common base branches and find which one has the most recent merge-base
    const candidateBases = ['main', 'master', 'develop', 'dev'];

    // Also try to extract version branches like v0.13.0rc from the current branch
    if (currentBranch) {
      const versionMatch = currentBranch.match(/(v\d+\.\d+(?:\.\d+)?(?:rc)?)/i);
      if (versionMatch) {
        candidateBases.unshift(versionMatch[1]);
      }
    }

    for (const candidate of candidateBases) {
      try {
        // Check if branch exists
        await this.runGitCommand(projectPath, ['rev-parse', '--verify', candidate]);
        // If it exists, use it
        logger.debug(`Using ${candidate} branch as base`);
        return candidate;
      } catch {
        // Branch doesn't exist, try next
      }
    }

    // Strategy 3: Try to get the default branch from origin
    try {
      const defaultBranch = await this.runGitCommand(projectPath, [
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        '--short',
      ]);
      if (defaultBranch) {
        const branch = defaultBranch.replace('origin/', '').trim();
        if (branch) {
          logger.debug(`Detected default branch from origin: ${branch}`);
          return branch;
        }
      }
    } catch {
      // Symbolic ref failed
    }

    // Fall back to HEAD~1 if nothing else works
    logger.debug('No base branch found, falling back to HEAD~1');
    return 'HEAD~1';
  }

  /**
   * Run a git command and return stdout
   */
  private runGitCommand(projectPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `git command failed with code ${code}`));
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Refresh the status of all available providers
   */
  async refreshProviderStatus(): Promise<Map<ReviewProvider, ReviewProviderStatus>> {
    logger.debug('Refreshing provider status');

    const allClis = await detectAllCLis();
    this.cachedProviderStatus.clear();

    for (const [provider, result] of Object.entries(allClis)) {
      if (result) {
        const status = this.convertCliResult(provider as ReviewProvider, result);
        this.cachedProviderStatus.set(provider as ReviewProvider, status);
      }
    }

    this.lastStatusCheck = Date.now();
    return this.cachedProviderStatus;
  }

  /**
   * Get the status of all available providers (cached)
   */
  async getProviderStatus(forceRefresh = false): Promise<ReviewProviderStatus[]> {
    const now = Date.now();
    if (forceRefresh || now - this.lastStatusCheck > this.STATUS_CACHE_TTL) {
      await this.refreshProviderStatus();
    }

    return Array.from(this.cachedProviderStatus.values());
  }

  /**
   * Get the best available provider for code review
   */
  async getBestProvider(): Promise<ReviewProvider | null> {
    const statuses = await this.getProviderStatus();

    // Priority: CodeRabbit > Claude > Codex > Cursor (based on code review capabilities)
    const priority: ReviewProvider[] = ['coderabbit', 'claude', 'codex', 'cursor'];

    for (const provider of priority) {
      const status = statuses.find((s) => s.provider === provider);
      if (status?.available && status?.authenticated) {
        return provider;
      }
    }

    return null;
  }

  /**
   * Execute a code review on the specified project
   */
  async executeReview(options: ExecuteReviewOptions): Promise<CodeReviewResult> {
    const {
      projectPath,
      files,
      baseRef,
      categories,
      autoFix = false,
      model,
      thinkingLevel,
      abortController,
    } = options;

    const reviewId = this.generateId();
    const startTime = Date.now();

    // SECURITY: Sanitize file paths FIRST if provided (before any spawning)
    const sanitizedFiles = files?.length ? sanitizeFilePaths(files) : undefined;

    // SECURITY: Validate baseRef if provided (before any spawning)
    if (baseRef) {
      sanitizeGitRef(baseRef);
    }

    // Determine base ref: if not provided and in worktree, detect base branch
    let effectiveBaseRef = baseRef ?? 'HEAD~1';
    if (!baseRef) {
      const inWorktree = await this.isWorktree(projectPath);
      if (inWorktree) {
        effectiveBaseRef = await this.detectBaseBranch(projectPath);
        logger.info(`Detected worktree, using base branch: ${effectiveBaseRef}`);
      }
    }

    // SECURITY: Sanitize the final git ref (detected branch is trusted but we still validate)
    const sanitizedBaseRef = sanitizeGitRef(effectiveBaseRef);

    logger.info('Starting code review', { reviewId, projectPath, baseRef: sanitizedBaseRef });

    // Emit start event
    this.emitReviewEvent({
      type: 'code_review_start',
      projectPath,
      filesCount: sanitizedFiles?.length ?? 0,
    });

    try {
      // Get files to review
      const filesToReview = sanitizedFiles?.length
        ? sanitizedFiles
        : await this.getChangedFiles(projectPath, sanitizedBaseRef);

      if (filesToReview.length === 0) {
        logger.info('No files to review');
        const emptyResult = this.createEmptyResult(reviewId, model ?? 'claude-sonnet-4-20250514');
        this.emitReviewEvent({
          type: 'code_review_complete',
          projectPath,
          result: emptyResult,
        });
        return emptyResult;
      }

      // Check which provider to use
      const bestProvider = await this.getBestProvider();
      logger.info(`Using review provider: ${bestProvider || 'claude (default)'}`);

      let reviewText: string;
      let comments: CodeReviewComment[];

      if (bestProvider === 'coderabbit') {
        // Use CodeRabbit CLI for code review
        reviewText = await this.executeCodeRabbitReview({
          projectPath,
          baseRef: sanitizedBaseRef,
          files: filesToReview,
          abortController,
          onProgress: (content) => {
            this.emitReviewEvent({
              type: 'code_review_progress',
              projectPath,
              currentFile: filesToReview[0] ?? '',
              filesCompleted: 0,
              filesTotal: filesToReview.length,
              content,
            });
          },
        });

        // Parse CodeRabbit output
        comments = this.parseCodeRabbitOutput(reviewText, filesToReview);
      } else {
        // Use Claude/Codex/Cursor via streamingQuery
        const diffContent = await this.getDiffContent(projectPath, sanitizedBaseRef, filesToReview);
        const prompt = this.buildReviewPrompt(diffContent, filesToReview, categories, autoFix);

        reviewText = await this.executeReviewQuery({
          projectPath,
          prompt,
          model,
          thinkingLevel,
          abortController,
          onProgress: (content) => {
            this.emitReviewEvent({
              type: 'code_review_progress',
              projectPath,
              currentFile: filesToReview[0] ?? '',
              filesCompleted: 0,
              filesTotal: filesToReview.length,
              content,
            });
          },
        });

        // Parse the review output into structured format
        comments = this.parseReviewOutput(reviewText, filesToReview);
      }

      // Emit individual comments
      for (const comment of comments) {
        this.emitReviewEvent({
          type: 'code_review_comment',
          projectPath,
          comment,
        });
      }

      // Build the result
      const result = this.buildReviewResult({
        reviewId,
        comments,
        filesReviewed: filesToReview,
        model: model ?? 'claude-sonnet-4-20250514',
        startTime,
        baseRef: sanitizedBaseRef,
      });

      // Emit completion event
      this.emitReviewEvent({
        type: 'code_review_complete',
        projectPath,
        result,
      });

      logger.info('Code review completed', {
        reviewId,
        commentsCount: comments.length,
        verdict: result.verdict,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Code review failed', { reviewId, error: errorMessage });

      this.emitReviewEvent({
        type: 'code_review_error',
        projectPath,
        error: errorMessage,
      });

      throw error;
    }
  }

  /**
   * Get changed files using git diff
   */
  private async getChangedFiles(projectPath: string, baseRef: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['diff', '--name-only', baseRef], {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          const files = stdout
            .trim()
            .split('\n')
            .filter((f) => f.length > 0);
          resolve(files);
        } else {
          // SECURITY: Log detailed error but return generic message to prevent information disclosure
          logger.error('git diff --name-only failed', { code, stderr });
          reject(new Error('Failed to get changed files from git'));
        }
      });

      child.on('error', (err) => {
        // SECURITY: Log detailed error but return generic message
        logger.error('git diff --name-only spawn error', { error: err.message });
        reject(new Error('Failed to execute git command'));
      });
    });
  }

  /**
   * Get diff content for specified files
   */
  private async getDiffContent(
    projectPath: string,
    baseRef: string,
    files: string[]
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['diff', baseRef, '--', ...files], {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          // SECURITY: Log detailed error but return generic message to prevent information disclosure
          logger.error('git diff failed', { code, stderr });
          reject(new Error('Failed to get diff content from git'));
        }
      });

      child.on('error', (err) => {
        // SECURITY: Log detailed error but return generic message
        logger.error('git diff spawn error', { error: err.message });
        reject(new Error('Failed to execute git command'));
      });
    });
  }

  /**
   * Build the review prompt
   */
  private buildReviewPrompt(
    diffContent: string,
    files: string[],
    categories?: CodeReviewCategory[],
    autoFix?: boolean
  ): string {
    const categoryFocus = categories?.length
      ? `Focus specifically on these categories: ${categories.join(', ')}`
      : 'Review all aspects: code quality, security, performance, testing, and documentation';

    const autoFixInstructions = autoFix
      ? '\n\nIf you find issues that can be automatically fixed, provide the fix in a code block with the filename.'
      : '';

    return `# Code Review Request

## Files to Review
${files.map((f) => `- ${f}`).join('\n')}

## Review Focus
${categoryFocus}

## Instructions
Perform a thorough code review of the following changes. For each issue found:
1. Identify the file and line number(s)
2. Describe the issue clearly
3. Explain why it's a problem
4. Suggest a fix or improvement
5. Rate the severity (critical, high, medium, low, info)
6. Categorize the finding (security, code_quality, performance, testing, documentation, implementation, architecture, tech_stack)

${autoFixInstructions}

## Git Diff
\`\`\`diff
${diffContent}
\`\`\`

## Response Format
Provide your review in the following JSON format:
\`\`\`json
{
  "verdict": "approved" | "changes_requested" | "needs_discussion",
  "summary": "Brief overall summary of the review",
  "comments": [
    {
      "filePath": "path/to/file.ts",
      "startLine": 10,
      "endLine": 15,
      "body": "Description of the issue",
      "severity": "medium",
      "category": "code_quality",
      "suggestedFix": "How to fix it",
      "suggestedCode": "// Optional code snippet"
    }
  ]
}
\`\`\``;
  }

  /**
   * Execute the review query using the provider
   */
  private async executeReviewQuery(options: {
    projectPath: string;
    prompt: string;
    model?: ModelId;
    thinkingLevel?: ThinkingLevel;
    abortController?: AbortController;
    onProgress?: (content: string) => void;
  }): Promise<string> {
    const { projectPath, prompt, model, thinkingLevel, abortController, onProgress } = options;

    const queryOptions: StreamingQueryOptions = {
      prompt,
      model: model ?? 'claude-sonnet-4-20250514',
      cwd: projectPath,
      systemPrompt: `You are an expert code reviewer. Provide detailed, actionable feedback in JSON format.
Your reviews should be thorough but constructive. Focus on helping developers improve their code.
Always explain WHY something is an issue, not just WHAT the issue is.`,
      maxTurns: 1,
      allowedTools: [], // Read-only review, no file modifications
      thinkingLevel,
      abortController,
      readOnly: true,
      onText: onProgress,
    };

    const result = await streamingQuery(queryOptions);
    return result.text;
  }

  /**
   * Execute a code review using CodeRabbit CLI
   *
   * CodeRabbit CLI usage:
   *   coderabbit review --plain --base <branch> -t all --cwd <path>
   *
   * Note: CodeRabbit doesn't accept specific file arguments - it reviews
   * all changes between the base branch and current HEAD in the working directory.
   */
  private async executeCodeRabbitReview(options: {
    projectPath: string;
    baseRef: string;
    files?: string[];
    abortController?: AbortController;
    onProgress?: (content: string) => void;
  }): Promise<string> {
    const { projectPath, baseRef, abortController, onProgress } = options;

    return new Promise((resolve, reject) => {
      // Build command args: coderabbit review --plain --base <branch> -t all --cwd <path>
      // Note: CodeRabbit doesn't support reviewing specific files, it reviews all changes
      const args = ['review', '--plain', '--base', baseRef, '-t', 'all', '--cwd', projectPath];

      logger.info('Executing CodeRabbit CLI', { args, projectPath });

      const child = spawn('coderabbit', args, {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Ensure API key is available if stored in settings
          // CodeRabbit CLI will use CODERABBIT_API_KEY env var
        },
      });

      let stdout = '';
      let stderr = '';

      // Handle abort signal
      if (abortController) {
        abortController.signal.addEventListener('abort', () => {
          child.kill('SIGTERM');
        });
      }

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (onProgress) {
          onProgress(chunk);
        }
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else if (abortController?.signal.aborted) {
          reject(new Error('Code review was cancelled'));
        } else {
          logger.error('CodeRabbit CLI failed', { code, stderr });
          reject(new Error(`CodeRabbit review failed: ${stderr || 'Unknown error'}`));
        }
      });

      child.on('error', (err) => {
        logger.error('CodeRabbit CLI spawn error', { error: err.message });
        reject(new Error('Failed to execute CodeRabbit CLI'));
      });
    });
  }

  /**
   * Parse CodeRabbit CLI output into structured comments
   */
  private parseCodeRabbitOutput(output: string, files: string[]): CodeReviewComment[] {
    const comments: CodeReviewComment[] = [];

    // CodeRabbit plain output format varies, but typically includes:
    // - File paths with line numbers
    // - Severity indicators
    // - Issue descriptions
    // Try to parse structured output first, fall back to creating summary comment

    try {
      // Look for JSON in the output (CodeRabbit may output JSON with certain flags)
      const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.comments && Array.isArray(parsed.comments)) {
          for (const comment of parsed.comments) {
            comments.push({
              id: this.generateId(),
              filePath: comment.filePath || comment.file || files[0] || 'unknown',
              startLine: comment.startLine || comment.line || 1,
              endLine: comment.endLine || comment.startLine || comment.line || 1,
              body: comment.body || comment.message || comment.description || '',
              severity: this.validateSeverity(comment.severity),
              category: this.validateCategory(comment.category || comment.type),
              suggestedFix: comment.suggestedFix || comment.suggestion,
              suggestedCode: comment.suggestedCode || comment.fix,
              autoFixed: false,
              createdAt: new Date().toISOString(),
            });
          }
          return comments;
        }
      }

      // Parse line-by-line format
      // Common pattern: "path/to/file.ts:42: [severity] description"
      const lines = output.split('\n');
      let currentComment: Partial<CodeReviewComment> | null = null;

      for (const line of lines) {
        // Match patterns like: "src/file.ts:10: [warning] Issue description"
        const fileLineMatch = line.match(
          /^([^:]+):(\d+):\s*\[?(critical|high|medium|low|warning|error|info)\]?\s*(.+)/i
        );
        if (fileLineMatch) {
          if (currentComment) {
            comments.push(this.finalizeComment(currentComment, files));
          }
          currentComment = {
            filePath: fileLineMatch[1],
            startLine: parseInt(fileLineMatch[2], 10),
            severity: this.mapCodeRabbitSeverity(fileLineMatch[3]),
            body: fileLineMatch[4],
          };
          continue;
        }

        // Match simpler pattern: "src/file.ts: Issue description"
        const simpleMatch = line.match(/^([^:]+):\s*(.+)/);
        if (simpleMatch && !line.startsWith(' ') && simpleMatch[1].includes('.')) {
          if (currentComment) {
            comments.push(this.finalizeComment(currentComment, files));
          }
          currentComment = {
            filePath: simpleMatch[1],
            startLine: 1,
            severity: 'medium',
            body: simpleMatch[2],
          };
          continue;
        }

        // Continuation of current comment
        if (currentComment && line.trim()) {
          currentComment.body = (currentComment.body || '') + '\n' + line.trim();
        }
      }

      if (currentComment) {
        comments.push(this.finalizeComment(currentComment, files));
      }

      // If no structured comments found, create a summary comment
      if (comments.length === 0 && output.trim()) {
        comments.push({
          id: this.generateId(),
          filePath: files[0] || 'review',
          startLine: 1,
          endLine: 1,
          body: output.trim(),
          severity: 'info',
          category: 'code_quality',
          createdAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.warn('Failed to parse CodeRabbit output', { error });
      // Create a single comment with the full output
      if (output.trim()) {
        comments.push({
          id: this.generateId(),
          filePath: files[0] || 'review',
          startLine: 1,
          endLine: 1,
          body: output.trim(),
          severity: 'info',
          category: 'code_quality',
          createdAt: new Date().toISOString(),
        });
      }
    }

    return comments;
  }

  /**
   * Map CodeRabbit severity strings to our severity type
   */
  private mapCodeRabbitSeverity(severity: string): CodeReviewSeverity {
    const normalized = severity.toLowerCase();
    switch (normalized) {
      case 'critical':
      case 'error':
        return 'critical';
      case 'high':
      case 'warning':
        return 'high';
      case 'medium':
        return 'medium';
      case 'low':
        return 'low';
      case 'info':
      default:
        return 'info';
    }
  }

  /**
   * Finalize a partial comment into a complete CodeReviewComment
   */
  private finalizeComment(partial: Partial<CodeReviewComment>, files: string[]): CodeReviewComment {
    return {
      id: this.generateId(),
      filePath: partial.filePath || files[0] || 'unknown',
      startLine: partial.startLine || 1,
      endLine: partial.endLine || partial.startLine || 1,
      body: partial.body || '',
      severity: this.validateSeverity(partial.severity),
      category: this.validateCategory(partial.category),
      suggestedFix: partial.suggestedFix,
      suggestedCode: partial.suggestedCode,
      autoFixed: false,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Parse review output into structured comments
   */
  private parseReviewOutput(reviewText: string, files: string[]): CodeReviewComment[] {
    const comments: CodeReviewComment[] = [];

    try {
      // Try to extract JSON from the response
      const jsonMatch = reviewText.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.comments && Array.isArray(parsed.comments)) {
          for (const comment of parsed.comments) {
            comments.push({
              id: this.generateId(),
              filePath: comment.filePath || files[0] || 'unknown',
              startLine: comment.startLine || 1,
              endLine: comment.endLine || comment.startLine || 1,
              body: comment.body || '',
              severity: this.validateSeverity(comment.severity),
              category: this.validateCategory(comment.category),
              suggestedFix: comment.suggestedFix,
              suggestedCode: comment.suggestedCode,
              autoFixed: false,
              createdAt: new Date().toISOString(),
            });
          }
        }
      } else {
        // No JSON found - fall back to plain text
        logger.warn('Failed to parse review JSON, falling back to text extraction', {
          reason: 'no JSON block found',
        });
        comments.push({
          id: this.generateId(),
          filePath: files[0] || 'unknown',
          startLine: 1,
          endLine: 1,
          body: reviewText,
          severity: 'info',
          category: 'code_quality',
          createdAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.warn('Failed to parse review JSON, falling back to text extraction', { error });
      // Fallback: create a single comment with the full review text
      comments.push({
        id: this.generateId(),
        filePath: files[0] || 'unknown',
        startLine: 1,
        endLine: 1,
        body: reviewText,
        severity: 'info',
        category: 'code_quality',
        createdAt: new Date().toISOString(),
      });
    }

    return comments;
  }

  /**
   * Validate and normalize severity level
   */
  private validateSeverity(severity: unknown): CodeReviewSeverity {
    const validSeverities: CodeReviewSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
    if (typeof severity === 'string' && validSeverities.includes(severity as CodeReviewSeverity)) {
      return severity as CodeReviewSeverity;
    }
    return 'medium';
  }

  /**
   * Validate and normalize category
   */
  private validateCategory(category: unknown): CodeReviewCategory {
    const validCategories: CodeReviewCategory[] = [
      'tech_stack',
      'security',
      'code_quality',
      'implementation',
      'architecture',
      'performance',
      'testing',
      'documentation',
    ];
    if (typeof category === 'string' && validCategories.includes(category as CodeReviewCategory)) {
      return category as CodeReviewCategory;
    }
    return 'code_quality';
  }

  /**
   * Build the final review result
   */
  private buildReviewResult(options: {
    reviewId: string;
    comments: CodeReviewComment[];
    filesReviewed: string[];
    model: ModelId;
    startTime: number;
    baseRef?: string;
  }): CodeReviewResult {
    const { reviewId, comments, filesReviewed, model, startTime, baseRef } = options;

    // Determine verdict based on comments
    const verdict = this.determineVerdict(comments);

    // Build summary stats
    const stats = this.buildSummaryStats(comments);

    // Build summary text
    const summary = this.buildSummaryText(verdict, stats, filesReviewed.length);

    return {
      id: reviewId,
      verdict,
      summary,
      comments,
      stats,
      filesReviewed,
      model,
      reviewedAt: new Date().toISOString(),
      gitRef: baseRef,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Determine the overall verdict based on comments
   */
  private determineVerdict(comments: CodeReviewComment[]): CodeReviewVerdict {
    const hasCritical = comments.some((c) => c.severity === 'critical');
    const hasHigh = comments.some((c) => c.severity === 'high');

    if (hasCritical) {
      return 'changes_requested';
    }
    if (hasHigh) {
      return 'needs_discussion';
    }
    if (comments.length === 0) {
      return 'approved';
    }
    // If only medium/low/info issues, approve
    return 'approved';
  }

  /**
   * Build summary statistics
   */
  private buildSummaryStats(comments: CodeReviewComment[]): CodeReviewSummary {
    const bySeverity: Record<CodeReviewSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };

    const byCategory: Record<CodeReviewCategory, number> = {
      tech_stack: 0,
      security: 0,
      code_quality: 0,
      implementation: 0,
      architecture: 0,
      performance: 0,
      testing: 0,
      documentation: 0,
    };

    let autoFixedCount = 0;

    for (const comment of comments) {
      bySeverity[comment.severity]++;
      byCategory[comment.category]++;
      if (comment.autoFixed) {
        autoFixedCount++;
      }
    }

    return {
      totalComments: comments.length,
      bySeverity,
      byCategory,
      autoFixedCount,
    };
  }

  /**
   * Build a human-readable summary
   */
  private buildSummaryText(
    verdict: CodeReviewVerdict,
    stats: CodeReviewSummary,
    filesCount: number
  ): string {
    if (stats.totalComments === 0) {
      return `Reviewed ${filesCount} file(s). No issues found.`;
    }

    const parts: string[] = [];

    if (stats.bySeverity.critical > 0) {
      parts.push(`${stats.bySeverity.critical} critical`);
    }
    if (stats.bySeverity.high > 0) {
      parts.push(`${stats.bySeverity.high} high`);
    }
    if (stats.bySeverity.medium > 0) {
      parts.push(`${stats.bySeverity.medium} medium`);
    }

    const issuesSummary = parts.length > 0 ? parts.join(', ') + ' priority issues' : 'minor issues';

    const verdictText =
      verdict === 'approved'
        ? 'Approved with suggestions'
        : verdict === 'changes_requested'
          ? 'Changes requested'
          : 'Needs discussion';

    return `${verdictText}. Found ${stats.totalComments} comment(s) across ${filesCount} file(s): ${issuesSummary}.`;
  }

  /**
   * Create an empty result for when there are no files to review
   */
  private createEmptyResult(reviewId: string, model: ModelId): CodeReviewResult {
    return {
      id: reviewId,
      verdict: 'approved',
      summary: 'No changes to review.',
      comments: [],
      stats: {
        totalComments: 0,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        byCategory: {
          tech_stack: 0,
          security: 0,
          code_quality: 0,
          implementation: 0,
          architecture: 0,
          performance: 0,
          testing: 0,
          documentation: 0,
        },
        autoFixedCount: 0,
      },
      filesReviewed: [],
      model,
      reviewedAt: new Date().toISOString(),
      durationMs: 0,
    };
  }

  /**
   * Convert CLI detection result to provider status
   */
  private convertCliResult(
    provider: ReviewProvider,
    result: CliDetectionResult
  ): ReviewProviderStatus {
    return {
      provider,
      available: result.detected && result.cli.installed,
      authenticated: result.cli.authenticated,
      version: result.cli.version,
      issues: result.issues,
    };
  }

  /**
   * Emit a code review event
   */
  private emitReviewEvent(event: CodeReviewEvent): void {
    this.events.emit('code_review:event', event);
  }

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return `cr_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}
