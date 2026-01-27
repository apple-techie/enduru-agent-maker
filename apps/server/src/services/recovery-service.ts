/**
 * RecoveryService - Crash recovery and feature resumption
 *
 * Manages:
 * - Execution state persistence for crash recovery
 * - Interrupted feature detection and resumption
 * - Context-aware feature restoration (resume from saved conversation)
 * - Pipeline feature resumption via PipelineOrchestrator
 *
 * Key behaviors (from CONTEXT.md):
 * - Auto-resume on server restart
 * - Continue from last step (pipeline status detection)
 * - Restore full conversation (load agent-output.md)
 * - Preserve orphaned worktrees
 */

import path from 'path';
import type { Feature, FeatureStatusWithPipeline } from '@automaker/types';
import { DEFAULT_MAX_CONCURRENCY } from '@automaker/types';
import {
  createLogger,
  readJsonWithRecovery,
  logRecoveryWarning,
  DEFAULT_BACKUP_COUNT,
} from '@automaker/utils';
import {
  getFeatureDir,
  getFeaturesDir,
  getExecutionStatePath,
  ensureAutomakerDir,
} from '@automaker/platform';
import * as secureFs from '../lib/secure-fs.js';
import { getPromptCustomization } from '../lib/settings-helpers.js';
import type { TypedEventBus } from './typed-event-bus.js';
import type { ConcurrencyManager, RunningFeature } from './concurrency-manager.js';
import type { SettingsService } from './settings-service.js';
import type { PipelineStatusInfo } from './pipeline-orchestrator.js';

const logger = createLogger('RecoveryService');

// =============================================================================
// Execution State Types
// =============================================================================

/**
 * Execution state for recovery after server restart
 * Tracks which features were running and auto-loop configuration
 */
export interface ExecutionState {
  version: 1;
  autoLoopWasRunning: boolean;
  maxConcurrency: number;
  projectPath: string;
  branchName: string | null;
  runningFeatureIds: string[];
  savedAt: string;
}

/**
 * Default empty execution state
 */
export const DEFAULT_EXECUTION_STATE: ExecutionState = {
  version: 1,
  autoLoopWasRunning: false,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  projectPath: '',
  branchName: null,
  runningFeatureIds: [],
  savedAt: '',
};

// =============================================================================
// Callback Types - Exported for test mocking and AutoModeService integration
// =============================================================================

/**
 * Function to execute a feature
 */
export type ExecuteFeatureFn = (
  projectPath: string,
  featureId: string,
  useWorktrees: boolean,
  isAutoMode: boolean,
  providedWorktreePath?: string,
  options?: { continuationPrompt?: string; _calledInternally?: boolean }
) => Promise<void>;

/**
 * Function to load a feature by ID
 */
export type LoadFeatureFn = (projectPath: string, featureId: string) => Promise<Feature | null>;

/**
 * Function to detect pipeline status
 */
export type DetectPipelineStatusFn = (
  projectPath: string,
  featureId: string,
  status: FeatureStatusWithPipeline
) => Promise<PipelineStatusInfo>;

/**
 * Function to resume a pipeline feature
 */
export type ResumePipelineFn = (
  projectPath: string,
  feature: Feature,
  useWorktrees: boolean,
  pipelineInfo: PipelineStatusInfo
) => Promise<void>;

/**
 * Function to check if a feature is running
 */
export type IsFeatureRunningFn = (featureId: string) => boolean;

/**
 * Function to acquire a running feature slot
 */
export type AcquireRunningFeatureFn = (options: {
  featureId: string;
  projectPath: string;
  isAutoMode: boolean;
  allowReuse?: boolean;
}) => RunningFeature;

/**
 * Function to release a running feature slot
 */
export type ReleaseRunningFeatureFn = (featureId: string) => void;

// =============================================================================
// RecoveryService Class
// =============================================================================

/**
 * RecoveryService manages crash recovery and feature resumption.
 *
 * Key responsibilities:
 * - Save/load execution state for crash recovery
 * - Detect and resume interrupted features after server restart
 * - Handle pipeline vs non-pipeline resume flows
 * - Restore conversation context from agent-output.md
 */
