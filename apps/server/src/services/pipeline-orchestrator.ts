/**
 * PipelineOrchestrator - Pipeline step execution and coordination
 *
 * Coordinates existing services (AgentExecutor, TestRunnerService, merge endpoint)
 * for pipeline step execution, test runner integration (5-attempt fix loop),
 * and automatic merging on completion.
 */

import path from 'path';
import type {
  Feature,
  PipelineStep,
  PipelineConfig,
  FeatureStatusWithPipeline,
} from '@automaker/types';
import { createLogger, loadContextFiles, classifyError } from '@automaker/utils';
import { getFeatureDir } from '@automaker/platform';
import { resolveModelString, DEFAULT_MODELS } from '@automaker/model-resolver';
import * as secureFs from '../lib/secure-fs.js';
import {
  getPromptCustomization,
  getAutoLoadClaudeMdSetting,
  filterClaudeMdFromContext,
} from '../lib/settings-helpers.js';
import { validateWorkingDirectory } from '../lib/sdk-options.js';
import type { TypedEventBus } from './typed-event-bus.js';
import type { FeatureStateManager } from './feature-state-manager.js';
import type { AgentExecutor } from './agent-executor.js';
import type { WorktreeResolver } from './worktree-resolver.js';
import type { SettingsService } from './settings-service.js';
import type { ConcurrencyManager } from './concurrency-manager.js';
import { pipelineService } from './pipeline-service.js';
import type { TestRunnerService, TestRunStatus } from './test-runner-service.js';

const logger = createLogger('PipelineOrchestrator');

/** Context object shared across pipeline execution */
export interface PipelineContext {
  projectPath: string;
  featureId: string;
  feature: Feature;
  steps: PipelineStep[];
  workDir: string;
  worktreePath: string | null;
  branchName: string | null;
  abortController: AbortController;
  autoLoadClaudeMd: boolean;
  testAttempts: number;
  maxTestAttempts: number;
}

/** Information about pipeline status for resume operations */
export interface PipelineStatusInfo {
  isPipeline: boolean;
  stepId: string | null;
  stepIndex: number;
  totalSteps: number;
  step: PipelineStep | null;
  config: PipelineConfig | null;
}

/** Result types */
export interface StepResult {
  success: boolean;
  testsPassed?: boolean;
  message?: string;
}
export interface MergeResult {
  success: boolean;
  hasConflicts?: boolean;
  needsAgentResolution?: boolean;
  error?: string;
}

/** Callback types for AutoModeService integration */
export type UpdateFeatureStatusFn = (
  projectPath: string,
  featureId: string,
  status: string
) => Promise<void>;
export type BuildFeaturePromptFn = (
  feature: Feature,
  prompts: { implementationInstructions: string; playwrightVerificationInstructions: string }
) => string;
export type ExecuteFeatureFn = (
  projectPath: string,
  featureId: string,
  useWorktrees: boolean,
  useScreenshots: boolean,
  model?: string,
  options?: { _calledInternally?: boolean }
) => Promise<void>;
export type RunAgentFn = (
  workDir: string,
  featureId: string,
  prompt: string,
  abortController: AbortController,
  projectPath: string,
  imagePaths?: string[],
  model?: string,
  options?: Record<string, unknown>
) => Promise<void>;

/**
 * PipelineOrchestrator - Coordinates pipeline step execution
 */
export class PipelineOrchestrator {
  private serverPort: number;

  constructor(
    private eventBus: TypedEventBus,
    private featureStateManager: FeatureStateManager,
    private agentExecutor: AgentExecutor,
    private testRunnerService: TestRunnerService,
    private worktreeResolver: WorktreeResolver,
    private concurrencyManager: ConcurrencyManager,
    private settingsService: SettingsService | null,
    private updateFeatureStatusFn: UpdateFeatureStatusFn,
    private loadContextFilesFn: typeof loadContextFiles,
    private buildFeaturePromptFn: BuildFeaturePromptFn,
    private executeFeatureFn: ExecuteFeatureFn,
    private runAgentFn: RunAgentFn,
    serverPort = 3008
  ) {
    this.serverPort = serverPort;
  }

