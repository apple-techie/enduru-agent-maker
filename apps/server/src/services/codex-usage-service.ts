import { spawn, type ChildProcess } from 'child_process';
import readline from 'readline';
import {
  findCodexCliPath,
  getCodexAuthPath,
  systemPathExists,
  systemPathReadFile,
} from '@automaker/platform';
import { createLogger } from '@automaker/utils';

const logger = createLogger('CodexUsage');

export interface CodexRateLimitWindow {
  limit: number;
  used: number;
  remaining: number;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexCreditsSnapshot {
  balance?: string;
  unlimited?: boolean;
  hasCredits?: boolean;
}

export type CodexPlanType = 'free' | 'plus' | 'pro' | 'team' | 'enterprise' | 'edu' | 'unknown';

export interface CodexUsageData {
  rateLimits: {
    primary?: CodexRateLimitWindow;
    secondary?: CodexRateLimitWindow;
    credits?: CodexCreditsSnapshot;
    planType?: CodexPlanType;
  } | null;
  lastUpdated: string;
}

/**
 * JSON-RPC response types from Codex app-server
 */
interface AppServerAccountResponse {
  account: {
    type: 'apiKey' | 'chatgpt';
    email?: string;
    planType?: string;
  } | null;
  requiresOpenaiAuth: boolean;
}

interface AppServerRateLimitsResponse {
  rateLimits: {
    primary: {
      usedPercent: number;
      windowDurationMins: number;
      resetsAt: number;
    } | null;
    secondary: {
      usedPercent: number;
      windowDurationMins: number;
      resetsAt: number;
    } | null;
    credits?: unknown;
    planType?: string; // This is the most accurate/current plan type
  };
}

/**
 * Codex Usage Service
 *
 * Fetches usage data from Codex CLI using the app-server JSON-RPC API.
 * Falls back to auth file parsing if app-server is unavailable.
 */
export class CodexUsageService {
  private cachedCliPath: string | null = null;
  private accountPlanTypeArray: CodexPlanType[] = [
    'free',
    'plus',
    'pro',
    'team',
    'enterprise',
    'edu',
  ];
  /**
   * Check if Codex CLI is available on the system
   */
  async isAvailable(): Promise<boolean> {
    this.cachedCliPath = await findCodexCliPath();
    return Boolean(this.cachedCliPath);
  }

