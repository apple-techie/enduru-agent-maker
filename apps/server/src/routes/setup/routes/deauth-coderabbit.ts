/**
 * POST /deauth-coderabbit endpoint - Sign out from CodeRabbit CLI
 */

import type { Request, Response } from 'express';
import { spawn, execSync } from 'child_process';
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

export function createDeauthCodeRabbitHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      // Find CodeRabbit CLI
      const cliPath = findCodeRabbitCommand();

      if (cliPath) {
        // Try to run the CLI logout command
        const logoutResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const child = spawn(cliPath, ['auth', 'logout'], {
            stdio: 'pipe',
            timeout: 10000,
          });

          let stderr = '';
          child.stderr?.on('data', (data) => {
            stderr += data.toString();
          });

          child.on('close', (code) => {
            if (code === 0) {
              resolve({ success: true });
            } else {
              resolve({ success: false, error: stderr || 'Logout command failed' });
            }
          });

          child.on('error', (err) => {
            resolve({ success: false, error: err.message });
          });
        });

        if (!logoutResult.success) {
          // CLI logout failed, create marker file as fallback
          const automakerDir = path.join(process.cwd(), '.automaker');
          const markerPath = path.join(automakerDir, '.coderabbit-disconnected');

          if (!fs.existsSync(automakerDir)) {
            fs.mkdirSync(automakerDir, { recursive: true });
          }

          fs.writeFileSync(
            markerPath,
            JSON.stringify({
              disconnectedAt: new Date().toISOString(),
              message: 'CodeRabbit CLI is disconnected from the app',
            })
          );
        }
      } else {
        // CLI not installed, just create marker file
        const automakerDir = path.join(process.cwd(), '.automaker');
        const markerPath = path.join(automakerDir, '.coderabbit-disconnected');

        if (!fs.existsSync(automakerDir)) {
          fs.mkdirSync(automakerDir, { recursive: true });
        }

        fs.writeFileSync(
          markerPath,
          JSON.stringify({
            disconnectedAt: new Date().toISOString(),
            message: 'CodeRabbit CLI is disconnected from the app',
          })
        );
      }

      res.json({
        success: true,
        message: 'Successfully signed out from CodeRabbit CLI',
      });
    } catch (error) {
      logError(error, 'Deauth CodeRabbit failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
        message: 'Failed to sign out from CodeRabbit CLI',
      });
    }
  };
}
