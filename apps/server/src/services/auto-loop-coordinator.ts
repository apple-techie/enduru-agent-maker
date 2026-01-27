/**
 * AutoLoopCoordinator - Manages the auto-mode loop lifecycle and failure tracking
 *
 * Extracted from AutoModeService to isolate loop control logic (start/stop/pause)
 * into a focused service for maintainability and testability.
 *
 * Key behaviors:
 * - Loop starts per project/worktree with correct config
 * - Loop stops when user clicks stop or no work remains
 * - Failure tracking pauses loop after threshold (agent errors only)
 * - Multiple project loops run concurrently without interference
 */

import type { Feature } from '@automaker/types';
import { createLogger, classifyError } from '@automaker/utils';
import type { TypedEventBus } from './typed-event-bus.js';
import type { ConcurrencyManager } from './concurrency-manager.js';
import type { SettingsService } from './settings-service.js';
import { DEFAULT_MAX_CONCURRENCY } from '@automaker/types';

const logger = createLogger('AutoLoopCoordinator');

// Constants for consecutive failure tracking
const CONSECUTIVE_FAILURE_THRESHOLD = 3; // Pause after 3 consecutive failures
const FAILURE_WINDOW_MS = 60000; // Failures within 1 minute count as consecutive

/**
 * Configuration for auto-mode loop
 */
export interface AutoModeConfig {
  maxConcurrency: number;
  useWorktrees: boolean;
  projectPath: string;
  branchName: string | null; // null = main worktree
}

/**
 * Per-worktree autoloop state for multi-project/worktree support
 */
export interface ProjectAutoLoopState {
  abortController: AbortController;
  config: AutoModeConfig;
  isRunning: boolean;
  consecutiveFailures: { timestamp: number; error: string }[];
  pausedDueToFailures: boolean;
  hasEmittedIdleEvent: boolean;
  branchName: string | null; // null = main worktree
}

/**
 * Generate a unique key for worktree-scoped auto loop state
 * @param projectPath - The project path
 * @param branchName - The branch name, or null for main worktree
 */
export function getWorktreeAutoLoopKey(projectPath: string, branchName: string | null): string {
  const normalizedBranch = branchName === 'main' ? null : branchName;
  return `${projectPath}::${normalizedBranch ?? '__main__'}`;
}

// Callback types for AutoModeService integration
export type ExecuteFeatureFn = (
  projectPath: string,
  featureId: string,
  useWorktrees: boolean,
  isAutoMode: boolean
) => Promise<void>;

export type LoadPendingFeaturesFn = (
  projectPath: string,
  branchName: string | null
) => Promise<Feature[]>;

export type SaveExecutionStateFn = (
  projectPath: string,
  branchName: string | null,
  maxConcurrency: number
) => Promise<void>;

export type ClearExecutionStateFn = (
  projectPath: string,
  branchName: string | null
) => Promise<void>;

export type ResetStuckFeaturesFn = (projectPath: string) => Promise<void>;

export type IsFeatureFinishedFn = (feature: Feature) => boolean;

/**
 * AutoLoopCoordinator manages the auto-mode loop lifecycle and failure tracking.
 * It coordinates feature execution without containing the execution logic itself.
 */
export class AutoLoopCoordinator {
  // Per-project autoloop state (supports multiple concurrent projects)
  private autoLoopsByProject = new Map<string, ProjectAutoLoopState>();

  constructor(
    private eventBus: TypedEventBus,
    private concurrencyManager: ConcurrencyManager,
    private settingsService: SettingsService | null,
    private executeFeatureFn: ExecuteFeatureFn,
    private loadPendingFeaturesFn: LoadPendingFeaturesFn,
    private saveExecutionStateFn: SaveExecutionStateFn,
    private clearExecutionStateFn: ClearExecutionStateFn,
    private resetStuckFeaturesFn: ResetStuckFeaturesFn,
    private isFeatureFinishedFn: IsFeatureFinishedFn,
    private isFeatureRunningFn: (featureId: string) => boolean
  ) {}

