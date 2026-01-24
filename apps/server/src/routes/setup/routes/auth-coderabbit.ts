/**
 * POST /auth-coderabbit endpoint - Authenticate CodeRabbit CLI via OAuth
 *
 * CodeRabbit CLI requires interactive authentication:
 * 1. Run `cr auth login`
 * 2. Browser opens with OAuth flow
 * 3. After browser auth, CLI shows a token
 * 4. User must press Enter to confirm
 *
 * Since step 4 requires interactive input, we can't fully automate this.
 * Instead, we provide the command for the user to run manually.
 */

import type { Request, Response } from 'express';
import { execSync } from 'child_process';
import { logError, getErrorMessage } from '../common.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Find the CodeRabbit CLI command (coderabbit or cr)
 */
function findCodeRabbitCommand(): string | null {
  const commands = ['coderabbit', 'cr'];
  for (const command of commands) {
    try {
      const whichCommand = process.platform === 'win32' ? 'where' : 'which';
      const result = execSync(`${whichCommand} ${command}`, {
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
      if (result) {
        return result.split('\n')[0];
      }
    } catch {
      // Command not found, try next
    }
  }
  return null;
}

export function createAuthCodeRabbitHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      // Remove the disconnected marker file to reconnect the app to the CLI
      const markerPath = path.join(process.cwd(), '.automaker', '.coderabbit-disconnected');
      if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
      }

      // Find CodeRabbit CLI
      const cliPath = findCodeRabbitCommand();
      if (!cliPath) {
        res.status(400).json({
          success: false,
          error: 'CodeRabbit CLI is not installed. Please install it first.',
        });
        return;
      }

      // CodeRabbit CLI requires interactive input (pressing Enter after OAuth)
      // We can't automate this, so we return the command for the user to run
      const command = cliPath.includes('coderabbit') ? 'coderabbit auth login' : 'cr auth login';

      res.json({
        success: true,
        requiresManualAuth: true,
        command,
        message: `Please run "${command}" in your terminal to authenticate. After completing OAuth in your browser, press Enter in the terminal to confirm.`,
      });
    } catch (error) {
      logError(error, 'Auth CodeRabbit failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
        message: 'Failed to initiate CodeRabbit authentication',
      });
    }
  };
}
