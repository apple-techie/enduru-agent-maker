/**
 * PlanApprovalService - Manages plan approval workflow with timeout and recovery
 *
 * Key behaviors:
 * - Timeout stored in closure, wrapped resolve/reject ensures cleanup
 * - Recovery returns needsRecovery flag (caller handles execution)
 * - Auto-reject on timeout (safety feature, not auto-approve)
 */

import { createLogger } from '@automaker/utils';
import type { TypedEventBus } from './typed-event-bus.js';
import type { FeatureStateManager } from './feature-state-manager.js';
import type { SettingsService } from './settings-service.js';

const logger = createLogger('PlanApprovalService');

/** Result returned when approval is resolved */
export interface PlanApprovalResult {
  approved: boolean;
  editedPlan?: string;
  feedback?: string;
}

/** Result returned from resolveApproval method */
export interface ResolveApprovalResult {
  success: boolean;
  error?: string;
  needsRecovery?: boolean;
}

/** Represents an orphaned approval that needs recovery after server restart */
export interface OrphanedApproval {
  featureId: string;
  projectPath: string;
  generatedAt?: string;
  planContent?: string;
}

/** Internal: timeoutId stored in closure, NOT in this object */
interface PendingApproval {
  resolve: (result: PlanApprovalResult) => void;
  reject: (error: Error) => void;
  featureId: string;
  projectPath: string;
}

/** Default timeout: 30 minutes */
const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * PlanApprovalService handles the plan approval workflow with lifecycle management.
 */
export class PlanApprovalService {
  private pendingApprovals = new Map<string, PendingApproval>();
  private eventBus: TypedEventBus;
  private featureStateManager: FeatureStateManager;
  private settingsService: SettingsService | null;

  constructor(
    eventBus: TypedEventBus,
    featureStateManager: FeatureStateManager,
    settingsService: SettingsService | null
  ) {
    this.eventBus = eventBus;
    this.featureStateManager = featureStateManager;
    this.settingsService = settingsService;
  }

