/**
 * GET /status endpoint - Get unified CLI availability status
 *
 * Returns the installation and authentication status of all supported CLIs
 * in a single response. This is useful for quickly determining which
 * providers are available without making multiple API calls.
 */

import type { Request, Response } from 'express';
import { getClaudeStatus } from '../get-claude-status.js';
import { getErrorMessage, logError } from '../common.js';
import { CursorProvider } from '../../../providers/cursor-provider.js';
import { CodexProvider } from '../../../providers/codex-provider.js';
import { OpencodeProvider } from '../../../providers/opencode-provider.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Check if a CLI has been manually disconnected from the app
 */
function isCliDisconnected(cliName: string): boolean {
  try {
    const projectRoot = process.cwd();
    const markerPath = path.join(projectRoot, '.automaker', `.${cliName}-disconnected`);
    return fs.existsSync(markerPath);
  } catch {
    return false;
  }
}

/**
 * CLI status response for a single provider
 */
interface CliStatusResponse {
  installed: boolean;
  version: string | null;
  path: string | null;
  auth: {
    authenticated: boolean;
    method: string;
  };
  disconnected: boolean;
}

/**
 * Unified status response for all CLIs
 */
interface UnifiedStatusResponse {
  success: boolean;
  timestamp: string;
  clis: {
    claude: CliStatusResponse | null;
    cursor: CliStatusResponse | null;
    codex: CliStatusResponse | null;
    opencode: CliStatusResponse | null;
  };
  availableProviders: string[];
  hasAnyAuthenticated: boolean;
}

/**
 * Get detailed Claude CLI status
 */
async function getClaudeCliStatus(): Promise<CliStatusResponse> {
  const disconnected = isCliDisconnected('claude');

  try {
    const status = await getClaudeStatus();
    return {
      installed: status.installed,
      version: status.version || null,
      path: status.path || null,
      auth: {
        authenticated: disconnected ? false : status.auth.authenticated,
        method: disconnected ? 'none' : status.auth.method,
      },
      disconnected,
    };
  } catch {
    return {
      installed: false,
      version: null,
      path: null,
      auth: { authenticated: false, method: 'none' },
      disconnected,
    };
  }
}

/**
 * Get detailed Cursor CLI status
 */
async function getCursorCliStatus(): Promise<CliStatusResponse> {
  const disconnected = isCliDisconnected('cursor');

  try {
    const provider = new CursorProvider();
    const [installed, version, auth] = await Promise.all([
      provider.isInstalled(),
      provider.getVersion(),
      provider.checkAuth(),
    ]);

    const cliPath = installed ? provider.getCliPath() : null;

    return {
      installed,
      version: version || null,
      path: cliPath,
      auth: {
        authenticated: disconnected ? false : auth.authenticated,
        method: disconnected ? 'none' : auth.method,
      },
      disconnected,
    };
  } catch {
    return {
      installed: false,
      version: null,
      path: null,
      auth: { authenticated: false, method: 'none' },
      disconnected,
    };
  }
}

/**
 * Get detailed Codex CLI status
 */
async function getCodexCliStatus(): Promise<CliStatusResponse> {
  const disconnected = isCliDisconnected('codex');

  try {
    const provider = new CodexProvider();
    const status = await provider.detectInstallation();

    let authMethod = 'none';
    if (!disconnected && status.authenticated) {
      authMethod = status.hasApiKey ? 'api_key_env' : 'cli_authenticated';
    }

    return {
      installed: status.installed,
      version: status.version || null,
      path: status.path || null,
      auth: {
        authenticated: disconnected ? false : status.authenticated || false,
        method: authMethod,
      },
      disconnected,
    };
  } catch {
    return {
      installed: false,
      version: null,
      path: null,
      auth: { authenticated: false, method: 'none' },
      disconnected,
    };
  }
}

/**
 * Get detailed OpenCode CLI status
 */
async function getOpencodeCliStatus(): Promise<CliStatusResponse> {
  try {
    const provider = new OpencodeProvider();
    const status = await provider.detectInstallation();

    let authMethod = 'none';
    if (status.authenticated) {
      authMethod = status.hasApiKey ? 'api_key_env' : 'cli_authenticated';
    }

    return {
      installed: status.installed,
      version: status.version || null,
      path: status.path || null,
      auth: {
        authenticated: status.authenticated || false,
        method: authMethod,
      },
      disconnected: false, // OpenCode doesn't have disconnect feature
    };
  } catch {
    return {
      installed: false,
      version: null,
      path: null,
      auth: { authenticated: false, method: 'none' },
      disconnected: false,
    };
  }
}

/**
 * Creates handler for GET /api/setup/status
 * Returns unified CLI availability status for all providers
 */
export function createStatusHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      // Fetch all CLI statuses in parallel for performance
      const [claude, cursor, codex, opencode] = await Promise.all([
        getClaudeCliStatus(),
        getCursorCliStatus(),
        getCodexCliStatus(),
        getOpencodeCliStatus(),
      ]);

      // Determine which providers are available (installed and authenticated)
      const availableProviders: string[] = [];
      if (claude.installed && claude.auth.authenticated) {
        availableProviders.push('claude');
      }
      if (cursor.installed && cursor.auth.authenticated) {
        availableProviders.push('cursor');
      }
      if (codex.installed && codex.auth.authenticated) {
        availableProviders.push('codex');
      }
      if (opencode.installed && opencode.auth.authenticated) {
        availableProviders.push('opencode');
      }

      const response: UnifiedStatusResponse = {
        success: true,
        timestamp: new Date().toISOString(),
        clis: {
          claude,
          cursor,
          codex,
          opencode,
        },
        availableProviders,
        hasAnyAuthenticated: availableProviders.length > 0,
      };

      res.json(response);
    } catch (error) {
      logError(error, 'Get unified CLI status failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