  /** Execute pipeline steps sequentially */
  async executePipeline(context: PipelineContext): Promise<void> {
    const { projectPath, featureId, feature, steps, workDir, abortController, autoLoadClaudeMd } =
      context;
    logger.info(`Executing ${steps.length} pipeline step(s) for feature ${featureId}`);

    const prompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
    const contextResult = await this.loadContextFilesFn({
      projectPath,
      fsModule: secureFs as Parameters<typeof loadContextFiles>[0]['fsModule'],
      taskContext: { title: feature.title ?? '', description: feature.description ?? '' },
    });
    const contextFilesPrompt = filterClaudeMdFromContext(contextResult, autoLoadClaudeMd);

    const featureDir = getFeatureDir(projectPath, featureId);
    const contextPath = path.join(featureDir, 'agent-output.md');
    let previousContext = '';
    try {
      previousContext = (await secureFs.readFile(contextPath, 'utf-8')) as string;
    } catch {
      /* No context */
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (abortController.signal.aborted) throw new Error('Pipeline execution aborted');

      await this.updateFeatureStatusFn(projectPath, featureId, `pipeline_${step.id}`);
      this.eventBus.emitAutoModeEvent('auto_mode_progress', {
        featureId,
        branchName: feature.branchName ?? null,
        content: `Starting pipeline step ${i + 1}/${steps.length}: ${step.name}`,
        projectPath,
      });
      this.eventBus.emitAutoModeEvent('pipeline_step_started', {
        featureId,
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        totalSteps: steps.length,
        projectPath,
      });

      const prompt = this.buildPipelineStepPrompt(
        step,
        feature,
        previousContext,
        prompts.taskExecution
      );
      const model = resolveModelString(feature.model, DEFAULT_MODELS.claude);

      await this.runAgentFn(
        workDir,
        featureId,
        prompt,
        abortController,
        projectPath,
        undefined,
        model,
        {
          projectPath,
          planningMode: 'skip',
          requirePlanApproval: false,
          previousContent: previousContext,
          systemPrompt: contextFilesPrompt || undefined,
          autoLoadClaudeMd,
          thinkingLevel: feature.thinkingLevel,
        }
      );

      try {
        previousContext = (await secureFs.readFile(contextPath, 'utf-8')) as string;
      } catch {
        /* No update */
      }
      this.eventBus.emitAutoModeEvent('pipeline_step_complete', {
        featureId,
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        totalSteps: steps.length,
        projectPath,
      });
      logger.info(
        `Pipeline step ${i + 1}/${steps.length} (${step.name}) completed for feature ${featureId}`
      );
    }

    logger.info(`All pipeline steps completed for feature ${featureId}`);
    if (context.branchName) {
      const mergeResult = await this.attemptMerge(context);
      if (!mergeResult.success && mergeResult.hasConflicts) {
        logger.info(`Feature ${featureId} has merge conflicts`);
        return;
      }
    }
  }

  /** Build the prompt for a pipeline step */
  buildPipelineStepPrompt(
    step: PipelineStep,
    feature: Feature,
    previousContext: string,
    taskPrompts: { implementationInstructions: string; playwrightVerificationInstructions: string }
  ): string {
    let prompt = `## Pipeline Step: ${step.name}\n\nThis is an automated pipeline step.\n\n### Feature Context\n${this.buildFeaturePromptFn(feature, taskPrompts)}\n\n`;
    if (previousContext) prompt += `### Previous Work\n${previousContext}\n\n`;
    prompt += `### Pipeline Step Instructions\n${step.instructions}\n\n### Task\nComplete the pipeline step instructions above.`;
    return prompt;
  }

  /** Detect if a feature is stuck in a pipeline step */
  async detectPipelineStatus(
    projectPath: string,
    featureId: string,
    currentStatus: FeatureStatusWithPipeline
  ): Promise<PipelineStatusInfo> {
    const isPipeline = pipelineService.isPipelineStatus(currentStatus);
    if (!isPipeline)
      return {
        isPipeline: false,
        stepId: null,
        stepIndex: -1,
        totalSteps: 0,
        step: null,
        config: null,
      };

    const stepId = pipelineService.getStepIdFromStatus(currentStatus);
    if (!stepId) {
      logger.warn(`Feature ${featureId} has invalid pipeline status: ${currentStatus}`);
      return {
        isPipeline: true,
        stepId: null,
        stepIndex: -1,
        totalSteps: 0,
        step: null,
        config: null,
      };
    }

    const config = await pipelineService.getPipelineConfig(projectPath);
    if (!config || config.steps.length === 0) {
      logger.warn(`Feature ${featureId} has pipeline status but no config exists`);
      return { isPipeline: true, stepId, stepIndex: -1, totalSteps: 0, step: null, config: null };
    }

    const sortedSteps = [...config.steps].sort((a, b) => a.order - b.order);
    const stepIndex = sortedSteps.findIndex((s) => s.id === stepId);
    const step = stepIndex === -1 ? null : sortedSteps[stepIndex];

    if (!step) logger.warn(`Feature ${featureId} stuck in step ${stepId} which no longer exists`);
    else
      logger.info(
        `Detected pipeline status: step ${stepIndex + 1}/${sortedSteps.length} (${step.name})`
      );

    return { isPipeline: true, stepId, stepIndex, totalSteps: sortedSteps.length, step, config };
  }