export class RecoveryService {
  constructor(
    private eventBus: TypedEventBus,
    private concurrencyManager: ConcurrencyManager,
    private settingsService: SettingsService | null,
    // Callback dependencies for delegation
    private executeFeatureFn: ExecuteFeatureFn,
    private loadFeatureFn: LoadFeatureFn,
    private detectPipelineStatusFn: DetectPipelineStatusFn,
    private resumePipelineFn: ResumePipelineFn,
    private isFeatureRunningFn: IsFeatureRunningFn,
    private acquireRunningFeatureFn: AcquireRunningFeatureFn,
    private releaseRunningFeatureFn: ReleaseRunningFeatureFn
  ) {}

  // ===========================================================================
  // Execution State Persistence - For recovery after server restart
  // ===========================================================================

  /**
   * Save execution state for a specific project/worktree
   * @param projectPath - The project path
   * @param branchName - The branch name, or null for main worktree
   * @param maxConcurrency - Maximum concurrent features
   */
  async saveExecutionStateForProject(
    projectPath: string,
    branchName: string | null,
    maxConcurrency: number
  ): Promise<void> {
    try {
      await ensureAutomakerDir(projectPath);
      const statePath = getExecutionStatePath(projectPath);
      const runningFeatureIds = this.concurrencyManager
        .getAllRunning()
        .filter((f) => f.projectPath === projectPath)
        .map((f) => f.featureId);

      const state: ExecutionState = {
        version: 1,
        autoLoopWasRunning: true,
        maxConcurrency,
        projectPath,
        branchName,
        runningFeatureIds,
        savedAt: new Date().toISOString(),
      };
      await secureFs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
      const worktreeDesc = branchName ? `worktree ${branchName}` : 'main worktree';
      logger.info(
        `Saved execution state for ${worktreeDesc} in ${projectPath}: ${runningFeatureIds.length} running features`
      );
    } catch (error) {
      const worktreeDesc = branchName ? `worktree ${branchName}` : 'main worktree';
      logger.error(`Failed to save execution state for ${worktreeDesc} in ${projectPath}:`, error);
    }
  }

  /**
   * Save execution state to disk for recovery after server restart (legacy global)
   * @param projectPath - The project path
   * @param autoLoopWasRunning - Whether auto loop was running
   * @param maxConcurrency - Maximum concurrent features
   */
  async saveExecutionState(
    projectPath: string,
    autoLoopWasRunning: boolean = false,
    maxConcurrency: number = DEFAULT_MAX_CONCURRENCY
  ): Promise<void> {
    try {
      await ensureAutomakerDir(projectPath);
      const statePath = getExecutionStatePath(projectPath);
      const runningFeatureIds = this.concurrencyManager.getAllRunning().map((rf) => rf.featureId);
      const state: ExecutionState = {
        version: 1,
        autoLoopWasRunning,
        maxConcurrency,
        projectPath,
        branchName: null, // Legacy global auto mode uses main worktree
        runningFeatureIds,
        savedAt: new Date().toISOString(),
      };
      await secureFs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
      logger.info(`Saved execution state: ${state.runningFeatureIds.length} running features`);
    } catch (error) {
      logger.error('Failed to save execution state:', error);
    }
  }