  /**
   * Attempt to fetch usage data
   *
   * Priority order:
   * 1. Codex app-server JSON-RPC API (most reliable, provides real-time data)
   * 2. Auth file JWT parsing (fallback for plan type)
   */
  async fetchUsageData(): Promise<CodexUsageData> {
    logger.info('[fetchUsageData] Starting...');
    const cliPath = this.cachedCliPath || (await findCodexCliPath());

    if (!cliPath) {
      logger.error('[fetchUsageData] Codex CLI not found');
      throw new Error('Codex CLI not found. Please install it with: npm install -g @openai/codex');
    }

    logger.info(`[fetchUsageData] Using CLI path: ${cliPath}`);

    // Try to get usage from Codex app-server (most reliable method)
    const appServerUsage = await this.fetchFromAppServer(cliPath);
    if (appServerUsage) {
      logger.info(
        '[fetchUsageData] Got data from app-server:',
        JSON.stringify(appServerUsage, null, 2)
      );
      return appServerUsage;
    }

    logger.info('[fetchUsageData] App-server failed, trying auth file fallback...');

    // Fallback: try to parse usage from auth file
    const authUsage = await this.fetchFromAuthFile();
    if (authUsage) {
      logger.info('[fetchUsageData] Got data from auth file:', JSON.stringify(authUsage, null, 2));
      return authUsage;
    }

    logger.info('[fetchUsageData] All methods failed, returning unknown');

    // If all else fails, return unknown
    return {
      rateLimits: {
        planType: 'unknown',
        credits: {
          hasCredits: true,
        },
      },
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Fetch usage data from Codex app-server using JSON-RPC API
   * This is the most reliable method as it gets real-time data from OpenAI
   */
  private async fetchFromAppServer(cliPath: string): Promise<CodexUsageData | null> {
    let childProcess: ChildProcess | null = null;

    try {
      // On Windows, .cmd files must be run through shell
      const needsShell = process.platform === 'win32' && cliPath.toLowerCase().endsWith('.cmd');

      childProcess = spawn(cliPath, ['app-server'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: 'dumb',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: needsShell,
      });

      if (!childProcess.stdin || !childProcess.stdout) {
        throw new Error('Failed to create stdio pipes');
      }

      // Setup readline for reading JSONL responses
      const rl = readline.createInterface({
        input: childProcess.stdout,
        crlfDelay: Infinity,
      });

      // Message ID counter for JSON-RPC
      let messageId = 0;
      const pendingRequests = new Map<
        number,
        {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
          timeout: NodeJS.Timeout;
        }
      >();

      // Process incoming messages
      rl.on('line', (line) => {
        if (!line.trim()) return;

        try {
          const message = JSON.parse(line);

          // Handle response to our request
          if ('id' in message && message.id !== undefined) {
            const pending = pendingRequests.get(message.id);
            if (pending) {
              clearTimeout(pending.timeout);
              pendingRequests.delete(message.id);
              if (message.error) {
                pending.reject(new Error(message.error.message || 'Unknown error'));
              } else {
                pending.resolve(message.result);
              }
            }
          }
          // Ignore notifications (no id field)
        } catch {
          // Ignore parse errors for non-JSON lines
        }
      });

      // Helper to send JSON-RPC request and wait for response
      const sendRequest = <T>(method: string, params?: unknown): Promise<T> => {
        return new Promise((resolve, reject) => {
          const id = ++messageId;
          const request = params ? { method, id, params } : { method, id };

          // Set timeout for request
          const timeout = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`Request timeout: ${method}`));
          }, 10000);

          pendingRequests.set(id, {
            resolve: resolve as (value: unknown) => void,
            reject,
            timeout,
          });

          childProcess!.stdin!.write(JSON.stringify(request) + '\n');
        });
      };

      // Helper to send notification (no response expected)
      const sendNotification = (method: string, params?: unknown): void => {
        const notification = params ? { method, params } : { method };
        childProcess!.stdin!.write(JSON.stringify(notification) + '\n');
      };

      // 1. Initialize the app-server
      logger.info('[fetchFromAppServer] Sending initialize request...');
      const initResult = await sendRequest('initialize', {
        clientInfo: {
          name: 'automaker',
          title: 'AutoMaker',
          version: '1.0.0',
        },
      });
      logger.info('[fetchFromAppServer] Initialize result:', JSON.stringify(initResult, null, 2));

      // 2. Send initialized notification
      sendNotification('initialized');
      logger.info('[fetchFromAppServer] Sent initialized notification');

      // 3. Get account info (includes plan type)
      logger.info('[fetchFromAppServer] Requesting account/read...');
      const accountResult = await sendRequest<AppServerAccountResponse>('account/read', {
        refreshToken: false,
      });
      logger.info('[fetchFromAppServer] Account result:', JSON.stringify(accountResult, null, 2));

      // 4. Get rate limits
      let rateLimitsResult: AppServerRateLimitsResponse | null = null;
      try {
        logger.info('[fetchFromAppServer] Requesting account/rateLimits/read...');
        rateLimitsResult =
          await sendRequest<AppServerRateLimitsResponse>('account/rateLimits/read');
        logger.info(
          '[fetchFromAppServer] Rate limits result:',
          JSON.stringify(rateLimitsResult, null, 2)
        );
      } catch (rateLimitError) {
        // Rate limits may not be available for API key auth
        logger.info('[fetchFromAppServer] Rate limits not available:', rateLimitError);
      }

      // Clean up
      rl.close();
      childProcess.kill('SIGTERM');

      // Build response
      // Prefer planType from rateLimits (more accurate/current) over account (can be stale)
      let planType: CodexPlanType = 'unknown';

