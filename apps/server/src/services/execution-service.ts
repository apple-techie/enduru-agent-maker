/**
 * ExecutionService - Feature execution lifecycle coordination
 *
 * Coordinates feature execution from start to completion:
 * - Feature loading and validation
 * - Worktree resolution
 * - Status updates with persist-before-emit pattern
 * - Agent execution with prompt building
 * - Pipeline step execution
 * - Error classification and failure tracking
 * - Summary extraction and learnings recording
 *
 * This is the heart of the auto-mode system, handling the core execution flow
 * while delegating to specialized services via callbacks.
 */

import path from 'path';
import type { Feature, PlanningMode, ThinkingLevel } from '@automaker/types';
import { createLogger, classifyError, loadContextFiles, recordMemoryUsage } from '@automaker/utils';
import { resolveModelString, DEFAULT_MODELS } from '@automaker/model-resolver';
import { getFeatureDir } from '@automaker/platform';
import { ProviderFactory } from '../providers/provider-factory.js';
import * as secureFs from '../lib/secure-fs.js';
import {
  getPromptCustomization,
  getAutoLoadClaudeMdSetting,
  filterClaudeMdFromContext,
} from '../lib/settings-helpers.js';
import { validateWorkingDirectory } from '../lib/sdk-options.js';
import { extractSummary } from './spec-parser.js';
import type { TypedEventBus } from './typed-event-bus.js';
import type { ConcurrencyManager, RunningFeature } from './concurrency-manager.js';
import type { WorktreeResolver } from './worktree-resolver.js';
import type { SettingsService } from './settings-service.js';
import type { PipelineContext } from './pipeline-orchestrator.js';
import { pipelineService } from './pipeline-service.js';

const logger = createLogger('ExecutionService');

// =============================================================================
// Callback Types - Exported for test mocking and AutoModeService integration
// =============================================================================

/**
 * Function to run the agent with a prompt
 */
export type RunAgentFn = (
  workDir: string,
  featureId: string,
  prompt: string,
  abortController: AbortController,
  projectPath: string,
  imagePaths?: string[],
  model?: string,
  options?: {
    projectPath?: string;
    planningMode?: PlanningMode;
    requirePlanApproval?: boolean;
    previousContent?: string;
    systemPrompt?: string;
    autoLoadClaudeMd?: boolean;
    thinkingLevel?: ThinkingLevel;
    branchName?: string | null;
  }
) => Promise<void>;

/**
 * Function to execute pipeline steps
 */
export type ExecutePipelineFn = (context: PipelineContext) => Promise<void>;

/**
 * Function to update feature status
 */
export type UpdateFeatureStatusFn = (
  projectPath: string,
  featureId: string,
  status: string
) => Promise<void>;

/**
 * Function to load a feature by ID
 */
export type LoadFeatureFn = (projectPath: string, featureId: string) => Promise<Feature | null>;

/**
 * Function to get the planning prompt prefix based on feature's planning mode
 */
export type GetPlanningPromptPrefixFn = (feature: Feature) => Promise<string>;

/**
 * Function to save a feature summary
 */
export type SaveFeatureSummaryFn = (
  projectPath: string,
  featureId: string,
  summary: string
) => Promise<void>;

/**
 * Function to record learnings from a completed feature
 */
export type RecordLearningsFn = (
  projectPath: string,
  feature: Feature,
  agentOutput: string
) => Promise<void>;

/**
 * Function to check if context exists for a feature
 */
export type ContextExistsFn = (projectPath: string, featureId: string) => Promise<boolean>;

/**
 * Function to resume a feature (continues from saved context or starts fresh)
 */
export type ResumeFeatureFn = (
  projectPath: string,
  featureId: string,
  useWorktrees: boolean,
  _calledInternally: boolean
) => Promise<void>;

/**
 * Function to track failure and check if pause threshold is reached
 * Returns true if auto-mode should pause
 */
export type TrackFailureFn = (errorInfo: { type: string; message: string }) => boolean;

/**
 * Function to signal that auto-mode should pause due to failures
 */
export type SignalPauseFn = (errorInfo: { type: string; message: string }) => void;

/**
 * Function to record a successful execution (resets failure tracking)
 */
export type RecordSuccessFn = () => void;

// =============================================================================
// ExecutionService Class
// =============================================================================

