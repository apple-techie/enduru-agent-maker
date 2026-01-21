import { useState, useEffect, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FlaskConical, Save, RotateCcw, Info } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { getHttpApiClient } from '@/lib/http-api-client';
import { toast } from 'sonner';
import type { Project } from '@/lib/electron';

interface TestingSectionProps {
  project: Project;
}

export function TestingSection({ project }: TestingSectionProps) {
  const [testCommand, setTestCommand] = useState('');
  const [originalTestCommand, setOriginalTestCommand] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Check if there are unsaved changes
  const hasChanges = testCommand !== originalTestCommand;

  // Load project settings when project changes
  useEffect(() => {
    let isCancelled = false;
    const currentPath = project.path;

    const loadProjectSettings = async () => {
      setIsLoading(true);
      try {
        const httpClient = getHttpApiClient();
        const response = await httpClient.settings.getProject(currentPath);

        // Avoid updating state if component unmounted or project changed
        if (isCancelled) return;

        if (response.success && response.settings) {
          const command = response.settings.testCommand || '';
          setTestCommand(command);
          setOriginalTestCommand(command);
        }
      } catch (error) {
        if (!isCancelled) {
          console.error('Failed to load project settings:', error);
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    loadProjectSettings();

    return () => {
      isCancelled = true;
    };
  }, [project.path]);

  // Save test command
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const httpClient = getHttpApiClient();
      const response = await httpClient.settings.updateProject(project.path, {
        testCommand: testCommand.trim() || undefined,
      });

      if (response.success) {
        setOriginalTestCommand(testCommand);
        toast.success('Test command saved');
      } else {
        toast.error('Failed to save test command', {
          description: response.error,
        });
      }
    } catch (error) {
      console.error('Failed to save test command:', error);
      toast.error('Failed to save test command');
    } finally {
      setIsSaving(false);
    }
  }, [project.path, testCommand]);

  // Reset to original value
  const handleReset = useCallback(() => {
    setTestCommand(originalTestCommand);
  }, [originalTestCommand]);

  // Use a preset command
  const handleUsePreset = useCallback((command: string) => {
    setTestCommand(command);
  }, []);

  return (
    <div
      className={cn(
        'rounded-2xl overflow-hidden',
        'border border-border/50',
        'bg-gradient-to-br from-card/90 via-card/70 to-card/80 backdrop-blur-xl',
        'shadow-sm shadow-black/5'
      )}
    >
      <div className="p-6 border-b border-border/50 bg-gradient-to-r from-transparent via-accent/5 to-transparent">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500/20 to-brand-600/10 flex items-center justify-center border border-brand-500/20">
            <FlaskConical className="w-5 h-5 text-brand-500" />
          </div>
          <h2 className="text-lg font-semibold text-foreground tracking-tight">
            Testing Configuration
          </h2>
        </div>
        <p className="text-sm text-muted-foreground/80 ml-12">
          Configure how tests are run for this project.
        </p>
      </div>

      <div className="p-6 space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : (
          <>
            {/* Test Command Input */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="test-command" className="text-foreground font-medium">
                  Test Command
                </Label>
                {hasChanges && (
                  <span className="text-xs text-amber-500 font-medium">(unsaved changes)</span>
                )}
              </div>
              <Input
                id="test-command"
                value={testCommand}
                onChange={(e) => setTestCommand(e.target.value)}
                placeholder="e.g., npm test, yarn test, pytest, go test ./..."
                className="font-mono text-sm"
                data-testid="test-command-input"
              />
              <p className="text-xs text-muted-foreground/80 leading-relaxed">
                The command to run tests for this project. If not specified, the test runner will
                auto-detect based on your project structure (package.json, Cargo.toml, go.mod,
                etc.).
              </p>
            </div>

            {/* Auto-detection Info */}
            <div className="flex items-start gap-3 p-3 rounded-lg bg-accent/20 border border-border/30">
              <Info className="w-4 h-4 text-brand-500 mt-0.5 shrink-0" />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Auto-detection</p>
                <p>
                  When no custom command is set, the test runner automatically detects and uses the
                  appropriate test framework based on your project files (Vitest, Jest, Pytest,
                  Cargo, Go Test, etc.).
                </p>
              </div>
            </div>

            {/* Quick Presets */}
            <div className="space-y-3">
              <Label className="text-foreground font-medium">Quick Presets</Label>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'npm test', command: 'npm test' },
                  { label: 'yarn test', command: 'yarn test' },
                  { label: 'pnpm test', command: 'pnpm test' },
                  { label: 'bun test', command: 'bun test' },
                  { label: 'pytest', command: 'pytest' },
                  { label: 'cargo test', command: 'cargo test' },
                  { label: 'go test', command: 'go test ./...' },
                ].map((preset) => (
                  <Button
                    key={preset.command}
                    variant="outline"
                    size="sm"
                    onClick={() => handleUsePreset(preset.command)}
                    className="text-xs font-mono"
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground/80">
                Click a preset to use it as your test command.
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
                disabled={!hasChanges || isSaving}
                className="gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!hasChanges || isSaving}
                className="gap-1.5"
              >
                {isSaving ? <Spinner size="xs" /> : <Save className="w-3.5 h-3.5" />}
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