      // First try rate limits planType (most accurate)
      const rateLimitsPlanType = rateLimitsResult?.rateLimits?.planType;
      if (rateLimitsPlanType) {
        const normalizedType = rateLimitsPlanType.toLowerCase() as CodexPlanType;
        logger.info(
          `[fetchFromAppServer] Rate limits planType: "${rateLimitsPlanType}", normalized: "${normalizedType}"`
        );
        if (this.accountPlanTypeArray.includes(normalizedType)) {
          planType = normalizedType;
        }
      }

      // Fall back to account planType if rate limits didn't have it
      if (planType === 'unknown' && accountResult.account?.planType) {
        const normalizedType = accountResult.account.planType.toLowerCase() as CodexPlanType;
        logger.info(
          `[fetchFromAppServer] Fallback to account planType: "${accountResult.account.planType}", normalized: "${normalizedType}"`
        );
        if (this.accountPlanTypeArray.includes(normalizedType)) {
          planType = normalizedType;
        }
      }

      if (planType === 'unknown') {
        logger.info('[fetchFromAppServer] No planType found in either response');
      } else {
        logger.info(`[fetchFromAppServer] Final planType: ${planType}`);
      }

      const result: CodexUsageData = {
        rateLimits: {
          planType,
          credits: {
            hasCredits: true,
            unlimited: planType !== 'free' && planType !== 'unknown',
          },
        },
        lastUpdated: new Date().toISOString(),
      };

      // Add rate limit info if available
      if (rateLimitsResult?.rateLimits?.primary) {
        const primary = rateLimitsResult.rateLimits.primary;
        logger.info(
          '[fetchFromAppServer] Adding primary rate limit:',
          JSON.stringify(primary, null, 2)
        );
        result.rateLimits!.primary = {
          limit: 100, // Not provided by API, using placeholder
          used: primary.usedPercent,
          remaining: 100 - primary.usedPercent,
          usedPercent: primary.usedPercent,
          windowDurationMins: primary.windowDurationMins,
          resetsAt: primary.resetsAt,
        };
      } else {
        logger.info('[fetchFromAppServer] No primary rate limit in result');
      }

      // Add secondary rate limit if available
      if (rateLimitsResult?.rateLimits?.secondary) {
        const secondary = rateLimitsResult.rateLimits.secondary;
        logger.info(
          '[fetchFromAppServer] Adding secondary rate limit:',
          JSON.stringify(secondary, null, 2)
        );
        result.rateLimits!.secondary = {
          limit: 100,
          used: secondary.usedPercent,
          remaining: 100 - secondary.usedPercent,
          usedPercent: secondary.usedPercent,
          windowDurationMins: secondary.windowDurationMins,
          resetsAt: secondary.resetsAt,
        };
      }

      logger.info('[fetchFromAppServer] Final result:', JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      // App-server method failed, will fall back to other methods
      logger.error('Failed to fetch from app-server:', error);
      return null;
    } finally {
      // Ensure process is killed
      if (childProcess && !childProcess.killed) {
        childProcess.kill('SIGTERM');
      }
    }
  }

