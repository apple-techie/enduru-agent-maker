/**
 * AgentExecutor - Core agent execution engine with streaming support
 *
 * Encapsulates the full execution pipeline:
 * - Provider selection and SDK invocation
 * - Stream processing with real-time events
 * - Marker detection (task start, complete, phase complete)
 * - Debounced file output
 * - Abort signal handling
 *
 * This is the "engine" that runs AI agents. Orchestration (mock mode,
 * recovery paths, vision validation) remains in AutoModeService.
 */

import path from 'path';
import type {
  ExecuteOptions,
  PlanningMode,
  ThinkingLevel,
  ParsedTask,
  ClaudeCompatibleProvider,
  Credentials,
} from '@automaker/types';
import type { BaseProvider } from '../providers/base-provider.js';
import { buildPromptWithImages, createLogger } from '@automaker/utils';
import { getFeatureDir } from '@automaker/platform';
import * as secureFs from '../lib/secure-fs.js';
import { TypedEventBus } from './typed-event-bus.js';
import { FeatureStateManager } from './feature-state-manager.js';
import { PlanApprovalService } from './plan-approval-service.js';
import type { SettingsService } from './settings-service.js';
import {
  parseTasksFromSpec,
  detectTaskStartMarker,
  detectTaskCompleteMarker,
  detectPhaseCompleteMarker,
  detectSpecFallback,
  extractSummary,
} from './spec-parser.js';
import { getPromptCustomization } from '../lib/settings-helpers.js';

const logger = createLogger('AgentExecutor');

/**
 * Options for agent execution
 */
export interface AgentExecutionOptions {
  /** Working directory for agent execution (may be worktree path) */
  workDir: string;
  /** Feature being executed */
  featureId: string;
  /** Prompt to send to the agent */
  prompt: string;
  /** Project path (for output files, always main project path) */
  projectPath: string;
  /** Abort controller for cancellation */
  abortController: AbortController;
  /** Optional image paths to include in prompt */
  imagePaths?: string[];
  /** Model to use */
  model?: string;
  /** Planning mode (skip, lite, spec, full) */
  planningMode?: PlanningMode;
  /** Whether plan approval is required */
  requirePlanApproval?: boolean;
  /** Previous content for follow-up sessions */
  previousContent?: string;
  /** System prompt override */
  systemPrompt?: string;
  /** Whether to auto-load CLAUDE.md */
  autoLoadClaudeMd?: boolean;
  /** Thinking level for extended thinking */
  thinkingLevel?: ThinkingLevel;
  /** Branch name for event payloads */
  branchName?: string | null;
  /** Credentials for API calls */
  credentials?: Credentials;
  /** Claude-compatible provider for alternative endpoints */
  claudeCompatibleProvider?: ClaudeCompatibleProvider;
  /** MCP servers configuration */
  mcpServers?: Record<string, unknown>;
  /** SDK options from createAutoModeOptions */
  sdkOptions?: {
    maxTurns?: number;
    allowedTools?: string[];
    systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
    settingSources?: Array<'user' | 'project' | 'local'>;
  };
  /** Provider instance to use */
  provider: BaseProvider;
  /** Effective bare model (provider prefix stripped) */
  effectiveBareModel: string;
  /** Whether spec was already detected (recovery scenario) */
  specAlreadyDetected?: boolean;
  /** Existing approved plan content (recovery scenario) */
  existingApprovedPlanContent?: string;
  /** Persisted tasks from recovery */
  persistedTasks?: ParsedTask[];
}

/**
 * Result of agent execution
 */
export interface AgentExecutionResult {
  /** Full accumulated response text */
  responseText: string;
  /** Whether a spec was detected during execution */
  specDetected: boolean;
  /** Number of tasks completed */
  tasksCompleted: number;
  /** Whether execution was aborted */
  aborted: boolean;
}

/**
 * Callback for handling plan approval
 */
export type WaitForApprovalFn = (
  featureId: string,
  projectPath: string
) => Promise<{
  approved: boolean;
  feedback?: string;
  editedPlan?: string;
}>;

/**
 * Callback for saving feature summary (final output)
 */
export type SaveFeatureSummaryFn = (
  projectPath: string,
  featureId: string,
  summary: string
) => Promise<void>;

/**
 * Callback for updating feature summary during plan generation
 * (Only updates short/generic descriptions)
 */
export type UpdateFeatureSummaryFn = (
  projectPath: string,
  featureId: string,
  summary: string
) => Promise<void>;

/**
 * Callback for building task prompt
 */
export type BuildTaskPromptFn = (
  task: ParsedTask,
  allTasks: ParsedTask[],
  taskIndex: number,
  planContent: string,
  taskPromptTemplate: string,
  userFeedback?: string
) => string;