  /**
   * Load execution state from disk
   * @param projectPath - The project path
   */
  async loadExecutionState(projectPath: string): Promise<ExecutionState> {
    try {
      const statePath = getExecutionStatePath(projectPath);
      const content = (await secureFs.readFile(statePath, 'utf-8')) as string;
      const state = JSON.parse(content) as ExecutionState;
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load execution state:', error);
      }
      return DEFAULT_EXECUTION_STATE;
    }
  }

  /**
   * Clear execution state (called on successful shutdown or when auto-loop stops)
   * @param projectPath - The project path
   * @param branchName - The branch name, or null for main worktree
   */
  async clearExecutionState(projectPath: string, branchName: string | null = null): Promise<void> {
    try {
      const statePath = getExecutionStatePath(projectPath);
      await secureFs.unlink(statePath);
      const worktreeDesc = branchName ? `worktree ${branchName}` : 'main worktree';
      logger.info(`Cleared execution state for ${worktreeDesc}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to clear execution state:', error);
      }
    }
  }

  // ===========================================================================
  // Context Checking
  // ===========================================================================

  /**
   * Check if context (agent-output.md) exists for a feature
   * @param projectPath - The project path
   * @param featureId - The feature ID
   */
  async contextExists(projectPath: string, featureId: string): Promise<boolean> {
    const featureDir = getFeatureDir(projectPath, featureId);
    const contextPath = path.join(featureDir, 'agent-output.md');
    try {
      await secureFs.access(contextPath);
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Feature Resumption
  // ===========================================================================

  /**
   * Execute a feature with saved context (resume from agent-output.md)
   * @param projectPath - The project path
   * @param featureId - The feature ID
   * @param context - The saved context (agent-output.md content)
   * @param useWorktrees - Whether to use git worktrees
   */
  private async executeFeatureWithContext(
    projectPath: string,
    featureId: string,
    context: string,
    useWorktrees: boolean
  ): Promise<void> {
    const feature = await this.loadFeatureFn(projectPath, featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    // Get customized prompts from settings
    const prompts = await getPromptCustomization(this.settingsService, '[RecoveryService]');

    // Build the feature prompt (simplified - just need basic info for resume)
    const featurePrompt = `## Feature Implementation Task

**Feature ID:** ${feature.id}
**Title:** ${feature.title || 'Untitled Feature'}
**Description:** ${feature.description}
`;

    // Use the resume feature template with variable substitution
    let prompt = prompts.taskExecution.resumeFeatureTemplate;
    prompt = prompt.replace(/\{\{featurePrompt\}\}/g, featurePrompt);
    prompt = prompt.replace(/\{\{previousContext\}\}/g, context);

    return this.executeFeatureFn(projectPath, featureId, useWorktrees, false, undefined, {
      continuationPrompt: prompt,
      _calledInternally: true,
    });
  }

  /**
   * Resume a previously interrupted feature.
   * Detects whether feature is in pipeline or regular state and handles accordingly.
   *
   * @param projectPath - Path to the project
   * @param featureId - ID of the feature to resume
   * @param useWorktrees - Whether to use git worktrees for isolation
   * @param _calledInternally - Internal flag to prevent double-tracking when called from other methods
   */
  async resumeFeature(
    projectPath: string,
    featureId: string,
    useWorktrees = false,
    /** Internal flag: set to true when called from a method that already tracks the feature */
    _calledInternally = false
  ): Promise<void> {
    // Idempotent check: if feature is already being resumed/running, skip silently
    // This prevents race conditions when multiple callers try to resume the same feature
    if (!_calledInternally && this.isFeatureRunningFn(featureId)) {
      logger.info(
        `[RecoveryService] Feature ${featureId} is already being resumed/running, skipping duplicate resume request`
      );
      return;
    }

    this.acquireRunningFeatureFn({
      featureId,
      projectPath,
      isAutoMode: false,
      allowReuse: _calledInternally,
    });

    try {
      // Load feature to check status
      const feature = await this.loadFeatureFn(projectPath, featureId);
      if (!feature) {
        throw new Error(`Feature ${featureId} not found`);
      }

      logger.info(
        `[RecoveryService] Resuming feature ${featureId} (${feature.title}) - current status: ${feature.status}`
      );

      // Check if feature is stuck in a pipeline step via PipelineOrchestrator
      const pipelineInfo = await this.detectPipelineStatusFn(
        projectPath,
        featureId,
        (feature.status || '') as FeatureStatusWithPipeline
      );

      if (pipelineInfo.isPipeline) {
        // Feature stuck in pipeline - use pipeline resume via PipelineOrchestrator
        logger.info(
          `[RecoveryService] Feature ${featureId} is in pipeline step ${pipelineInfo.stepId}, using pipeline resume`
        );
        return await this.resumePipelineFn(projectPath, feature, useWorktrees, pipelineInfo);
      }

      // Normal resume flow for non-pipeline features
      // Check if context exists in .automaker directory
      const hasContext = await this.contextExists(projectPath, featureId);

      if (hasContext) {
        // Load previous context and continue
        const featureDir = getFeatureDir(projectPath, featureId);
        const contextPath = path.join(featureDir, 'agent-output.md');
        const context = (await secureFs.readFile(contextPath, 'utf-8')) as string;
        logger.info(
          `[RecoveryService] Resuming feature ${featureId} with saved context (${context.length} chars)`
        );

        // Emit event for UI notification
        this.eventBus.emitAutoModeEvent('auto_mode_feature_resuming', {
          featureId,
          featureName: feature.title,
          projectPath,
          hasContext: true,
          message: `Resuming feature "${feature.title}" from saved context`,
        });

        return await this.executeFeatureWithContext(projectPath, featureId, context, useWorktrees);
      }

      // No context - feature was interrupted before any agent output was saved
      // Start fresh execution instead of leaving the feature stuck
      logger.info(
        `[RecoveryService] Feature ${featureId} has no saved context - starting fresh execution`
      );

      // Emit event for UI notification
      this.eventBus.emitAutoModeEvent('auto_mode_feature_resuming', {
        featureId,
        featureName: feature.title,
        projectPath,
        hasContext: false,
        message: `Starting fresh execution for interrupted feature "${feature.title}" (no previous context found)`,
      });

      return await this.executeFeatureFn(projectPath, featureId, useWorktrees, false, undefined, {
        _calledInternally: true,
      });
    } finally {
      this.releaseRunningFeatureFn(featureId);
    }
  }

  /**
   * Check for and resume interrupted features after server restart.
   * This should be called during server initialization.
   *
   * @param projectPath - The project path to scan for interrupted features
   */
  async resumeInterruptedFeatures(projectPath: string): Promise<void> {
    logger.info('Checking for interrupted features to resume...');

    // Load all features and find those that were interrupted
    const featuresDir = getFeaturesDir(projectPath);

    try {
      const entries = await secureFs.readdir(featuresDir, { withFileTypes: true });
      // Track features with and without context separately for better logging
      const featuresWithContext: Feature[] = [];
      const featuresWithoutContext: Feature[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const featurePath = path.join(featuresDir, entry.name, 'feature.json');

          // Use recovery-enabled read for corrupted file handling
          const result = await readJsonWithRecovery<Feature | null>(featurePath, null, {
            maxBackups: DEFAULT_BACKUP_COUNT,
            autoRestore: true,
          });

          logRecoveryWarning(result, `Feature ${entry.name}`, logger);

          const feature = result.data;
          if (!feature) {
            // Skip features that couldn't be loaded or recovered
            continue;
          }

          // Check if feature was interrupted (in_progress or pipeline_*)
          if (
            feature.status === 'in_progress' ||
            (feature.status && feature.status.startsWith('pipeline_'))
          ) {
            // Check if context (agent-output.md) exists
            const hasContext = await this.contextExists(projectPath, feature.id);
            if (hasContext) {
              featuresWithContext.push(feature);
              logger.info(
                `Found interrupted feature with context: ${feature.id} (${feature.title}) - status: ${feature.status}`
              );
            } else {
              // No context file - feature was interrupted before any agent output
              // Still include it for resumption (will start fresh)
              featuresWithoutContext.push(feature);
              logger.info(
                `Found interrupted feature without context: ${feature.id} (${feature.title}) - status: ${feature.status} (will restart fresh)`
              );
            }
          }
        }
      }

      // Combine all interrupted features (with and without context)
      const allInterruptedFeatures = [...featuresWithContext, ...featuresWithoutContext];

      if (allInterruptedFeatures.length === 0) {
        logger.info('No interrupted features found');
        return;
      }

      logger.info(
        `Found ${allInterruptedFeatures.length} interrupted feature(s) to resume ` +
          `(${featuresWithContext.length} with context, ${featuresWithoutContext.length} without context)`
      );

      // Emit event to notify UI with context information
      this.eventBus.emitAutoModeEvent('auto_mode_resuming_features', {
        message: `Resuming ${allInterruptedFeatures.length} interrupted feature(s) after server restart`,
        projectPath,
        featureIds: allInterruptedFeatures.map((f) => f.id),
        features: allInterruptedFeatures.map((f) => ({
          id: f.id,
          title: f.title,
          status: f.status,
          branchName: f.branchName ?? null,
          hasContext: featuresWithContext.some((fc) => fc.id === f.id),
        })),
      });

      // Resume each interrupted feature
      for (const feature of allInterruptedFeatures) {
        try {
          // Idempotent check: skip if feature is already being resumed (prevents race conditions)
          if (this.isFeatureRunningFn(feature.id)) {
            logger.info(
              `Feature ${feature.id} (${feature.title}) is already being resumed, skipping`
            );
            continue;
          }

          const hasContext = featuresWithContext.some((fc) => fc.id === feature.id);
          logger.info(
            `Resuming feature: ${feature.id} (${feature.title}) - ${hasContext ? 'continuing from context' : 'starting fresh'}`
          );
          // Use resumeFeature which will detect the existing context and continue,
          // or start fresh if no context exists
          await this.resumeFeature(projectPath, feature.id, true);
        } catch (error) {
          logger.error(`Failed to resume feature ${feature.id}:`, error);
          // Continue with other features
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No features directory found, nothing to resume');
      } else {
        logger.error('Error checking for interrupted features:', error);
      }
    }
  }
}
