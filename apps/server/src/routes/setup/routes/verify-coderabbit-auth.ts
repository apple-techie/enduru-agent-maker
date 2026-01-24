/**
 * POST /verify-coderabbit-auth endpoint - Verify CodeRabbit authentication
 * Validates API key format and optionally tests the connection
 */

import type { Request, Response } from 'express';
import { spawn } from 'child_process';
import { createLogger } from '@automaker/utils';
import { AuthRateLimiter, validateApiKey } from '../../../lib/auth-utils.js';

const logger = createLogger('Setup');
const rateLimiter = new AuthRateLimiter();

/**
 * Test CodeRabbit CLI authentication by running a simple command
 */
async function testCodeRabbitCli(
  apiKey?: string
): Promise<{ authenticated: boolean; error?: string }> {
  return new Promise((resolve) => {
    // Set up environment with API key if provided
    const env = { ...process.env };
    if (apiKey) {
      env.CODERABBIT_API_KEY = apiKey;
    }

    // Try to run coderabbit auth status to verify auth
    const child = spawn('coderabbit', ['auth', 'status'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
      if (code === 0) {
        // Check output for authentication status
        const output = stdout.toLowerCase() + stderr.toLowerCase();
        if (
          output.includes('authenticated') ||
          output.includes('logged in') ||
          output.includes('valid')
        ) {
          resolve({ authenticated: true });
        } else if (output.includes('not authenticated') || output.includes('not logged in')) {
          resolve({ authenticated: false, error: 'CodeRabbit CLI is not authenticated.' });
        } else {
          // Command succeeded, assume authenticated
          resolve({ authenticated: true });
        }
      } else {
        // Command failed
        const errorMsg = stderr || stdout || 'CodeRabbit CLI authentication check failed.';
        resolve({ authenticated: false, error: errorMsg.trim() });
      }
    });

    child.on('error', (err) => {
      // CodeRabbit CLI not installed or other error
      resolve({ authenticated: false, error: `CodeRabbit CLI error: ${err.message}` });
    });
  });
}

/**
 * Validate CodeRabbit API key format
 * CodeRabbit API keys typically start with 'cr-'
 */
function validateCodeRabbitKey(apiKey: string): { isValid: boolean; error?: string } {
  if (!apiKey || apiKey.trim().length === 0) {
    return { isValid: false, error: 'API key cannot be empty.' };
  }

  // CodeRabbit API keys typically start with 'cr-'
  if (!apiKey.startsWith('cr-')) {
    return {
      isValid: false,
      error: 'Invalid CodeRabbit API key format. Keys should start with "cr-".',
    };
  }

  if (apiKey.length < 10) {
    return { isValid: false, error: 'API key is too short.' };
  }

  return { isValid: true };
}

export function createVerifyCodeRabbitAuthHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { authMethod, apiKey } = req.body as {
        authMethod?: 'cli' | 'api_key';
        apiKey?: string;
      };

      // Rate limiting to prevent abuse
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      if (!rateLimiter.canAttempt(clientIp)) {
        const resetTime = rateLimiter.getResetTime(clientIp);
        res.status(429).json({
          success: false,
          authenticated: false,
          error: 'Too many authentication attempts. Please try again later.',
          resetTime,
        });
        return;
      }

      logger.info(
        `[Setup] Verifying CodeRabbit authentication using method: ${authMethod || 'auto'}${apiKey ? ' (with provided key)' : ''}`
      );

      // For API key verification
      if (authMethod === 'api_key' && apiKey) {
        // Validate key format
        const validation = validateCodeRabbitKey(apiKey);
        if (!validation.isValid) {
          res.json({
            success: true,
            authenticated: false,
            error: validation.error,
          });
          return;
        }

        // Test the CLI with the provided API key
        const result = await testCodeRabbitCli(apiKey);
        res.json({
          success: true,
          authenticated: result.authenticated,
          error: result.error,
        });
        return;
      }

      // For CLI auth or auto detection
      const result = await testCodeRabbitCli();
      res.json({
        success: true,
        authenticated: result.authenticated,
        error: result.error,
      });
    } catch (error) {
      logger.error('[Setup] Verify CodeRabbit auth endpoint error:', error);
      res.status(500).json({
        success: false,
        authenticated: false,
        error: error instanceof Error ? error.message : 'Verification failed',
      });
    }
  };
}