/**
 * AgentExecutor - Core execution engine for AI agents
 *
 * Responsibilities:
 * - Execute provider.executeQuery() and process the stream
 * - Detect markers ([TASK_START], [TASK_COMPLETE], [PHASE_COMPLETE], [SPEC_GENERATED])
 * - Emit events to TypedEventBus for real-time UI updates
 * - Update task status via FeatureStateManager
 * - Handle debounced file writes for agent output
 * - Propagate abort signals cleanly
 *
 * NOT responsible for:
 * - Mock mode (handled in AutoModeService)
 * - Vision validation (handled in AutoModeService)
 * - Recovery path selection (handled in AutoModeService)
 */
export class AgentExecutor {
  private eventBus: TypedEventBus;
  private featureStateManager: FeatureStateManager;
  private planApprovalService: PlanApprovalService;
  private settingsService: SettingsService | null;

  private static readonly WRITE_DEBOUNCE_MS = 500;
  private static readonly STREAM_HEARTBEAT_MS = 15_000;

  constructor(
    eventBus: TypedEventBus,
    featureStateManager: FeatureStateManager,
    planApprovalService: PlanApprovalService,
    settingsService?: SettingsService | null
  ) {
    this.eventBus = eventBus;
    this.featureStateManager = featureStateManager;
    this.planApprovalService = planApprovalService;
    this.settingsService = settingsService ?? null;
  }