  /**
   * Extract plan type from auth file JWT token
   * Returns the actual plan type or 'unknown' if not available
   */
  private async getPlanTypeFromAuthFile(): Promise<CodexPlanType> {
    try {
      const authFilePath = getCodexAuthPath();
      logger.info(`[getPlanTypeFromAuthFile] Auth file path: ${authFilePath}`);
      const exists = systemPathExists(authFilePath);

      if (!exists) {
        logger.info('[getPlanTypeFromAuthFile] Auth file does not exist');
        return 'unknown';
      }

      const authContent = await systemPathReadFile(authFilePath);
      const authData = JSON.parse(authContent);

      if (!authData.tokens?.id_token) {
        logger.info('[getPlanTypeFromAuthFile] No id_token in auth file');
        return 'unknown';
      }

      const claims = this.parseJwt(authData.tokens.id_token);
      if (!claims) {
        logger.info('[getPlanTypeFromAuthFile] Failed to parse JWT');
        return 'unknown';
      }

      logger.info('[getPlanTypeFromAuthFile] JWT claims keys:', Object.keys(claims));

      // Extract plan type from nested OpenAI auth object with type validation
      const openaiAuthClaim = claims['https://api.openai.com/auth'];
      logger.info(
        '[getPlanTypeFromAuthFile] OpenAI auth claim:',
        JSON.stringify(openaiAuthClaim, null, 2)
      );

      let accountType: string | undefined;
      let isSubscriptionExpired = false;

      if (
        openaiAuthClaim &&
        typeof openaiAuthClaim === 'object' &&
        !Array.isArray(openaiAuthClaim)
      ) {
        const openaiAuth = openaiAuthClaim as Record<string, unknown>;

        if (typeof openaiAuth.chatgpt_plan_type === 'string') {
          accountType = openaiAuth.chatgpt_plan_type;
        }

        // Check if subscription has expired
        if (typeof openaiAuth.chatgpt_subscription_active_until === 'string') {
          const expiryDate = new Date(openaiAuth.chatgpt_subscription_active_until);
          if (!isNaN(expiryDate.getTime())) {
            isSubscriptionExpired = expiryDate < new Date();
          }
        }
      } else {
        // Fallback: try top-level claim names
        const possibleClaimNames = [
          'https://chatgpt.com/account_type',
          'account_type',
          'plan',
          'plan_type',
        ];

        for (const claimName of possibleClaimNames) {
          const claimValue = claims[claimName];
          if (claimValue && typeof claimValue === 'string') {
            accountType = claimValue;
            break;
          }
        }
      }

      // If subscription is expired, treat as free plan
      if (isSubscriptionExpired && accountType && accountType !== 'free') {
        logger.info(`Subscription expired, using "free" instead of "${accountType}"`);
        accountType = 'free';
      }

      if (accountType) {
        const normalizedType = accountType.toLowerCase() as CodexPlanType;
        logger.info(
          `[getPlanTypeFromAuthFile] Account type: "${accountType}", normalized: "${normalizedType}"`
        );
        if (this.accountPlanTypeArray.includes(normalizedType)) {
          logger.info(`[getPlanTypeFromAuthFile] Returning plan type: ${normalizedType}`);
          return normalizedType;
        }
      } else {
        logger.info('[getPlanTypeFromAuthFile] No account type found in claims');
      }
    } catch (error) {
      logger.error('[getPlanTypeFromAuthFile] Failed to get plan type from auth file:', error);
    }

    logger.info('[getPlanTypeFromAuthFile] Returning unknown');
    return 'unknown';
  }

  /**
   * Try to extract usage info from the Codex auth file
   * Reuses getPlanTypeFromAuthFile to avoid code duplication
   */
  private async fetchFromAuthFile(): Promise<CodexUsageData | null> {
    logger.info('[fetchFromAuthFile] Starting...');
    try {
      const planType = await this.getPlanTypeFromAuthFile();
      logger.info(`[fetchFromAuthFile] Got plan type: ${planType}`);

      if (planType === 'unknown') {
        logger.info('[fetchFromAuthFile] Plan type unknown, returning null');
        return null;
      }

      const isFreePlan = planType === 'free';

      const result: CodexUsageData = {
        rateLimits: {
          planType,
          credits: {
            hasCredits: true,
            unlimited: !isFreePlan,
          },
        },
        lastUpdated: new Date().toISOString(),
      };

      logger.info('[fetchFromAuthFile] Returning result:', JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      logger.error('[fetchFromAuthFile] Failed to parse auth file:', error);
    }

    return null;
  }

  /**
   * Parse JWT token to extract claims
   */
  private parseJwt(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split('.');

      if (parts.length !== 3) {
        return null;
      }

      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');

      // Use Buffer for Node.js environment
      const jsonPayload = Buffer.from(base64, 'base64').toString('utf-8');

      return JSON.parse(jsonPayload);
    } catch {
      return null;
    }
  }
}