  /**
   * Start the auto mode loop for a specific project/worktree (supports multiple concurrent projects and worktrees)
   * @param projectPath - The project to start auto mode for
   * @param branchName - The branch name for worktree scoping, null for main worktree
   * @param maxConcurrency - Maximum concurrent features (default: DEFAULT_MAX_CONCURRENCY)
   */
  async startAutoLoopForProject(
    projectPath: string,
    branchName: string | null = null,
    maxConcurrency?: number
  ): Promise<number> {
    const resolvedMaxConcurrency = await this.resolveMaxConcurrency(
      projectPath,
      branchName,
      maxConcurrency
    );

    // Use worktree-scoped key
    const worktreeKey = getWorktreeAutoLoopKey(projectPath, branchName);

    // Check if this project/worktree already has an active autoloop
    const existingState = this.autoLoopsByProject.get(worktreeKey);
    if (existingState?.isRunning) {
      const worktreeDesc = branchName ? `worktree ${branchName}` : 'main worktree';
      throw new Error(
        `Auto mode is already running for ${worktreeDesc} in project: ${projectPath}`
      );
    }

    // Create new project/worktree autoloop state
    const abortController = new AbortController();
    const config: AutoModeConfig = {
      maxConcurrency: resolvedMaxConcurrency,
      useWorktrees: true,
      projectPath,
      branchName,
    };

    const projectState: ProjectAutoLoopState = {
      abortController,
      config,
      isRunning: true,
      consecutiveFailures: [],
      pausedDueToFailures: false,
      hasEmittedIdleEvent: false,
      branchName,
    };

    this.autoLoopsByProject.set(worktreeKey, projectState);

    const worktreeDesc = branchName ? `worktree ${branchName}` : 'main worktree';
    logger.info(
      `Starting auto loop for ${worktreeDesc} in project: ${projectPath} with maxConcurrency: ${resolvedMaxConcurrency}`
    );

    // Reset any features that were stuck in transient states due to previous server crash
    try {
      await this.resetStuckFeaturesFn(projectPath);
    } catch (error) {
      logger.warn(`[startAutoLoopForProject] Error resetting stuck features:`, error);
      // Don't fail startup due to reset errors
    }

    this.eventBus.emitAutoModeEvent('auto_mode_started', {
      message: `Auto mode started with max ${resolvedMaxConcurrency} concurrent features`,
      projectPath,
      branchName,
      maxConcurrency: resolvedMaxConcurrency,
    });

    // Save execution state for recovery after restart
    await this.saveExecutionStateFn(projectPath, branchName, resolvedMaxConcurrency);

    // Run the loop in the background
    this.runAutoLoopForProject(worktreeKey).catch((error) => {
      const worktreeDescErr = branchName ? `worktree ${branchName}` : 'main worktree';
      logger.error(`Loop error for ${worktreeDescErr} in ${projectPath}:`, error);
      const errorInfo = classifyError(error);
      this.eventBus.emitAutoModeEvent('auto_mode_error', {
        error: errorInfo.message,
        errorType: errorInfo.type,
        projectPath,
        branchName,
      });
    });

    return resolvedMaxConcurrency;
  }

