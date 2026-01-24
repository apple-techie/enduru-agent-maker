import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import {
  CodeRabbitCliStatus,
  CodeRabbitCliStatusSkeleton,
} from '../cli-status/coderabbit-cli-status';
import type { CodeRabbitAuthStatus } from '../cli-status/coderabbit-cli-status';
import { getElectronAPI } from '@/lib/electron';
import { createLogger } from '@automaker/utils/logger';
import type { CliStatus as SharedCliStatus } from '../shared/types';

const logger = createLogger('CodeRabbitSettings');

export function CodeRabbitSettingsTab() {
  // Start with isCheckingCli=true to show skeleton on initial load
  const [isCheckingCli, setIsCheckingCli] = useState(true);
  const [cliStatus, setCliStatus] = useState<SharedCliStatus | null>(null);
  const [authStatus, setAuthStatus] = useState<CodeRabbitAuthStatus | null>(null);

  // Load CLI status on mount
  useEffect(() => {
    const checkStatus = async () => {
      setIsCheckingCli(true);
      try {
        const api = getElectronAPI();
        if (api?.setup?.getCodeRabbitStatus) {
          const result = await api.setup.getCodeRabbitStatus();
          setCliStatus({
            success: result.success,
            status: result.installed ? 'installed' : 'not_installed',
            version: result.version,
            path: result.path,
            recommendation: result.recommendation,
            installCommands: result.installCommands,
          });
          if (result.auth) {
            setAuthStatus({
              authenticated: result.auth.authenticated,
              method: result.auth.method || 'none',
              username: result.auth.username,
              email: result.auth.email,
              organization: result.auth.organization,
            });
          }
        } else {
          setCliStatus({
            success: false,
            status: 'not_installed',
            recommendation: 'CodeRabbit CLI detection is only available in desktop mode.',
          });
        }
      } catch (error) {
        logger.error('Failed to check CodeRabbit CLI status:', error);
        setCliStatus({
          success: false,
          status: 'not_installed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      } finally {
        setIsCheckingCli(false);
      }
    };
    checkStatus();
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsCheckingCli(true);
    try {
      const api = getElectronAPI();
      if (api?.setup?.getCodeRabbitStatus) {
        const result = await api.setup.getCodeRabbitStatus();
        setCliStatus({
          success: result.success,
          status: result.installed ? 'installed' : 'not_installed',
          version: result.version,
          path: result.path,
          recommendation: result.recommendation,
          installCommands: result.installCommands,
        });
        if (result.auth) {
          setAuthStatus({
            authenticated: result.auth.authenticated,
            method: result.auth.method || 'none',
            username: result.auth.username,
            email: result.auth.email,
            organization: result.auth.organization,
          });
        } else {
          setAuthStatus(null);
        }

        if (result.installed) {
          toast.success('CodeRabbit CLI refreshed');
        }
      }
    } catch (error) {
      logger.error('Failed to refresh CodeRabbit CLI status:', error);
      toast.error('Failed to refresh CodeRabbit CLI status');
    } finally {
      setIsCheckingCli(false);
    }
  }, []);

  // Show skeleton only while checking CLI status initially
  if (!cliStatus && isCheckingCli) {
    return (
      <div className="space-y-6">
        <CodeRabbitCliStatusSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <CodeRabbitCliStatus
        status={cliStatus}
        authStatus={authStatus}
        isChecking={isCheckingCli}
        onRefresh={handleRefresh}
      />
    </div>
  );
}

export default CodeRabbitSettingsTab;
