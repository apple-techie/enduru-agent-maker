/**
 * GET /test-logs endpoint - Get buffered logs for a test runner session
 *
 * Returns the scrollback buffer containing historical log output for a test run.
 * Used by clients to populate the log panel on initial connection
 * before subscribing to real-time updates via WebSocket.
 *
 * Query parameters:
 * - worktreePath: Path to the worktree (optional if sessionId provided)
 * - sessionId: Specific test session ID (optional, uses active session if not provided)
 */

import type { Request, Response } from 'express';
import { getTestRunnerService } from '../../../services/test-runner-service.js';
import { getErrorMessage, logError } from '../common.js';

export function createGetTestLogsHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath, sessionId } = req.query as {
        worktreePath?: string;
        sessionId?: string;
      };

      const testRunnerService = getTestRunnerService();

      // If sessionId is provided, get logs for that specific session
      if (sessionId) {
        const result = testRunnerService.getSessionOutput(sessionId);

        if (result.success && result.result) {
          const session = testRunnerService.getSession(sessionId);
          res.json({
            success: true,
            result: {
              sessionId: result.result.sessionId,
              worktreePath: session?.worktreePath,
              command: session?.command,
              status: result.result.status,
              testFile: session?.testFile,
              logs: result.result.output,
              startedAt: result.result.startedAt,
              finishedAt: result.result.finishedAt,
              exitCode: session?.exitCode ?? null,
            },
          });
        } else {
          res.status(404).json({
            success: false,
            error: result.error || 'Failed to get test logs',
          });
        }
        return;
      }

      // If worktreePath is provided, get logs for the active session
      if (worktreePath) {
        const activeSession = testRunnerService.getActiveSession(worktreePath);

        if (activeSession) {
          const result = testRunnerService.getSessionOutput(activeSession.id);

          if (result.success && result.result) {
            res.json({
              success: true,
              result: {
                sessionId: activeSession.id,
                worktreePath: activeSession.worktreePath,
                command: activeSession.command,
                status: result.result.status,
                testFile: activeSession.testFile,
                logs: result.result.output,
                startedAt: result.result.startedAt,
                finishedAt: result.result.finishedAt,
                exitCode: activeSession.exitCode,
              },
            });
          } else {
            res.status(404).json({
              success: false,
              error: result.error || 'Failed to get test logs',
            });
          }
        } else {
          // No active session - check for most recent session for this worktree
          const sessions = testRunnerService.listSessions(worktreePath);
          if (sessions.result.sessions.length > 0) {
            // Get the most recent session (list is not sorted, so find it)
            const mostRecent = sessions.result.sessions.reduce((latest, current) => {
              const latestTime = new Date(latest.startedAt).getTime();
              const currentTime = new Date(current.startedAt).getTime();
              return currentTime > latestTime ? current : latest;
            });

            const result = testRunnerService.getSessionOutput(mostRecent.sessionId);
            if (result.success && result.result) {
              res.json({
                success: true,
                result: {
                  sessionId: mostRecent.sessionId,
                  worktreePath: mostRecent.worktreePath,
                  command: mostRecent.command,
                  status: result.result.status,
                  testFile: mostRecent.testFile,
                  logs: result.result.output,
                  startedAt: result.result.startedAt,
                  finishedAt: result.result.finishedAt,
                  exitCode: mostRecent.exitCode,
                },
              });
              return;
            }
          }

          res.status(404).json({
            success: false,
            error: 'No test sessions found for this worktree',
          });
        }
        return;
      }

      // Neither sessionId nor worktreePath provided
      res.status(400).json({
        success: false,
        error: 'Either worktreePath or sessionId query parameter is required',
      });
    } catch (error) {
      logError(error, 'Get test logs failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