  /**
   * Run the auto loop for a specific project/worktree
   * @param worktreeKey - The worktree key (projectPath::branchName or projectPath::__main__)
   */
  private async runAutoLoopForProject(worktreeKey: string): Promise<void> {
    const projectState = this.autoLoopsByProject.get(worktreeKey);
    if (!projectState) {
      logger.warn(`No project state found for ${worktreeKey}, stopping loop`);
      return;
    }

    const { projectPath, branchName } = projectState.config;
    const worktreeDesc = branchName ? `worktree ${branchName}` : 'main worktree';

    logger.info(
      `[AutoLoop] Starting loop for ${worktreeDesc} in ${projectPath}, maxConcurrency: ${projectState.config.maxConcurrency}`
    );
    let iterationCount = 0;

    while (projectState.isRunning && !projectState.abortController.signal.aborted) {
      iterationCount++;
      try {
        // Count running features for THIS project/worktree only
        const projectRunningCount = await this.getRunningCountForWorktree(projectPath, branchName);

        // Check if we have capacity for this project/worktree
        if (projectRunningCount >= projectState.config.maxConcurrency) {
          logger.debug(
            `[AutoLoop] At capacity (${projectRunningCount}/${projectState.config.maxConcurrency}), waiting...`
          );
          await this.sleep(5000, projectState.abortController.signal);
          continue;
        }

        // Load pending features for this project/worktree
        const pendingFeatures = await this.loadPendingFeaturesFn(projectPath, branchName);

        logger.info(
          `[AutoLoop] Iteration ${iterationCount}: Found ${pendingFeatures.length} pending features, ${projectRunningCount}/${projectState.config.maxConcurrency} running for ${worktreeDesc}`
        );

        if (pendingFeatures.length === 0) {
          // Emit idle event only once when backlog is empty AND no features are running
          if (projectRunningCount === 0 && !projectState.hasEmittedIdleEvent) {
            this.eventBus.emitAutoModeEvent('auto_mode_idle', {
              message: 'No pending features - auto mode idle',
              projectPath,
              branchName,
            });
            projectState.hasEmittedIdleEvent = true;
            logger.info(`[AutoLoop] Backlog complete, auto mode now idle for ${worktreeDesc}`);
          } else if (projectRunningCount > 0) {
            logger.info(
              `[AutoLoop] No pending features available, ${projectRunningCount} still running, waiting...`
            );
          } else {
            logger.warn(
              `[AutoLoop] No pending features found for ${worktreeDesc} (branchName: ${branchName === null ? 'null (main)' : branchName}). Check server logs for filtering details.`
            );
          }
          await this.sleep(10000, projectState.abortController.signal);
          continue;
        }

        // Find a feature not currently running and not yet finished
        const nextFeature = pendingFeatures.find(
          (f) => !this.isFeatureRunningFn(f.id) && !this.isFeatureFinishedFn(f)
        );

        if (nextFeature) {
          logger.info(`[AutoLoop] Starting feature ${nextFeature.id}: ${nextFeature.title}`);
          // Reset idle event flag since we're doing work again
          projectState.hasEmittedIdleEvent = false;
          // Start feature execution in background
          this.executeFeatureFn(
            projectPath,
            nextFeature.id,
            projectState.config.useWorktrees,
            true
          ).catch((error) => {
            logger.error(`Feature ${nextFeature.id} error:`, error);
          });
        } else {
          logger.debug(`[AutoLoop] All pending features are already running`);
        }

        await this.sleep(2000, projectState.abortController.signal);
      } catch (error) {
        // Check if this is an abort error
        if (projectState.abortController.signal.aborted) {
          break;
        }
        logger.error(`[AutoLoop] Loop iteration error for ${projectPath}:`, error);
        await this.sleep(5000, projectState.abortController.signal);
      }
    }

    // Mark as not running when loop exits
    projectState.isRunning = false;
    logger.info(
      `[AutoLoop] Loop stopped for project: ${projectPath} after ${iterationCount} iterations`
    );
  }