  /**
   * Execute an agent with the given options
   *
   * This is the main entry point for agent execution. It handles:
   * - Setting up file output paths
   * - Processing the provider stream
   * - Detecting spec markers and handling plan approval
   * - Multi-agent task execution
   * - Cleanup
   */
  async execute(
    options: AgentExecutionOptions,
    callbacks: {
      waitForApproval: WaitForApprovalFn;
      saveFeatureSummary: SaveFeatureSummaryFn;
      updateFeatureSummary: UpdateFeatureSummaryFn;
      buildTaskPrompt: BuildTaskPromptFn;
    }
  ): Promise<AgentExecutionResult> {
    const {
      workDir,
      featureId,
      projectPath,
      abortController,
      branchName = null,
      provider,
      effectiveBareModel,
      previousContent,
      planningMode = 'skip',
      requirePlanApproval = false,
      specAlreadyDetected = false,
      existingApprovedPlanContent,
      persistedTasks,
      credentials,
      claudeCompatibleProvider,
      mcpServers,
      sdkOptions,
    } = options;

    // Build prompt content with images
    const { content: promptContent } = await buildPromptWithImages(
      options.prompt,
      options.imagePaths,
      workDir,
      false
    );

    // Build execute options for provider
    const executeOptions: ExecuteOptions = {
      prompt: promptContent,
      model: effectiveBareModel,
      maxTurns: sdkOptions?.maxTurns,
      cwd: workDir,
      allowedTools: sdkOptions?.allowedTools as string[] | undefined,
      abortController,
      systemPrompt: sdkOptions?.systemPrompt,
      settingSources: sdkOptions?.settingSources,
      mcpServers:
        mcpServers && Object.keys(mcpServers).length > 0
          ? (mcpServers as Record<string, { command: string }>)
          : undefined,
      thinkingLevel: options.thinkingLevel,
      credentials,
      claudeCompatibleProvider,
    };

    // Setup file output paths
    const featureDirForOutput = getFeatureDir(projectPath, featureId);
    const outputPath = path.join(featureDirForOutput, 'agent-output.md');
    const rawOutputPath = path.join(featureDirForOutput, 'raw-output.jsonl');

    // Raw output logging (configurable via env var)
    const enableRawOutput =
      process.env.AUTOMAKER_DEBUG_RAW_OUTPUT === 'true' ||
      process.env.AUTOMAKER_DEBUG_RAW_OUTPUT === '1';

    // Initialize response text
    let responseText = previousContent
      ? `${previousContent}\n\n---\n\n## Follow-up Session\n\n`
      : '';
    let specDetected = specAlreadyDetected;
    let tasksCompleted = 0;
    let aborted = false;

    // Debounced file write state
    let writeTimeout: ReturnType<typeof setTimeout> | null = null;
    let rawOutputLines: string[] = [];
    let rawWriteTimeout: ReturnType<typeof setTimeout> | null = null;

    // Helper to write response to file
    const writeToFile = async (): Promise<void> => {
      try {
        await secureFs.mkdir(path.dirname(outputPath), { recursive: true });
        await secureFs.writeFile(outputPath, responseText);
      } catch (error) {
        logger.error(`Failed to write agent output for ${featureId}:`, error);
      }
    };

    // Schedule debounced write
    const scheduleWrite = (): void => {
      if (writeTimeout) {
        clearTimeout(writeTimeout);
      }
      writeTimeout = setTimeout(() => {
        writeToFile();
      }, AgentExecutor.WRITE_DEBOUNCE_MS);
    };

    // Append raw event for debugging
    const appendRawEvent = (event: unknown): void => {
      if (!enableRawOutput) return;
      try {
        const timestamp = new Date().toISOString();
        const rawLine = JSON.stringify({ timestamp, event }, null, 4);
        rawOutputLines.push(rawLine);

        if (rawWriteTimeout) {
          clearTimeout(rawWriteTimeout);
        }
        rawWriteTimeout = setTimeout(async () => {
          try {
            await secureFs.mkdir(path.dirname(rawOutputPath), { recursive: true });
            await secureFs.appendFile(rawOutputPath, rawOutputLines.join('\n') + '\n');
            rawOutputLines = [];
          } catch (error) {
            logger.error(`Failed to write raw output for ${featureId}:`, error);
          }
        }, AgentExecutor.WRITE_DEBOUNCE_MS);
      } catch {
        // Ignore serialization errors
      }
    };

    // Heartbeat logging for silent model calls
    const streamStartTime = Date.now();
    let receivedAnyStreamMessage = false;
    const streamHeartbeat = setInterval(() => {
      if (receivedAnyStreamMessage) return;
      const elapsedSeconds = Math.round((Date.now() - streamStartTime) / 1000);
      logger.info(
        `Waiting for first model response for feature ${featureId} (${elapsedSeconds}s elapsed)...`
      );
    }, AgentExecutor.STREAM_HEARTBEAT_MS);

    // Determine if planning mode requires approval
    const planningModeRequiresApproval =
      planningMode === 'spec' ||
      planningMode === 'full' ||
      (planningMode === 'lite' && requirePlanApproval);
    const requiresApproval = planningModeRequiresApproval && requirePlanApproval;

    // RECOVERY PATH: If we have persisted tasks, execute them directly
    if (existingApprovedPlanContent && persistedTasks && persistedTasks.length > 0) {
      const result = await this.executePersistedTasks(
        options,
        persistedTasks,
        existingApprovedPlanContent,
        responseText,
        scheduleWrite,
        callbacks
      );

      // Cleanup
      clearInterval(streamHeartbeat);
      if (writeTimeout) clearTimeout(writeTimeout);
      if (rawWriteTimeout) clearTimeout(rawWriteTimeout);
      await writeToFile();

      return {
        responseText: result.responseText,
        specDetected: true,
        tasksCompleted: result.tasksCompleted,
        aborted: result.aborted,
      };
    }

    // Start stream processing
    logger.info(`Starting stream for feature ${featureId}...`);
    const stream = provider.executeQuery(executeOptions);
    logger.info(`Stream created, starting to iterate...`);

    try {
      streamLoop: for await (const msg of stream) {
        receivedAnyStreamMessage = true;
        appendRawEvent(msg);

        // Check for abort
        if (abortController.signal.aborted) {
          aborted = true;
          throw new Error('Feature execution aborted');
        }

        logger.info(`Stream message received:`, msg.type, msg.subtype || '');

        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              const newText = block.text || '';
              if (!newText) continue;

              // Add paragraph breaks at natural boundaries
              if (responseText.length > 0 && newText.length > 0) {
                const endsWithSentence = /[.!?:]\s*$/.test(responseText);
                const endsWithNewline = /\n\s*$/.test(responseText);
                const startsNewParagraph = /^[\n#\-*>]/.test(newText);
                const lastChar = responseText.slice(-1);

                if (
                  !endsWithNewline &&
                  (endsWithSentence || startsNewParagraph) &&
                  !/[a-zA-Z0-9]/.test(lastChar)
                ) {
                  responseText += '\n\n';
                }
              }
              responseText += newText;

              // Check for authentication errors
              if (
                block.text &&
                (block.text.includes('Invalid API key') ||
                  block.text.includes('authentication_failed') ||
                  block.text.includes('Fix external API key'))
              ) {
                throw new Error(
                  'Authentication failed: Invalid or expired API key. ' +
                    "Please check your ANTHROPIC_API_KEY, or run 'claude login' to re-authenticate."
                );
              }

              scheduleWrite();

              // Check for spec marker
              const hasExplicitMarker = responseText.includes('[SPEC_GENERATED]');
              const hasFallbackSpec = !hasExplicitMarker && detectSpecFallback(responseText);

              if (
                planningModeRequiresApproval &&
                !specDetected &&
                (hasExplicitMarker || hasFallbackSpec)
              ) {
                specDetected = true;

                // Extract plan content
                let planContent: string;
                if (hasExplicitMarker) {
                  const markerIndex = responseText.indexOf('[SPEC_GENERATED]');
                  planContent = responseText.substring(0, markerIndex).trim();
                } else {
                  planContent = responseText.trim();
                  logger.info(`Using fallback spec detection for feature ${featureId}`);
                }

                // Parse tasks and handle approval
                const result = await this.handleSpecGenerated(
                  options,
                  planContent,
                  responseText,
                  requiresApproval,
                  scheduleWrite,
                  callbacks
                );

                responseText = result.responseText;
                tasksCompleted = result.tasksCompleted;

                // Exit stream loop after spec handling
                break streamLoop;
              }

              // Emit progress for non-spec content
              if (!specDetected) {
                logger.info(
                  `Emitting progress event for ${featureId}, content length: ${block.text?.length || 0}`
                );
                this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                  featureId,
                  branchName,
                  content: block.text,
                });
              }
            } else if (block.type === 'tool_use') {
              this.eventBus.emitAutoModeEvent('auto_mode_tool', {
                featureId,
                branchName,
                tool: block.name,
                input: block.input,
              });

              // Add tool info to response
              if (responseText.length > 0 && !responseText.endsWith('\n')) {
                responseText += '\n';
              }
              responseText += `\n🔧 Tool: ${block.name}\n`;
              if (block.input) {
                responseText += `Input: ${JSON.stringify(block.input, null, 2)}\n`;
              }
              scheduleWrite();
            }
          }
        } else if (msg.type === 'error') {
          throw new Error(msg.error || 'Unknown error');
        } else if (msg.type === 'result' && msg.subtype === 'success') {
          scheduleWrite();
        }
      }

      // Final write on success
      await writeToFile();

      // Flush raw output
      if (enableRawOutput && rawOutputLines.length > 0) {
        try {
          await secureFs.mkdir(path.dirname(rawOutputPath), { recursive: true });
          await secureFs.appendFile(rawOutputPath, rawOutputLines.join('\n') + '\n');
        } catch (error) {
          logger.error(`Failed to write final raw output for ${featureId}:`, error);
        }
      }
    } finally {
      clearInterval(streamHeartbeat);
      if (writeTimeout) {
        clearTimeout(writeTimeout);
        writeTimeout = null;
      }
      if (rawWriteTimeout) {
        clearTimeout(rawWriteTimeout);
        rawWriteTimeout = null;
      }
    }

    return {
      responseText,
      specDetected,
      tasksCompleted,
      aborted,
    };
  }

  /**
   * Execute persisted tasks from recovery scenario
   */
  private async executePersistedTasks(
    options: AgentExecutionOptions,
    tasks: ParsedTask[],
    planContent: string,
    initialResponseText: string,
    scheduleWrite: () => void,
    callbacks: {
      waitForApproval: WaitForApprovalFn;
      saveFeatureSummary: SaveFeatureSummaryFn;
      updateFeatureSummary: UpdateFeatureSummaryFn;
      buildTaskPrompt: BuildTaskPromptFn;
    }
  ): Promise<{ responseText: string; tasksCompleted: number; aborted: boolean }> {
    const {
      workDir,
      featureId,
      projectPath,
      abortController,
      branchName = null,
      provider,
      effectiveBareModel,
      credentials,
      claudeCompatibleProvider,
      mcpServers,
      sdkOptions,
    } = options;

    logger.info(
      `Recovery: Resuming task execution for feature ${featureId} with ${tasks.length} tasks`
    );

    const taskPrompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
    let responseText = initialResponseText;
    let tasksCompleted = 0;

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex];

      // Skip completed tasks
      if (task.status === 'completed') {
        logger.info(`Skipping already completed task ${task.id}`);
        tasksCompleted++;
        continue;
      }

      // Check for abort
      if (abortController.signal.aborted) {
        return { responseText, tasksCompleted, aborted: true };
      }

      // Mark task as in_progress
      await this.featureStateManager.updateTaskStatus(
        projectPath,
        featureId,
        task.id,
        'in_progress'
      );

      // Emit task started
      logger.info(`Starting task ${task.id}: ${task.description}`);
      this.eventBus.emitAutoModeEvent('auto_mode_task_started', {
        featureId,
        projectPath,
        branchName,
        taskId: task.id,
        taskDescription: task.description,
        taskIndex,
        tasksTotal: tasks.length,
      });

      // Update planSpec
      await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
        currentTaskId: task.id,
      });

      // Build task prompt
      const taskPrompt = callbacks.buildTaskPrompt(
        task,
        tasks,
        taskIndex,
        planContent,
        taskPrompts.taskExecution.taskPromptTemplate,
        undefined
      );

      // Execute task
      const taskStream = provider.executeQuery({
        prompt: taskPrompt,
        model: effectiveBareModel,
        maxTurns: Math.min(sdkOptions?.maxTurns || 100, 50),
        cwd: workDir,
        allowedTools: sdkOptions?.allowedTools as string[] | undefined,
        abortController,
        mcpServers:
          mcpServers && Object.keys(mcpServers).length > 0
            ? (mcpServers as Record<string, { command: string }>)
            : undefined,
        credentials,
        claudeCompatibleProvider,
      });

      let taskOutput = '';
      let taskCompleteDetected = false;

      for await (const msg of taskStream) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              const text = block.text || '';
              taskOutput += text;
              responseText += text;
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: text,
              });
              scheduleWrite();

              // Detect task complete marker
              if (!taskCompleteDetected) {
                const completeTaskId = detectTaskCompleteMarker(taskOutput);
                if (completeTaskId) {
                  taskCompleteDetected = true;
                  logger.info(`[TASK_COMPLETE] detected for ${completeTaskId}`);
                  await this.featureStateManager.updateTaskStatus(
                    projectPath,
                    featureId,
                    completeTaskId,
                    'completed'
                  );
                }
              }
            } else if (block.type === 'tool_use') {
              this.eventBus.emitAutoModeEvent('auto_mode_tool', {
                featureId,
                branchName,
                tool: block.name,
                input: block.input,
              });
            }
          }
        } else if (msg.type === 'error') {
          throw new Error(msg.error || `Error during task ${task.id}`);
        } else if (msg.type === 'result' && msg.subtype === 'success') {
          taskOutput += msg.result || '';
          responseText += msg.result || '';
        }
      }

      // Mark completed if no marker detected
      if (!taskCompleteDetected) {
        await this.featureStateManager.updateTaskStatus(
          projectPath,
          featureId,
          task.id,
          'completed'
        );
      }

      // Emit task complete
      tasksCompleted = taskIndex + 1;
      logger.info(`Task ${task.id} completed for feature ${featureId}`);
      this.eventBus.emitAutoModeEvent('auto_mode_task_complete', {
        featureId,
        projectPath,
        branchName,
        taskId: task.id,
        tasksCompleted,
        tasksTotal: tasks.length,
      });

      // Update planSpec
      await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
        tasksCompleted,
      });
    }

    logger.info(`Recovery: All tasks completed for feature ${featureId}`);

    // Extract and save summary
    const summary = extractSummary(responseText);
    if (summary) {
      await callbacks.saveFeatureSummary(projectPath, featureId, summary);
    }

    return { responseText, tasksCompleted, aborted: false };
  }

  /**
   * Handle spec generation and approval workflow
   */
  private async handleSpecGenerated(
    options: AgentExecutionOptions,
    planContent: string,
    initialResponseText: string,
    requiresApproval: boolean,
    scheduleWrite: () => void,
    callbacks: {
      waitForApproval: WaitForApprovalFn;
      saveFeatureSummary: SaveFeatureSummaryFn;
      updateFeatureSummary: UpdateFeatureSummaryFn;
      buildTaskPrompt: BuildTaskPromptFn;
    }
  ): Promise<{ responseText: string; tasksCompleted: number }> {
    const {
      workDir,
      featureId,
      projectPath,
      abortController,
      branchName = null,
      planningMode = 'skip',
      provider,
      effectiveBareModel,
      credentials,
      claudeCompatibleProvider,
      mcpServers,
      sdkOptions,
    } = options;

    let responseText = initialResponseText;
    let parsedTasks = parseTasksFromSpec(planContent);
    const tasksTotal = parsedTasks.length;

    logger.info(`Parsed ${tasksTotal} tasks from spec for feature ${featureId}`);
    if (parsedTasks.length > 0) {
      logger.info(`Tasks: ${parsedTasks.map((t) => t.id).join(', ')}`);
    }

    // Update planSpec
    await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
      status: 'generated',
      content: planContent,
      version: 1,
      generatedAt: new Date().toISOString(),
      reviewedByUser: false,
      tasks: parsedTasks,
      tasksTotal,
      tasksCompleted: 0,
    });

    // Extract and save summary
    const planSummary = extractSummary(planContent);
    if (planSummary) {
      logger.info(`Extracted summary from plan: ${planSummary.substring(0, 100)}...`);
      await callbacks.updateFeatureSummary(projectPath, featureId, planSummary);
    }

    let approvedPlanContent = planContent;
    let userFeedback: string | undefined;
    let currentPlanContent = planContent;
    let planVersion = 1;

    if (requiresApproval) {
      // Plan revision loop
      let planApproved = false;

      while (!planApproved) {
        logger.info(
          `Spec v${planVersion} generated for feature ${featureId}, waiting for approval`
        );

        // Emit approval required event
        this.eventBus.emitAutoModeEvent('plan_approval_required', {
          featureId,
          projectPath,
          branchName,
          planContent: currentPlanContent,
          planningMode,
          planVersion,
        });

        // Wait for approval
        const approvalResult = await callbacks.waitForApproval(featureId, projectPath);

        if (approvalResult.approved) {
          logger.info(`Plan v${planVersion} approved for feature ${featureId}`);
          planApproved = true;

          if (approvalResult.editedPlan) {
            approvedPlanContent = approvalResult.editedPlan;
            await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
              content: approvalResult.editedPlan,
            });
          } else {
            approvedPlanContent = currentPlanContent;
          }

          userFeedback = approvalResult.feedback;

          this.eventBus.emitAutoModeEvent('plan_approved', {
            featureId,
            projectPath,
            branchName,
            hasEdits: !!approvalResult.editedPlan,
            planVersion,
          });
        } else {
          // Handle rejection
          const hasFeedback = approvalResult.feedback && approvalResult.feedback.trim().length > 0;
          const hasEdits = approvalResult.editedPlan && approvalResult.editedPlan.trim().length > 0;

          if (!hasFeedback && !hasEdits) {
            logger.info(`Plan rejected without feedback for feature ${featureId}, cancelling`);
            throw new Error('Plan cancelled by user');
          }

          // Regenerate plan
          logger.info(`Plan v${planVersion} rejected with feedback, regenerating...`);
          planVersion++;

          this.eventBus.emitAutoModeEvent('plan_revision_requested', {
            featureId,
            projectPath,
            branchName,
            feedback: approvalResult.feedback,
            hasEdits: !!hasEdits,
            planVersion,
          });

          // Build revision prompt
          const revisionPrompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
          const taskFormatExample =
            planningMode === 'full'
              ? '```tasks\n## Phase 1: Foundation\n- [ ] T001: [Description] | File: [path/to/file]\n```'
              : '```tasks\n- [ ] T001: [Description] | File: [path/to/file]\n```';

          let revisionPrompt = revisionPrompts.taskExecution.planRevisionTemplate;
          revisionPrompt = revisionPrompt.replace(/\{\{planVersion\}\}/g, String(planVersion - 1));
          revisionPrompt = revisionPrompt.replace(
            /\{\{previousPlan\}\}/g,
            hasEdits ? approvalResult.editedPlan || currentPlanContent : currentPlanContent
          );
          revisionPrompt = revisionPrompt.replace(
            /\{\{userFeedback\}\}/g,
            approvalResult.feedback || 'Please revise the plan based on the edits above.'
          );
          revisionPrompt = revisionPrompt.replace(/\{\{planningMode\}\}/g, planningMode);
          revisionPrompt = revisionPrompt.replace(/\{\{taskFormatExample\}\}/g, taskFormatExample);

          // Update status
          await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
            status: 'generating',
            version: planVersion,
          });

          // Make revision call
          const revisionStream = provider.executeQuery({
            prompt: revisionPrompt,
            model: effectiveBareModel,
            maxTurns: sdkOptions?.maxTurns || 100,
            cwd: workDir,
            allowedTools: sdkOptions?.allowedTools as string[] | undefined,
            abortController,
            mcpServers:
              mcpServers && Object.keys(mcpServers).length > 0
                ? (mcpServers as Record<string, { command: string }>)
                : undefined,
            credentials,
            claudeCompatibleProvider,
          });

          let revisionText = '';
          for await (const msg of revisionStream) {
            if (msg.type === 'assistant' && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'text') {
                  revisionText += block.text || '';
                  this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                    featureId,
                    content: block.text,
                  });
                }
              }
            } else if (msg.type === 'error') {
              throw new Error(msg.error || 'Error during plan revision');
            } else if (msg.type === 'result' && msg.subtype === 'success') {
              revisionText += msg.result || '';
            }
          }

          // Extract new plan
          const markerIndex = revisionText.indexOf('[SPEC_GENERATED]');
          if (markerIndex > 0) {
            currentPlanContent = revisionText.substring(0, markerIndex).trim();
          } else {
            currentPlanContent = revisionText.trim();
          }

          // Re-parse tasks
          const revisedTasks = parseTasksFromSpec(currentPlanContent);
          logger.info(`Revised plan has ${revisedTasks.length} tasks`);

          if (revisedTasks.length === 0 && (planningMode === 'spec' || planningMode === 'full')) {
            logger.warn(`WARNING: Revised plan has no tasks!`);
            this.eventBus.emitAutoModeEvent('plan_revision_warning', {
              featureId,
              projectPath,
              branchName,
              planningMode,
              warning: 'Revised plan missing tasks block - will use single-agent execution',
            });
          }

          // Update planSpec
          await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
            status: 'generated',
            content: currentPlanContent,
            version: planVersion,
            tasks: revisedTasks,
            tasksTotal: revisedTasks.length,
            tasksCompleted: 0,
          });

          parsedTasks = revisedTasks;
          responseText += revisionText;
        }
      }
    } else {
      // Auto-approve
      logger.info(`Spec generated for feature ${featureId}, auto-approving`);
      this.eventBus.emitAutoModeEvent('plan_auto_approved', {
        featureId,
        projectPath,
        branchName,
        planContent,
        planningMode,
      });
      approvedPlanContent = planContent;
    }

    // Update to approved status
    await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
      status: 'approved',
      approvedAt: new Date().toISOString(),
      reviewedByUser: requiresApproval,
    });

    // Execute tasks
    let tasksCompleted = 0;
    if (parsedTasks.length > 0) {
      const result = await this.executeMultiAgentTasks(
        options,
        parsedTasks,
        approvedPlanContent,
        userFeedback,
        responseText,
        scheduleWrite,
        callbacks
      );
      responseText = result.responseText;
      tasksCompleted = result.tasksCompleted;
    } else {
      // Single-agent fallback
      const result = await this.executeSingleAgentContinuation(
        options,
        approvedPlanContent,
        userFeedback,
        responseText
      );
      responseText = result.responseText;
    }

    // Extract and save final summary
    const summary = extractSummary(responseText);
    if (summary) {
      await callbacks.saveFeatureSummary(projectPath, featureId, summary);
    }

    logger.info(`Implementation completed for feature ${featureId}`);
    return { responseText, tasksCompleted };
  }

  /**
   * Execute multi-agent task flow
   */
  private async executeMultiAgentTasks(
    options: AgentExecutionOptions,
    tasks: ParsedTask[],
    planContent: string,
    userFeedback: string | undefined,
    initialResponseText: string,
    scheduleWrite: () => void,
    callbacks: {
      waitForApproval: WaitForApprovalFn;
      saveFeatureSummary: SaveFeatureSummaryFn;
      updateFeatureSummary: UpdateFeatureSummaryFn;
      buildTaskPrompt: BuildTaskPromptFn;
    }
  ): Promise<{ responseText: string; tasksCompleted: number }> {
    const {
      workDir,
      featureId,
      projectPath,
      abortController,
      branchName = null,
      provider,
      effectiveBareModel,
      credentials,
      claudeCompatibleProvider,
      mcpServers,
      sdkOptions,
    } = options;

    logger.info(`Starting multi-agent execution: ${tasks.length} tasks for feature ${featureId}`);

    const taskPrompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
    let responseText = initialResponseText;
    let tasksCompleted = 0;

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex];

      // Skip completed tasks
      if (task.status === 'completed') {
        logger.info(`Skipping already completed task ${task.id}`);
        continue;
      }

      // Check for abort
      if (abortController.signal.aborted) {
        throw new Error('Feature execution aborted');
      }

      // Mark as in_progress
      await this.featureStateManager.updateTaskStatus(
        projectPath,
        featureId,
        task.id,
        'in_progress'
      );

      // Emit task started
      logger.info(`Starting task ${task.id}: ${task.description}`);
      this.eventBus.emitAutoModeEvent('auto_mode_task_started', {
        featureId,
        projectPath,
        branchName,
        taskId: task.id,
        taskDescription: task.description,
        taskIndex,
        tasksTotal: tasks.length,
      });

      // Update planSpec
      await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
        currentTaskId: task.id,
      });

      // Build task prompt
      const taskPrompt = callbacks.buildTaskPrompt(
        task,
        tasks,
        taskIndex,
        planContent,
        taskPrompts.taskExecution.taskPromptTemplate,
        userFeedback
      );

      // Execute task
      const taskStream = provider.executeQuery({
        prompt: taskPrompt,
        model: effectiveBareModel,
        maxTurns: Math.min(sdkOptions?.maxTurns || 100, 50),
        cwd: workDir,
        allowedTools: sdkOptions?.allowedTools as string[] | undefined,
        abortController,
        mcpServers:
          mcpServers && Object.keys(mcpServers).length > 0
            ? (mcpServers as Record<string, { command: string }>)
            : undefined,
        credentials,
        claudeCompatibleProvider,
      });

      let taskOutput = '';
      let taskStartDetected = false;
      let taskCompleteDetected = false;

      for await (const msg of taskStream) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              const text = block.text || '';
              taskOutput += text;
              responseText += text;
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: text,
              });

              // Detect markers
              if (!taskStartDetected) {
                const startTaskId = detectTaskStartMarker(taskOutput);
                if (startTaskId) {
                  taskStartDetected = true;
                  logger.info(`[TASK_START] detected for ${startTaskId}`);
                  await this.featureStateManager.updateTaskStatus(
                    projectPath,
                    featureId,
                    startTaskId,
                    'in_progress'
                  );
                  this.eventBus.emitAutoModeEvent('auto_mode_task_started', {
                    featureId,
                    projectPath,
                    branchName,
                    taskId: startTaskId,
                    taskDescription: task.description,
                    taskIndex,
                    tasksTotal: tasks.length,
                  });
                }
              }

              if (!taskCompleteDetected) {
                const completeTaskId = detectTaskCompleteMarker(taskOutput);
                if (completeTaskId) {
                  taskCompleteDetected = true;
                  logger.info(`[TASK_COMPLETE] detected for ${completeTaskId}`);
                  await this.featureStateManager.updateTaskStatus(
                    projectPath,
                    featureId,
                    completeTaskId,
                    'completed'
                  );
                }
              }

              // Detect phase complete
              const phaseNumber = detectPhaseCompleteMarker(text);
              if (phaseNumber !== null) {
                logger.info(`[PHASE_COMPLETE] detected for Phase ${phaseNumber}`);
                this.eventBus.emitAutoModeEvent('auto_mode_phase_complete', {
                  featureId,
                  projectPath,
                  branchName,
                  phaseNumber,
                });
              }
            } else if (block.type === 'tool_use') {
              this.eventBus.emitAutoModeEvent('auto_mode_tool', {
                featureId,
                branchName,
                tool: block.name,
                input: block.input,
              });
            }
          }
        } else if (msg.type === 'error') {
          throw new Error(msg.error || `Error during task ${task.id}`);
        } else if (msg.type === 'result' && msg.subtype === 'success') {
          taskOutput += msg.result || '';
          responseText += msg.result || '';
        }
      }

      // Mark completed if no marker
      if (!taskCompleteDetected) {
        await this.featureStateManager.updateTaskStatus(
          projectPath,
          featureId,
          task.id,
          'completed'
        );
      }

      // Emit task complete
      tasksCompleted = taskIndex + 1;
      logger.info(`Task ${task.id} completed for feature ${featureId}`);
      this.eventBus.emitAutoModeEvent('auto_mode_task_complete', {
        featureId,
        projectPath,
        branchName,
        taskId: task.id,
        tasksCompleted,
        tasksTotal: tasks.length,
      });

      // Update planSpec
      await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
        tasksCompleted,
      });

      // Check for phase completion
      if (task.phase) {
        const nextTask = tasks[taskIndex + 1];
        if (!nextTask || nextTask.phase !== task.phase) {
          const phaseMatch = task.phase.match(/Phase\s*(\d+)/i);
          if (phaseMatch) {
            this.eventBus.emitAutoModeEvent('auto_mode_phase_complete', {
              featureId,
              projectPath,
              branchName,
              phaseNumber: parseInt(phaseMatch[1], 10),
            });
          }
        }
      }
    }

    logger.info(`All ${tasks.length} tasks completed for feature ${featureId}`);
    return { responseText, tasksCompleted };
  }

  /**
   * Execute single-agent continuation (fallback when no tasks parsed)
   */
  private async executeSingleAgentContinuation(
    options: AgentExecutionOptions,
    planContent: string,
    userFeedback: string | undefined,
    initialResponseText: string
  ): Promise<{ responseText: string }> {
    const {
      workDir,
      featureId,
      abortController,
      branchName = null,
      provider,
      effectiveBareModel,
      credentials,
      claudeCompatibleProvider,
      mcpServers,
      sdkOptions,
    } = options;

    logger.info(`No parsed tasks, using single-agent execution for feature ${featureId}`);

    const taskPrompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
    let continuationPrompt = taskPrompts.taskExecution.continuationAfterApprovalTemplate;
    continuationPrompt = continuationPrompt.replace(/\{\{userFeedback\}\}/g, userFeedback || '');
    continuationPrompt = continuationPrompt.replace(/\{\{approvedPlan\}\}/g, planContent);

    const continuationStream = provider.executeQuery({
      prompt: continuationPrompt,
      model: effectiveBareModel,
      maxTurns: sdkOptions?.maxTurns,
      cwd: workDir,
      allowedTools: sdkOptions?.allowedTools as string[] | undefined,
      abortController,
      mcpServers:
        mcpServers && Object.keys(mcpServers).length > 0
          ? (mcpServers as Record<string, { command: string }>)
          : undefined,
      credentials,
      claudeCompatibleProvider,
    });

    let responseText = initialResponseText;

    for await (const msg of continuationStream) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            responseText += block.text || '';
            this.eventBus.emitAutoModeEvent('auto_mode_progress', {
              featureId,
              branchName,
              content: block.text,
            });
          } else if (block.type === 'tool_use') {
            this.eventBus.emitAutoModeEvent('auto_mode_tool', {
              featureId,
              branchName,
              tool: block.name,
              input: block.input,
            });
          }
        }
      } else if (msg.type === 'error') {
        throw new Error(msg.error || 'Unknown error during implementation');
      } else if (msg.type === 'result' && msg.subtype === 'success') {
        responseText += msg.result || '';
      }
    }

    return { responseText };
  }
}