  /** Wait for plan approval with timeout (default 30 min). Rejects on timeout/cancellation. */
  async waitForApproval(featureId: string, projectPath: string): Promise<PlanApprovalResult> {
    const timeoutMs = await this.getTimeoutMs(projectPath);
    const timeoutMinutes = Math.round(timeoutMs / 60000);

    logger.info(`Registering pending approval for feature ${featureId}`);
    logger.info(
      `Current pending approvals: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`
    );

    return new Promise((resolve, reject) => {
      // Set up timeout to prevent indefinite waiting and memory leaks
      // timeoutId stored in closure, NOT in PendingApproval object
      const timeoutId = setTimeout(() => {
        const pending = this.pendingApprovals.get(featureId);
        if (pending) {
          logger.warn(
            `Plan approval for feature ${featureId} timed out after ${timeoutMinutes} minutes`
          );
          this.pendingApprovals.delete(featureId);
          reject(
            new Error(
              `Plan approval timed out after ${timeoutMinutes} minutes - feature execution cancelled`
            )
          );
        }
      }, timeoutMs);

      // Wrap resolve/reject to clear timeout when approval is resolved
      // This ensures timeout is ALWAYS cleared on any resolution path
      const wrappedResolve = (result: PlanApprovalResult) => {
        clearTimeout(timeoutId);
        resolve(result);
      };

      const wrappedReject = (error: Error) => {
        clearTimeout(timeoutId);
        reject(error);
      };

      this.pendingApprovals.set(featureId, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        featureId,
        projectPath,
      });

      logger.info(
        `Pending approval registered for feature ${featureId} (timeout: ${timeoutMinutes} minutes)`
      );
    });
  }

  /** Resolve approval. Recovery path: returns needsRecovery=true if planSpec.status='generated'. */
  async resolveApproval(
    featureId: string,
    approved: boolean,
    options?: { editedPlan?: string; feedback?: string; projectPath?: string }
  ): Promise<ResolveApprovalResult> {
    const { editedPlan, feedback, projectPath: projectPathFromClient } = options ?? {};

    logger.info(`resolveApproval called for feature ${featureId}, approved=${approved}`);
    logger.info(
      `Current pending approvals: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`
    );

    const pending = this.pendingApprovals.get(featureId);

    if (!pending) {
      logger.info(`No pending approval in Map for feature ${featureId}`);

      // RECOVERY: If no pending approval but we have projectPath from client,
      // check if feature's planSpec.status is 'generated' and handle recovery
      if (projectPathFromClient) {
        logger.info(`Attempting recovery with projectPath: ${projectPathFromClient}`);
        const feature = await this.featureStateManager.loadFeature(
          projectPathFromClient,
          featureId
        );

        if (feature?.planSpec?.status === 'generated') {
          logger.info(`Feature ${featureId} has planSpec.status='generated', performing recovery`);

          if (approved) {
            // Update planSpec to approved
            await this.featureStateManager.updateFeaturePlanSpec(projectPathFromClient, featureId, {
              status: 'approved',
              approvedAt: new Date().toISOString(),
              reviewedByUser: true,
              content: editedPlan || feature.planSpec.content,
            });

            logger.info(`Recovery approval complete for feature ${featureId}`);

            // Return needsRecovery flag - caller (AutoModeService) handles execution
            return { success: true, needsRecovery: true };
          } else {
            // Rejection recovery
            await this.featureStateManager.updateFeaturePlanSpec(projectPathFromClient, featureId, {
              status: 'rejected',
              reviewedByUser: true,
            });

            await this.featureStateManager.updateFeatureStatus(
              projectPathFromClient,
              featureId,
              'backlog'
            );

            this.eventBus.emitAutoModeEvent('plan_rejected', {
              featureId,
              projectPath: projectPathFromClient,
              feedback,
            });

            return { success: true };
          }
        }
      }

      logger.info(
        `ERROR: No pending approval found for feature ${featureId} and recovery not possible`
      );
      return {
        success: false,
        error: `No pending approval for feature ${featureId}`,
      };
    }

    logger.info(`Found pending approval for feature ${featureId}, proceeding...`);

    const { projectPath } = pending;

    // Update feature's planSpec status
    await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
      status: approved ? 'approved' : 'rejected',
      approvedAt: approved ? new Date().toISOString() : undefined,
      reviewedByUser: true,
      content: editedPlan, // Update content if user provided an edited version
    });

    // If rejected with feedback, emit event so client knows the rejection reason
    if (!approved && feedback) {
      this.eventBus.emitAutoModeEvent('plan_rejected', {
        featureId,
        projectPath,
        feedback,
      });
    }

    // Resolve the promise with all data including feedback
    // This triggers the wrapped resolve which clears the timeout
    pending.resolve({ approved, editedPlan, feedback });
    this.pendingApprovals.delete(featureId);

    return { success: true };
  }

  /** Cancel approval (e.g., when feature stopped). Timeout cleared via wrapped reject. */
  cancelApproval(featureId: string): void {
    logger.info(`cancelApproval called for feature ${featureId}`);
    logger.info(
      `Current pending approvals: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`
    );

    const pending = this.pendingApprovals.get(featureId);
    if (pending) {
      logger.info(`Found and cancelling pending approval for feature ${featureId}`);
      // Wrapped reject clears timeout automatically
      pending.reject(new Error('Plan approval cancelled - feature was stopped'));
      this.pendingApprovals.delete(featureId);
    } else {
      logger.info(`No pending approval to cancel for feature ${featureId}`);
    }
  }

  /** Check if a feature has a pending plan approval. */
  hasPendingApproval(featureId: string): boolean {
    return this.pendingApprovals.has(featureId);
  }

  /** Get timeout from project settings or default (30 min). */
  private async getTimeoutMs(projectPath: string): Promise<number> {
    if (!this.settingsService) {
      return DEFAULT_APPROVAL_TIMEOUT_MS;
    }

    try {
      const projectSettings = await this.settingsService.getProjectSettings(projectPath);
      // Check for planApprovalTimeoutMs in project settings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timeoutMs = (projectSettings as any).planApprovalTimeoutMs;
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        return timeoutMs;
      }
    } catch (error) {
      logger.warn(
        `Failed to get project settings for ${projectPath}, using default timeout`,
        error
      );
    }

    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
}