  /**
   * Stop the auto mode loop for a specific project/worktree
   * @param projectPath - The project to stop auto mode for
   * @param branchName - The branch name, or null for main worktree
   */
  async stopAutoLoopForProject(
    projectPath: string,
    branchName: string | null = null
  ): Promise<number> {
    const worktreeKey = getWorktreeAutoLoopKey(projectPath, branchName);
    const projectState = this.autoLoopsByProject.get(worktreeKey);
    if (!projectState) {
      const worktreeDesc = branchName ? `worktree ${branchName}` : 'main worktree';
      logger.warn(`No auto loop running for ${worktreeDesc} in project: ${projectPath}`);
      return 0;
    }

    const wasRunning = projectState.isRunning;
    projectState.isRunning = false;
    projectState.abortController.abort();

    // Clear execution state when auto-loop is explicitly stopped
    await this.clearExecutionStateFn(projectPath, branchName);

    // Emit stop event
    if (wasRunning) {
      this.eventBus.emitAutoModeEvent('auto_mode_stopped', {
        message: 'Auto mode stopped',
        projectPath,
        branchName,
      });
    }

    // Remove from map
    this.autoLoopsByProject.delete(worktreeKey);

    return await this.getRunningCountForWorktree(projectPath, branchName);
  }

  /**
   * Check if auto mode is running for a specific project/worktree
   * @param projectPath - The project path
   * @param branchName - The branch name, or null for main worktree
   */
  isAutoLoopRunningForProject(projectPath: string, branchName: string | null = null): boolean {
    const worktreeKey = getWorktreeAutoLoopKey(projectPath, branchName);
    const projectState = this.autoLoopsByProject.get(worktreeKey);
    return projectState?.isRunning ?? false;
  }

  /**
   * Get auto loop config for a specific project/worktree
   * @param projectPath - The project path
   * @param branchName - The branch name, or null for main worktree
   */
  getAutoLoopConfigForProject(
    projectPath: string,
    branchName: string | null = null
  ): AutoModeConfig | null {
    const worktreeKey = getWorktreeAutoLoopKey(projectPath, branchName);
    const projectState = this.autoLoopsByProject.get(worktreeKey);
    return projectState?.config ?? null;
  }

  /**
   * Get count of running features for a specific worktree
   * Delegates to ConcurrencyManager.
   * @param projectPath - The project path
   * @param branchName - The branch name, or null for main worktree
   */
  async getRunningCountForWorktree(
    projectPath: string,
    branchName: string | null
  ): Promise<number> {
    return this.concurrencyManager.getRunningCountForWorktree(projectPath, branchName);
  }

  /**
   * Track a failure and check if we should pause due to consecutive failures.
   * @param projectPath - The project to track failure for
   * @param errorInfo - Error information
   * @returns true if the loop should be paused
   */
  trackFailureAndCheckPauseForProject(
    projectPath: string,
    errorInfo: { type: string; message: string }
  ): boolean {
    const worktreeKey = getWorktreeAutoLoopKey(projectPath, null);
    const projectState = this.autoLoopsByProject.get(worktreeKey);
    if (!projectState) {
      return false;
    }

    const now = Date.now();

    // Add this failure
    projectState.consecutiveFailures.push({ timestamp: now, error: errorInfo.message });

    // Remove old failures outside the window
    projectState.consecutiveFailures = projectState.consecutiveFailures.filter(
      (f) => now - f.timestamp < FAILURE_WINDOW_MS
    );

    // Check if we've hit the threshold
    if (projectState.consecutiveFailures.length >= CONSECUTIVE_FAILURE_THRESHOLD) {
      return true; // Should pause
    }

    // Also immediately pause for known quota/rate limit errors
    if (errorInfo.type === 'quota_exhausted' || errorInfo.type === 'rate_limit') {
      return true;
    }

    return false;
  }

