/**
 * GET /coderabbit-status endpoint - Get CodeRabbit CLI installation and auth status
 */

import type { Request, Response } from 'express';
import { spawn, execSync } from 'child_process';
import { getErrorMessage, logError } from '../common.js';
import * as fs from 'fs';
import * as path from 'path';

const DISCONNECTED_MARKER_FILE = '.coderabbit-disconnected';

function isCodeRabbitDisconnectedFromApp(): boolean {
  try {
    const projectRoot = process.cwd();
    const markerPath = path.join(projectRoot, '.automaker', DISCONNECTED_MARKER_FILE);
    return fs.existsSync(markerPath);
  } catch {
    return false;
  }
}

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

/**
 * Get CodeRabbit CLI version
 */
async function getCodeRabbitVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      stdio: 'pipe',
      timeout: 5000,
    });

    let stdout = '';
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0 && stdout) {
        resolve(stdout.trim());
      } else {
        resolve(null);
      }
    });

    child.on('error', () => {
      resolve(null);
    });
  });
}

interface CodeRabbitAuthInfo {
  authenticated: boolean;
  method: 'oauth' | 'none';
  username?: string;
  email?: string;
  organization?: string;
}

/**
 * Check CodeRabbit CLI authentication status
 * Parses output like:
 * ```
 * CodeRabbit CLI Status
 * ✅ Authentication: Logged in
 * User Information:
 *   👤 Name: Kacper
 *   📧 Email: kacperlachowiczwp.pl@wp.pl
 *   🔧 Username: Shironex
 * Organization Information:
 *   🏢 Name: Anime-World-SPZOO
 * ```
 */
async function getCodeRabbitAuthStatus(command: string): Promise<CodeRabbitAuthInfo> {
  return new Promise((resolve) => {
    const child = spawn(command, ['auth', 'status'], {
      stdio: 'pipe',
      timeout: 10000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      const output = stdout + stderr;

      // Check for "Logged in" in Authentication line
      const isAuthenticated =
        code === 0 &&
        (output.includes('Logged in') || output.includes('logged in')) &&
        !output.toLowerCase().includes('not logged in');

      if (isAuthenticated) {
        // Parse the structured output format
        // Username: look for "Username: <value>" line
        const usernameMatch = output.match(/Username:\s*(\S+)/i);
        // Email: look for "Email: <value>" line
        const emailMatch = output.match(/Email:\s*(\S+@\S+)/i);
        // Organization: look for "Name: <value>" under Organization Information
        // The org name appears after "Organization Information:" section
        const orgSection = output.split(/Organization Information:/i)[1];
        const orgMatch = orgSection?.match(/Name:\s*(.+?)(?:\n|$)/i);

        resolve({
          authenticated: true,
          method: 'oauth',
          username: usernameMatch?.[1]?.trim(),
          email: emailMatch?.[1]?.trim(),
          organization: orgMatch?.[1]?.trim(),
        });
      } else {
        resolve({
          authenticated: false,
          method: 'none',
        });
      }
    });

    child.on('error', () => {
      resolve({
        authenticated: false,
        method: 'none',
      });
    });
  });
}

/**
 * Creates handler for GET /api/setup/coderabbit-status
 * Returns CodeRabbit CLI installation and authentication status
 */
export function createCodeRabbitStatusHandler() {
  const installCommand = 'npm install -g coderabbit';
  const loginCommand = 'coderabbit auth login';

  return async (_req: Request, res: Response): Promise<void> => {
    try {
      // Check if user has manually disconnected from the app
      if (isCodeRabbitDisconnectedFromApp()) {
        res.json({
          success: true,
          installed: true,
          version: null,
          path: null,
          auth: {
            authenticated: false,
            method: 'none',
          },
          recommendation: 'CodeRabbit CLI is disconnected. Click Sign In to reconnect.',
          installCommand,
          loginCommand,
        });
        return;
      }

      // Find CodeRabbit CLI
      const cliPath = findCodeRabbitCommand();

      if (!cliPath) {
        res.json({
          success: true,
          installed: false,
          version: null,
          path: null,
          auth: {
            authenticated: false,
            method: 'none',
          },
          recommendation: 'Install CodeRabbit CLI to enable AI-powered code reviews.',
          installCommand,
          loginCommand,
          installCommands: {
            macos: 'curl -fsSL https://coderabbit.ai/install | bash',
            npm: installCommand,
          },
        });
        return;
      }

      // Get version
      const version = await getCodeRabbitVersion(cliPath);

      // Get auth status
      const authStatus = await getCodeRabbitAuthStatus(cliPath);

      res.json({
        success: true,
        installed: true,
        version,
        path: cliPath,
        auth: authStatus,
        recommendation: authStatus.authenticated
          ? undefined
          : 'Sign in to CodeRabbit to enable AI-powered code reviews.',
        installCommand,
        loginCommand,
        installCommands: {
          macos: 'curl -fsSL https://coderabbit.ai/install | bash',
          npm: installCommand,
        },
      });
    } catch (error) {
      logError(error, 'Get CodeRabbit status failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