/**
 * ExecutionService coordinates feature execution from start to completion.
 *
 * Key responsibilities:
 * - Acquire/release running feature slots via ConcurrencyManager
 * - Build prompts with feature context and planning prefix
 * - Run agent and execute pipeline steps
 * - Track failures and signal pause when threshold reached
 * - Emit lifecycle events (feature_start, feature_complete, error)
 */
export class ExecutionService {
  constructor(
    private eventBus: TypedEventBus,
    private concurrencyManager: ConcurrencyManager,
    private worktreeResolver: WorktreeResolver,
    private settingsService: SettingsService | null,
    // Callback dependencies for delegation
    private runAgentFn: RunAgentFn,
    private executePipelineFn: ExecutePipelineFn,
    private updateFeatureStatusFn: UpdateFeatureStatusFn,
    private loadFeatureFn: LoadFeatureFn,
    private getPlanningPromptPrefixFn: GetPlanningPromptPrefixFn,
    private saveFeatureSummaryFn: SaveFeatureSummaryFn,
    private recordLearningsFn: RecordLearningsFn,
    private contextExistsFn: ContextExistsFn,
    private resumeFeatureFn: ResumeFeatureFn,
    private trackFailureFn: TrackFailureFn,
    private signalPauseFn: SignalPauseFn,
    private recordSuccessFn: RecordSuccessFn,
    private saveExecutionStateFn: (projectPath: string) => Promise<void>,
    private loadContextFilesFn: typeof loadContextFiles
  ) {}

  // ===========================================================================
  // Helper Methods (Private)
  // ===========================================================================

  /**
   * Acquire a running feature slot via ConcurrencyManager
   */
  private acquireRunningFeature(options: {
    featureId: string;
    projectPath: string;
    isAutoMode: boolean;
    allowReuse?: boolean;
  }): RunningFeature {
    return this.concurrencyManager.acquire(options);
  }

  /**
   * Release a running feature slot via ConcurrencyManager
   */
  private releaseRunningFeature(featureId: string, options?: { force?: boolean }): void {
    this.concurrencyManager.release(featureId, options);
  }