  /**
   * Signal that we should pause due to repeated failures or quota exhaustion.
   * This will pause the auto loop for a specific project.
   * @param projectPath - The project to pause
   * @param errorInfo - Error information
   */
  signalShouldPauseForProject(
    projectPath: string,
    errorInfo: { type: string; message: string }
  ): void {
    const worktreeKey = getWorktreeAutoLoopKey(projectPath, null);
    const projectState = this.autoLoopsByProject.get(worktreeKey);
    if (!projectState) {
      return;
    }

    if (projectState.pausedDueToFailures) {
      return; // Already paused
    }

    projectState.pausedDueToFailures = true;
    const failureCount = projectState.consecutiveFailures.length;
    logger.info(
      `Pausing auto loop for ${projectPath} after ${failureCount} consecutive failures. Last error: ${errorInfo.type}`
    );

    // Emit event to notify UI
    this.eventBus.emitAutoModeEvent('auto_mode_paused_failures', {
      message:
        failureCount >= CONSECUTIVE_FAILURE_THRESHOLD
          ? `Auto Mode paused: ${failureCount} consecutive failures detected. This may indicate a quota limit or API issue. Please check your usage and try again.`
          : 'Auto Mode paused: Usage limit or API error detected. Please wait for your quota to reset or check your API configuration.',
      errorType: errorInfo.type,
      originalError: errorInfo.message,
      failureCount,
      projectPath,
    });

    // Stop the auto loop for this project
    this.stopAutoLoopForProject(projectPath);
  }

  /**
   * Reset failure tracking for a specific project
   * @param projectPath - The project to reset failure tracking for
   */
  resetFailureTrackingForProject(projectPath: string): void {
    const worktreeKey = getWorktreeAutoLoopKey(projectPath, null);
    const projectState = this.autoLoopsByProject.get(worktreeKey);
    if (projectState) {
      projectState.consecutiveFailures = [];
      projectState.pausedDueToFailures = false;
    }
  }

  /**
   * Record a successful feature completion to reset consecutive failure count for a project
   * @param projectPath - The project to record success for
   */
  recordSuccessForProject(projectPath: string): void {
    const worktreeKey = getWorktreeAutoLoopKey(projectPath, null);
    const projectState = this.autoLoopsByProject.get(worktreeKey);
    if (projectState) {
      projectState.consecutiveFailures = [];
    }
  }

  /**
   * Resolve max concurrency from provided value, settings, or default
   */
  private async resolveMaxConcurrency(
    projectPath: string,
    branchName: string | null,
    provided?: number
  ): Promise<number> {
    if (typeof provided === 'number' && Number.isFinite(provided)) {
      return provided;
    }

    if (!this.settingsService) {
      return DEFAULT_MAX_CONCURRENCY;
    }

    try {
      const settings = await this.settingsService.getGlobalSettings();
      const globalMax =
        typeof settings.maxConcurrency === 'number'
          ? settings.maxConcurrency
          : DEFAULT_MAX_CONCURRENCY;
      const projectId = settings.projects?.find((project) => project.path === projectPath)?.id;
      const autoModeByWorktree = settings.autoModeByWorktree;

      if (projectId && autoModeByWorktree && typeof autoModeByWorktree === 'object') {
        // Normalize branch name to match UI convention:
        // - null/undefined -> '__main__' (main worktree)
        // - 'main' -> '__main__' (matches how UI stores it)
        // - other branch names -> as-is
        const normalizedBranch =
          branchName === null || branchName === undefined || branchName === 'main'
            ? '__main__'
            : branchName;

        // Check for worktree-specific setting using worktreeId
        const worktreeId = `${projectId}::${normalizedBranch}`;

        if (
          worktreeId in autoModeByWorktree &&
          typeof autoModeByWorktree[worktreeId]?.maxConcurrency === 'number'
        ) {
          logger.debug(
            `[resolveMaxConcurrency] Using worktree-specific maxConcurrency for ${worktreeId}: ${autoModeByWorktree[worktreeId].maxConcurrency}`
          );
          return autoModeByWorktree[worktreeId].maxConcurrency;
        }
      }

      return globalMax;
    } catch (error) {
      logger.warn(`[resolveMaxConcurrency] Error reading settings, using default:`, error);
      return DEFAULT_MAX_CONCURRENCY;
    }
  }

  /**
   * Sleep for specified milliseconds, interruptible by abort signal
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const timeout = setTimeout(resolve, ms);

      signal?.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('Aborted'));
      });
    });
  }
}