  /** Resume pipeline execution from detected status */
  async resumePipeline(
    projectPath: string,
    feature: Feature,
    useWorktrees: boolean,
    pipelineInfo: PipelineStatusInfo
  ): Promise<void> {
    const featureId = feature.id;
    logger.info(`Resuming feature ${featureId} from pipeline step ${pipelineInfo.stepId}`);

    const featureDir = getFeatureDir(projectPath, featureId);
    const contextPath = path.join(featureDir, 'agent-output.md');
    let hasContext = false;
    try {
      await secureFs.access(contextPath);
      hasContext = true;
    } catch {
      /* No context */
    }

    if (!hasContext) {
      logger.warn(`No context for feature ${featureId}, restarting pipeline`);
      await this.updateFeatureStatusFn(projectPath, featureId, 'in_progress');
      return this.executeFeatureFn(projectPath, featureId, useWorktrees, false, undefined, {
        _calledInternally: true,
      });
    }

    if (pipelineInfo.stepIndex === -1) {
      logger.warn(`Step ${pipelineInfo.stepId} no longer exists, completing feature`);
      const finalStatus = feature.skipTests ? 'waiting_approval' : 'verified';
      await this.updateFeatureStatusFn(projectPath, featureId, finalStatus);
      this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        featureName: feature.title,
        branchName: feature.branchName ?? null,
        passes: true,
        message: 'Pipeline step no longer exists',
        projectPath,
      });
      return;
    }

    if (!pipelineInfo.config) throw new Error('Pipeline config is null but stepIndex is valid');
    return this.resumeFromStep(
      projectPath,
      feature,
      useWorktrees,
      pipelineInfo.stepIndex,
      pipelineInfo.config
    );
  }

  /** Resume from a specific step index */
  async resumeFromStep(
    projectPath: string,
    feature: Feature,
    useWorktrees: boolean,
    startFromStepIndex: number,
    pipelineConfig: PipelineConfig
  ): Promise<void> {
    const featureId = feature.id;
    const allSortedSteps = [...pipelineConfig.steps].sort((a, b) => a.order - b.order);
    if (startFromStepIndex < 0 || startFromStepIndex >= allSortedSteps.length)
      throw new Error(`Invalid step index: ${startFromStepIndex}`);

    const excludedStepIds = new Set(feature.excludedPipelineSteps || []);
    let currentStep = allSortedSteps[startFromStepIndex];

    if (excludedStepIds.has(currentStep.id)) {
      const nextStatus = pipelineService.getNextStatus(
        `pipeline_${currentStep.id}`,
        pipelineConfig,
        feature.skipTests ?? false,
        feature.excludedPipelineSteps
      );
      if (!pipelineService.isPipelineStatus(nextStatus)) {
        await this.updateFeatureStatusFn(projectPath, featureId, nextStatus);
        this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
          featureId,
          featureName: feature.title,
          branchName: feature.branchName ?? null,
          passes: true,
          message: 'Pipeline completed (remaining steps excluded)',
          projectPath,
        });
        return;
      }
      const nextStepId = pipelineService.getStepIdFromStatus(nextStatus);
      const nextStepIndex = allSortedSteps.findIndex((s) => s.id === nextStepId);
      if (nextStepIndex === -1) throw new Error(`Next step ${nextStepId} not found`);
      startFromStepIndex = nextStepIndex;
    }

    const stepsToExecute = allSortedSteps
      .slice(startFromStepIndex)
      .filter((step) => !excludedStepIds.has(step.id));
    if (stepsToExecute.length === 0) {
      const finalStatus = feature.skipTests ? 'waiting_approval' : 'verified';
      await this.updateFeatureStatusFn(projectPath, featureId, finalStatus);
      this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        featureName: feature.title,
        branchName: feature.branchName ?? null,
        passes: true,
        message: 'Pipeline completed (all steps excluded)',
        projectPath,
      });
      return;
    }

    const runningEntry = this.concurrencyManager.acquire({
      featureId,
      projectPath,
      isAutoMode: false,
      allowReuse: true,
    });
    const abortController = runningEntry.abortController;
    runningEntry.branchName = feature.branchName ?? null;

    try {
      validateWorkingDirectory(projectPath);
      let worktreePath: string | null = null;
      const branchName = feature.branchName;

      if (useWorktrees && branchName) {
        worktreePath = await this.worktreeResolver.findWorktreeForBranch(projectPath, branchName);
        if (worktreePath) logger.info(`Using worktree for branch "${branchName}": ${worktreePath}`);
      }

      const workDir = worktreePath ? path.resolve(worktreePath) : path.resolve(projectPath);
      validateWorkingDirectory(workDir);
      runningEntry.worktreePath = worktreePath;
      runningEntry.branchName = branchName ?? null;

      this.eventBus.emitAutoModeEvent('auto_mode_feature_start', {
        featureId,
        projectPath,
        branchName: branchName ?? null,
        feature: {
          id: featureId,
          title: feature.title || 'Resuming Pipeline',
          description: feature.description,
        },
      });

      const autoLoadClaudeMd = await getAutoLoadClaudeMdSetting(
        projectPath,
        this.settingsService,
        '[AutoMode]'
      );
      const context: PipelineContext = {
        projectPath,
        featureId,
        feature,
        steps: stepsToExecute,
        workDir,
        worktreePath,
        branchName: branchName ?? null,
        abortController,
        autoLoadClaudeMd,
        testAttempts: 0,
        maxTestAttempts: 5,
      };

      await this.executePipeline(context);

      const finalStatus = feature.skipTests ? 'waiting_approval' : 'verified';
      await this.updateFeatureStatusFn(projectPath, featureId, finalStatus);
      logger.info(`Pipeline resume completed for feature ${featureId}`);
      this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        featureName: feature.title,
        branchName: feature.branchName ?? null,
        passes: true,
        message: 'Pipeline resumed successfully',
        projectPath,
      });
    } catch (error) {
      const errorInfo = classifyError(error);
      if (errorInfo.isAbort) {
        this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
          featureId,
          featureName: feature.title,
          branchName: feature.branchName ?? null,
          passes: false,
          message: 'Pipeline stopped by user',
          projectPath,
        });
      } else {
        logger.error(`Pipeline resume failed for ${featureId}:`, error);
        await this.updateFeatureStatusFn(projectPath, featureId, 'backlog');
        this.eventBus.emitAutoModeEvent('auto_mode_error', {
          featureId,
          featureName: feature.title,
          branchName: feature.branchName ?? null,
          error: errorInfo.message,
          errorType: errorInfo.type,
          projectPath,
        });
      }
    } finally {
      this.concurrencyManager.release(featureId);
    }
  }

  /** Execute test step with agent fix loop (REQ-F07) */
  async executeTestStep(context: PipelineContext, testCommand: string): Promise<StepResult> {
    const { featureId, projectPath, workDir, abortController, maxTestAttempts } = context;

    for (let attempt = 1; attempt <= maxTestAttempts; attempt++) {
      if (abortController.signal.aborted)
        return { success: false, message: 'Test execution aborted' };
      logger.info(`Running tests for ${featureId} (attempt ${attempt}/${maxTestAttempts})`);

      const testResult = await this.testRunnerService.startTests(workDir, { command: testCommand });
      if (!testResult.success || !testResult.result?.sessionId)
        return {
          success: false,
          testsPassed: false,
          message: testResult.error || 'Failed to start tests',
        };

      const completionResult = await this.waitForTestCompletion(testResult.result.sessionId);
      if (completionResult.status === 'passed') return { success: true, testsPassed: true };

      const sessionOutput = this.testRunnerService.getSessionOutput(testResult.result.sessionId);
      const scrollback = sessionOutput.result?.output || '';
      this.eventBus.emitAutoModeEvent('pipeline_test_failed', {
        featureId,
        attempt,
        maxAttempts: maxTestAttempts,
        failedTests: this.extractFailedTestNames(scrollback),
        projectPath,
      });

      if (attempt < maxTestAttempts) {
        const fixPrompt = `## Test Failures - Please Fix\n\n${this.buildTestFailureSummary(scrollback)}\n\nFix the failing tests without modifying test code unless clearly wrong.`;
        await this.runAgentFn(
          workDir,
          featureId,
          fixPrompt,
          abortController,
          projectPath,
          undefined,
          undefined,
          { projectPath, planningMode: 'skip', requirePlanApproval: false }
        );
      }
    }
    return {
      success: false,
      testsPassed: false,
      message: `Tests failed after ${maxTestAttempts} attempts`,
    };
  }

  /** Wait for test completion */
  private async waitForTestCompletion(
    sessionId: string
  ): Promise<{ status: TestRunStatus; exitCode: number | null; duration: number }> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const session = this.testRunnerService.getSession(sessionId);
        if (session && session.status !== 'running' && session.status !== 'pending') {
          clearInterval(checkInterval);
          resolve({
            status: session.status,
            exitCode: session.exitCode,
            duration: session.finishedAt
              ? session.finishedAt.getTime() - session.startedAt.getTime()
              : 0,
          });
        }
      }, 1000);
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve({ status: 'failed', exitCode: null, duration: 600000 });
      }, 600000);
    });
  }

  /** Attempt to merge feature branch (REQ-F05) */
  async attemptMerge(context: PipelineContext): Promise<MergeResult> {
    const { projectPath, featureId, branchName, worktreePath, feature } = context;
    if (!branchName) return { success: false, error: 'No branch name for merge' };

    logger.info(`Attempting auto-merge for feature ${featureId} (branch: ${branchName})`);
    try {
      const response = await fetch(`http://localhost:${this.serverPort}/api/worktree/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          branchName,
          worktreePath,
          targetBranch: 'main',
          options: { deleteWorktreeAndBranch: false },
        }),
      });

      const data = (await response.json()) as {
        success: boolean;
        hasConflicts?: boolean;
        error?: string;
      };
      if (!response.ok) {
        if (data.hasConflicts) {
          await this.updateFeatureStatusFn(projectPath, featureId, 'merge_conflict');
          this.eventBus.emitAutoModeEvent('pipeline_merge_conflict', {
            featureId,
            branchName,
            projectPath,
          });
          return { success: false, hasConflicts: true, needsAgentResolution: true };
        }
        return { success: false, error: data.error };
      }

      logger.info(`Auto-merge successful for feature ${featureId}`);
      this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        featureName: feature.title,
        branchName,
        passes: true,
        message: 'Pipeline completed and merged',
        projectPath,
      });
      return { success: true };
    } catch (error) {
      logger.error(`Merge failed for ${featureId}:`, error);
      return { success: false, error: (error as Error).message };
    }
  }

  /** Build a concise test failure summary for the agent */
  buildTestFailureSummary(scrollback: string): string {
    const lines = scrollback.split('\n');
    const failedTests: string[] = [];
    let passCount = 0,
      failCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('FAIL') || trimmed.includes('FAILED')) {
        const match = trimmed.match(/(?:FAIL|FAILED)\s+(.+)/);
        if (match) failedTests.push(match[1].trim());
        failCount++;
      } else if (trimmed.includes('PASS') || trimmed.includes('PASSED')) passCount++;
      if (trimmed.match(/^>\s+.*\.(test|spec)\./)) failedTests.push(trimmed.replace(/^>\s+/, ''));
      if (
        trimmed.includes('AssertionError') ||
        trimmed.includes('toBe') ||
        trimmed.includes('toEqual')
      )
        failedTests.push(trimmed);
    }

    const unique = [...new Set(failedTests)].slice(0, 10);
    return `Test Results: ${passCount} passed, ${failCount} failed.\n\nFailed tests:\n${unique.map((t) => `- ${t}`).join('\n')}\n\nOutput (last 2000 chars):\n${scrollback.slice(-2000)}`;
  }

  /** Extract failed test names from scrollback */
  private extractFailedTestNames(scrollback: string): string[] {
    const failedTests: string[] = [];
    for (const line of scrollback.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.includes('FAIL') || trimmed.includes('FAILED')) {
        const match = trimmed.match(/(?:FAIL|FAILED)\s+(.+)/);
        if (match) failedTests.push(match[1].trim());
      }
    }
    return [...new Set(failedTests)].slice(0, 20);
  }
}