  /**
   * Extract a title from a feature description
   * Returns the first line, truncated to 60 characters
   */
  private extractTitleFromDescription(description: string | undefined): string {
    if (!description || !description.trim()) {
      return 'Untitled Feature';
    }

    // Get first line, or first 60 characters if no newline
    const firstLine = description.split('\n')[0].trim();
    if (firstLine.length <= 60) {
      return firstLine;
    }

    // Truncate to 60 characters and add ellipsis
    return firstLine.substring(0, 57) + '...';
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Build the feature prompt with title, description, and verification instructions.
   * This is a public method that can be used by other services.
   *
   * @param feature - The feature to build prompt for
   * @param prompts - The task execution prompts from settings
   * @returns The formatted prompt string
   */
  buildFeaturePrompt(
    feature: Feature,
    taskExecutionPrompts: {
      implementationInstructions: string;
      playwrightVerificationInstructions: string;
    }
  ): string {
    const title = this.extractTitleFromDescription(feature.description);

    let prompt = `## Feature Implementation Task

**Feature ID:** ${feature.id}
**Title:** ${title}
**Description:** ${feature.description}
`;

    if (feature.spec) {
      prompt += `
**Specification:**
${feature.spec}
`;
    }

    // Add images note (like old implementation)
    if (feature.imagePaths && feature.imagePaths.length > 0) {
      const imagesList = feature.imagePaths
        .map((img, idx) => {
          const imgPath = typeof img === 'string' ? img : img.path;
          const filename =
            typeof img === 'string'
              ? imgPath.split('/').pop()
              : img.filename || imgPath.split('/').pop();
          const mimeType = typeof img === 'string' ? 'image/*' : img.mimeType || 'image/*';
          return `   ${idx + 1}. ${filename} (${mimeType})\n      Path: ${imgPath}`;
        })
        .join('\n');

      prompt += `
**Context Images Attached:**
The user has attached ${feature.imagePaths.length} image(s) for context. These images are provided both visually (in the initial message) and as files you can read:

${imagesList}

You can use the Read tool to view these images at any time during implementation. Review them carefully before implementing.
`;
    }

    // Add verification instructions based on testing mode
    if (feature.skipTests) {
      // Manual verification - just implement the feature
      prompt += `\n${taskExecutionPrompts.implementationInstructions}`;
    } else {
      // Automated testing - implement and verify with Playwright
      prompt += `\n${taskExecutionPrompts.implementationInstructions}\n\n${taskExecutionPrompts.playwrightVerificationInstructions}`;
    }

    return prompt;
  }

  /**
   * Execute a feature from start to completion.
   *
   * This is the core execution flow:
   * 1. Load feature and validate
   * 2. Check for existing context (redirect to resume if exists)
   * 3. Handle approved plan continuation
   * 4. Resolve worktree path
   * 5. Update status to in_progress
   * 6. Build prompt and run agent
   * 7. Execute pipeline steps
   * 8. Update final status and record learnings
   *
   * @param projectPath - Path to the project
   * @param featureId - ID of the feature to execute
   * @param useWorktrees - Whether to use git worktrees for isolation
   * @param isAutoMode - Whether this is running in auto-mode
   * @param providedWorktreePath - Optional pre-resolved worktree path
   * @param options - Additional options
   */
  async executeFeature(
    projectPath: string,
    featureId: string,
    useWorktrees = false,
    isAutoMode = false,
    providedWorktreePath?: string,
    options?: {
      continuationPrompt?: string;
      /** Internal flag: set to true when called from a method that already tracks the feature */
      _calledInternally?: boolean;
    }
  ): Promise<void> {
    const tempRunningFeature = this.acquireRunningFeature({
      featureId,
      projectPath,
      isAutoMode,
      allowReuse: options?._calledInternally,
    });
    const abortController = tempRunningFeature.abortController;

    // Save execution state when feature starts
    if (isAutoMode) {
      await this.saveExecutionStateFn(projectPath);
    }

    // Declare feature outside try block so it's available in catch for error reporting
    let feature: Feature | null = null;

    try {
      // Validate that project path is allowed using centralized validation
      validateWorkingDirectory(projectPath);

      // Load feature details FIRST to get status and plan info
      feature = await this.loadFeatureFn(projectPath, featureId);
      if (!feature) {
        throw new Error(`Feature ${featureId} not found`);
      }

      // Check if feature has existing context - if so, resume instead of starting fresh
      // Skip this check if we're already being called with a continuation prompt (from resumeFeature)
      if (!options?.continuationPrompt) {
        // If feature has an approved plan but we don't have a continuation prompt yet,
        // we should build one to ensure it proceeds with multi-agent execution
        if (feature.planSpec?.status === 'approved') {
          logger.info(`Feature ${featureId} has approved plan, building continuation prompt`);

          // Get customized prompts from settings
          const prompts = await getPromptCustomization(this.settingsService, '[ExecutionService]');
          const planContent = feature.planSpec.content || '';

          // Build continuation prompt using centralized template
          let continuationPrompt = prompts.taskExecution.continuationAfterApprovalTemplate;
          continuationPrompt = continuationPrompt.replace(/\{\{userFeedback\}\}/g, '');
          continuationPrompt = continuationPrompt.replace(/\{\{approvedPlan\}\}/g, planContent);

          // Recursively call executeFeature with the continuation prompt
          // Feature is already tracked, the recursive call will reuse the entry
          return await this.executeFeature(
            projectPath,
            featureId,
            useWorktrees,
            isAutoMode,
            providedWorktreePath,
            {
              continuationPrompt,
              _calledInternally: true,
            }
          );
        }

        const hasExistingContext = await this.contextExistsFn(projectPath, featureId);
        if (hasExistingContext) {
          logger.info(
            `Feature ${featureId} has existing context, resuming instead of starting fresh`
          );
          // Feature is already tracked, resumeFeature will reuse the entry
          return await this.resumeFeatureFn(projectPath, featureId, useWorktrees, true);
        }
      }

      // Derive workDir from feature.branchName
      // Worktrees should already be created when the feature is added/edited
      let worktreePath: string | null = null;
      const branchName = feature.branchName;

      if (useWorktrees && branchName) {
        // Try to find existing worktree for this branch
        // Worktree should already exist (created when feature was added/edited)
        worktreePath = await this.worktreeResolver.findWorktreeForBranch(projectPath, branchName);

        if (worktreePath) {
          logger.info(`Using worktree for branch "${branchName}": ${worktreePath}`);
        } else {
          // Worktree doesn't exist - log warning and continue with project path
          logger.warn(`Worktree for branch "${branchName}" not found, using project path`);
        }
      }

      // Ensure workDir is always an absolute path for cross-platform compatibility
      const workDir = worktreePath ? path.resolve(worktreePath) : path.resolve(projectPath);

      // Validate that working directory is allowed using centralized validation
      validateWorkingDirectory(workDir);

      // Update running feature with actual worktree info
      tempRunningFeature.worktreePath = worktreePath;
      tempRunningFeature.branchName = branchName ?? null;

      // Update feature status to in_progress BEFORE emitting event
      // This ensures the frontend sees the updated status when it reloads features
      await this.updateFeatureStatusFn(projectPath, featureId, 'in_progress');

      // Emit feature start event AFTER status update so frontend sees correct status
      this.eventBus.emitAutoModeEvent('auto_mode_feature_start', {
        featureId,
        projectPath,
        branchName: feature.branchName ?? null,
        feature: {
          id: featureId,
          title: feature.title || 'Loading...',
          description: feature.description || 'Feature is starting',
        },
      });

      // Load autoLoadClaudeMd setting to determine context loading strategy
      const autoLoadClaudeMd = await getAutoLoadClaudeMdSetting(
        projectPath,
        this.settingsService,
        '[ExecutionService]'
      );

      // Get customized prompts from settings
      const prompts = await getPromptCustomization(this.settingsService, '[ExecutionService]');

      // Build the prompt - use continuation prompt if provided (for recovery after plan approval)
      let prompt: string;
      // Load project context files (CLAUDE.md, CODE_QUALITY.md, etc.) and memory files
      // Context loader uses task context to select relevant memory files
      const contextResult = await this.loadContextFilesFn({
        projectPath,
        fsModule: secureFs as Parameters<typeof loadContextFiles>[0]['fsModule'],
        taskContext: {
          title: feature.title ?? '',
          description: feature.description ?? '',
        },
      });

      // When autoLoadClaudeMd is enabled, filter out CLAUDE.md to avoid duplication
      // (SDK handles CLAUDE.md via settingSources), but keep other context files like CODE_QUALITY.md
      // Note: contextResult.formattedPrompt now includes both context AND memory
      const combinedSystemPrompt = filterClaudeMdFromContext(contextResult, autoLoadClaudeMd);

      if (options?.continuationPrompt) {
        // Continuation prompt is used when recovering from a plan approval
        // The plan was already approved, so skip the planning phase
        prompt = options.continuationPrompt;
        logger.info(`Using continuation prompt for feature ${featureId}`);
      } else {
        // Normal flow: build prompt with planning phase
        const featurePrompt = this.buildFeaturePrompt(feature, prompts.taskExecution);
        const planningPrefix = await this.getPlanningPromptPrefixFn(feature);
        prompt = planningPrefix + featurePrompt;

        // Emit planning mode info
        if (feature.planningMode && feature.planningMode !== 'skip') {
          this.eventBus.emitAutoModeEvent('planning_started', {
            featureId: feature.id,
            mode: feature.planningMode,
            message: `Starting ${feature.planningMode} planning phase`,
          });
        }
      }

      // Extract image paths from feature
      const imagePaths = feature.imagePaths?.map((img) =>
        typeof img === 'string' ? img : img.path
      );

      // Get model from feature and determine provider
      const model = resolveModelString(feature.model, DEFAULT_MODELS.claude);
      const provider = ProviderFactory.getProviderNameForModel(model);
      logger.info(
        `Executing feature ${featureId} with model: ${model}, provider: ${provider} in ${workDir}`
      );

      // Store model and provider in running feature for tracking
      tempRunningFeature.model = model;
      tempRunningFeature.provider = provider;

      // Run the agent with the feature's model and images
      // Context files are passed as system prompt for higher priority
      await this.runAgentFn(
        workDir,
        featureId,
        prompt,
        abortController,
        projectPath,
        imagePaths,
        model,
        {
          projectPath,
          planningMode: feature.planningMode,
          requirePlanApproval: feature.requirePlanApproval,
          systemPrompt: combinedSystemPrompt || undefined,
          autoLoadClaudeMd,
          thinkingLevel: feature.thinkingLevel,
          branchName: feature.branchName ?? null,
        }
      );

      // Check for pipeline steps and execute them
      const pipelineConfig = await pipelineService.getPipelineConfig(projectPath);
      // Filter out excluded pipeline steps and sort by order
      const excludedStepIds = new Set(feature.excludedPipelineSteps || []);
      const sortedSteps = [...(pipelineConfig?.steps || [])]
        .sort((a, b) => a.order - b.order)
        .filter((step) => !excludedStepIds.has(step.id));

      if (sortedSteps.length > 0) {
        // Execute pipeline steps sequentially via PipelineOrchestrator
        await this.executePipelineFn({
          projectPath,
          featureId,
          feature,
          steps: sortedSteps,
          workDir,
          worktreePath,
          branchName: feature.branchName ?? null,
          abortController,
          autoLoadClaudeMd,
          testAttempts: 0,
          maxTestAttempts: 5,
        });
      }

      // Determine final status based on testing mode:
      // - skipTests=false (automated testing): go directly to 'verified' (no manual verify needed)
      // - skipTests=true (manual verification): go to 'waiting_approval' for manual review
      const finalStatus = feature.skipTests ? 'waiting_approval' : 'verified';
      await this.updateFeatureStatusFn(projectPath, featureId, finalStatus);

      // Record success to reset consecutive failure tracking
      this.recordSuccessFn();

      // Record learnings, memory usage, and extract summary after successful feature completion
      try {
        const featureDir = getFeatureDir(projectPath, featureId);
        const outputPath = path.join(featureDir, 'agent-output.md');
        let agentOutput = '';
        try {
          const outputContent = await secureFs.readFile(outputPath, 'utf-8');
          agentOutput =
            typeof outputContent === 'string' ? outputContent : outputContent.toString();
        } catch {
          // Agent output might not exist yet
        }

        // Extract and save summary from agent output
        if (agentOutput) {
          const summary = extractSummary(agentOutput);
          if (summary) {
            logger.info(`Extracted summary for feature ${featureId}`);
            await this.saveFeatureSummaryFn(projectPath, featureId, summary);
          }
        }

        // Record memory usage if we loaded any memory files
        if (contextResult.memoryFiles.length > 0 && agentOutput) {
          await recordMemoryUsage(
            projectPath,
            contextResult.memoryFiles,
            agentOutput,
            true, // success
            secureFs as Parameters<typeof recordMemoryUsage>[4]
          );
        }

        // Extract and record learnings from the agent output
        await this.recordLearningsFn(projectPath, feature, agentOutput);
      } catch (learningError) {
        console.warn('[ExecutionService] Failed to record learnings:', learningError);
      }

      this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        featureName: feature.title,
        branchName: feature.branchName ?? null,
        passes: true,
        message: `Feature completed in ${Math.round(
          (Date.now() - tempRunningFeature.startTime) / 1000
        )}s${finalStatus === 'verified' ? ' - auto-verified' : ''}`,
        projectPath,
        model: tempRunningFeature.model,
        provider: tempRunningFeature.provider,
      });
    } catch (error) {
      const errorInfo = classifyError(error);

      if (errorInfo.isAbort) {
        this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
          featureId,
          featureName: feature?.title,
          branchName: feature?.branchName ?? null,
          passes: false,
          message: 'Feature stopped by user',
          projectPath,
        });
      } else {
        logger.error(`Feature ${featureId} failed:`, error);
        await this.updateFeatureStatusFn(projectPath, featureId, 'backlog');
        this.eventBus.emitAutoModeEvent('auto_mode_error', {
          featureId,
          featureName: feature?.title,
          branchName: feature?.branchName ?? null,
          error: errorInfo.message,
          errorType: errorInfo.type,
          projectPath,
        });

        // Track this failure and check if we should pause auto mode
        // This handles both specific quota/rate limit errors AND generic failures
        // that may indicate quota exhaustion (SDK doesn't always return useful errors)
        const shouldPause = this.trackFailureFn({
          type: errorInfo.type,
          message: errorInfo.message,
        });

        if (shouldPause) {
          this.signalPauseFn({
            type: errorInfo.type,
            message: errorInfo.message,
          });
        }
      }
    } finally {
      logger.info(`Feature ${featureId} execution ended, cleaning up runningFeatures`);
      this.releaseRunningFeature(featureId);

      // Update execution state after feature completes
      if (isAutoMode && projectPath) {
        await this.saveExecutionStateFn(projectPath);
      }
    }
  }

  /**
   * Stop a specific feature by aborting its execution.
   *
   * @param featureId - ID of the feature to stop
   * @returns true if the feature was stopped, false if it wasn't running
   */
  async stopFeature(featureId: string): Promise<boolean> {
    const running = this.concurrencyManager.getRunningFeature(featureId);
    if (!running) {
      return false;
    }

    running.abortController.abort();

    // Remove from running features immediately to allow resume
    // The abort signal will still propagate to stop any ongoing execution
    this.releaseRunningFeature(featureId, { force: true });

    return true;
  }
}
