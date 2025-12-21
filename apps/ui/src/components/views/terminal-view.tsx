import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Terminal as TerminalIcon,
  Plus,
  Lock,
  Unlock,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Loader2,
  AlertCircle,
  RefreshCw,
  X,
  SquarePlus,
} from 'lucide-react';
import { useAppStore, type TerminalPanelContent, type TerminalTab } from '@/store/app-store';
import { useKeyboardShortcutsConfig } from '@/hooks/use-keyboard-shortcuts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { TerminalPanel } from './terminal-view/terminal-panel';
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragOverEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  DragOverlay,
  useDroppable,
} from '@dnd-kit/core';
import { cn } from '@/lib/utils';

interface TerminalStatus {
  enabled: boolean;
  passwordRequired: boolean;
  platform: {
    platform: string;
    isWSL: boolean;
    defaultShell: string;
    arch: string;
  };
}

// Tab component with drop target support
function TerminalTabButton({
  tab,
  isActive,
  onClick,
  onClose,
  isDropTarget,
}: {
  tab: TerminalTab;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  isDropTarget: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `tab-${tab.id}`,
    data: { type: 'tab', tabId: tab.id },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-center gap-1 px-3 py-1.5 text-sm rounded-t-md border-b-2 cursor-pointer transition-colors',
        isActive
          ? 'bg-background border-brand-500 text-foreground'
          : 'bg-muted border-transparent text-muted-foreground hover:text-foreground hover:bg-accent',
        isOver && isDropTarget && 'ring-2 ring-green-500'
      )}
      onClick={onClick}
    >
      <TerminalIcon className="h-3 w-3" />
      <span className="max-w-24 truncate">{tab.name}</span>
      <button
        className="ml-1 p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// New tab drop zone
function NewTabDropZone({ isDropTarget }: { isDropTarget: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'new-tab-zone',
    data: { type: 'new-tab' },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-center justify-center px-3 py-1.5 rounded-t-md border-2 border-dashed transition-all',
        isOver && isDropTarget
          ? 'border-green-500 bg-green-500/10 text-green-500'
          : 'border-transparent text-muted-foreground hover:border-border'
      )}
    >
      <SquarePlus className="h-4 w-4" />
    </div>
  );
}

export function TerminalView() {
  const {
    terminalState,
    setTerminalUnlocked,
    addTerminalToLayout,
    removeTerminalFromLayout,
    setActiveTerminalSession,
    swapTerminals,
    currentProject,
    addTerminalTab,
    removeTerminalTab,
    setActiveTerminalTab,
    moveTerminalToTab,
    setTerminalPanelFontSize,
  } = useAppStore();

  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const lastCreateTimeRef = useRef<number>(0);
  const isCreatingRef = useRef<boolean>(false);

  const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:3008';
  const CREATE_COOLDOWN_MS = 500; // Prevent rapid terminal creation

  // Helper to check if terminal creation should be debounced
  const canCreateTerminal = (debounceMessage: string): boolean => {
    const now = Date.now();
    if (now - lastCreateTimeRef.current < CREATE_COOLDOWN_MS || isCreatingRef.current) {
      console.log(debounceMessage);
      return false;
    }
    lastCreateTimeRef.current = now;
    isCreatingRef.current = true;
    return true;
  };

  // Get active tab
  const activeTab = terminalState.tabs.find((t) => t.id === terminalState.activeTabId);

  // DnD sensors with activation constraint to avoid accidental drags
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  // Handle drag start
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  // Handle drag over - track which tab we're hovering
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (over?.data?.current?.type === 'tab') {
      setDragOverTabId(over.data.current.tabId);
    } else if (over?.data?.current?.type === 'new-tab') {
      setDragOverTabId('new');
    } else {
      setDragOverTabId(null);
    }
  }, []);

  // Handle drag end
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveDragId(null);
      setDragOverTabId(null);

      if (!over) return;

      const activeId = active.id as string;
      const overData = over.data?.current;

      // If dropped on a tab, move terminal to that tab
      if (overData?.type === 'tab') {
        moveTerminalToTab(activeId, overData.tabId);
        return;
      }

      // If dropped on new tab zone, create new tab with this terminal
      if (overData?.type === 'new-tab') {
        moveTerminalToTab(activeId, 'new');
        return;
      }

      // Otherwise, swap terminals within current tab
      if (active.id !== over.id) {
        swapTerminals(activeId, over.id as string);
      }
    },
    [swapTerminals, moveTerminalToTab]
  );

  // Fetch terminal status
  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${serverUrl}/api/terminal/status`);
      const data = await response.json();
      if (data.success) {
        setStatus(data.data);
        if (!data.data.passwordRequired) {
          setTerminalUnlocked(true);
        }
      } else {
        setError(data.error || 'Failed to get terminal status');
      }
    } catch (err) {
      setError('Failed to connect to server');
      console.error('[Terminal] Status fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [serverUrl, setTerminalUnlocked]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Handle password authentication
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);

    try {
      const response = await fetch(`${serverUrl}/api/terminal/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await response.json();

      if (data.success) {
        setTerminalUnlocked(true, data.data.token);
        setPassword('');
      } else {
        setAuthError(data.error || 'Authentication failed');
      }
    } catch (err) {
      setAuthError('Failed to authenticate');
      console.error('[Terminal] Auth error:', err);
    } finally {
      setAuthLoading(false);
    }
  };

  // Create a new terminal session
  // targetSessionId: the terminal to split (if splitting an existing terminal)
  const createTerminal = async (
    direction?: 'horizontal' | 'vertical',
    targetSessionId?: string
  ) => {
    if (!canCreateTerminal('[Terminal] Debounced terminal creation')) {
      return;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (terminalState.authToken) {
        headers['X-Terminal-Token'] = terminalState.authToken;
      }

      const response = await fetch(`${serverUrl}/api/terminal/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cwd: currentProject?.path || undefined,
          cols: 80,
          rows: 24,
        }),
      });
      const data = await response.json();

      if (data.success) {
        addTerminalToLayout(data.data.id, direction, targetSessionId);
      } else {
        console.error('[Terminal] Failed to create session:', data.error);
      }
    } catch (err) {
      console.error('[Terminal] Create session error:', err);
    } finally {
      isCreatingRef.current = false;
    }
  };

  // Create terminal in new tab
  const createTerminalInNewTab = async () => {
    if (!canCreateTerminal('[Terminal] Debounced terminal tab creation')) {
      return;
    }

    const tabId = addTerminalTab();
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (terminalState.authToken) {
        headers['X-Terminal-Token'] = terminalState.authToken;
      }

      const response = await fetch(`${serverUrl}/api/terminal/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cwd: currentProject?.path || undefined,
          cols: 80,
          rows: 24,
        }),
      });
      const data = await response.json();

      if (data.success) {
        // Add to the newly created tab
        const { addTerminalToTab } = useAppStore.getState();
        addTerminalToTab(data.data.id, tabId);
      }
    } catch (err) {
      console.error('[Terminal] Create session error:', err);
    } finally {
      isCreatingRef.current = false;
    }
  };

  // Kill a terminal session
  const killTerminal = async (sessionId: string) => {
    try {
      const headers: Record<string, string> = {};
      if (terminalState.authToken) {
        headers['X-Terminal-Token'] = terminalState.authToken;
      }

      await fetch(`${serverUrl}/api/terminal/sessions/${sessionId}`, {
        method: 'DELETE',
        headers,
      });
      removeTerminalFromLayout(sessionId);
    } catch (err) {
      console.error('[Terminal] Kill session error:', err);
    }
  };

  // Get keyboard shortcuts config
  const shortcuts = useKeyboardShortcutsConfig();

  // Handle terminal-specific keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle shortcuts when terminal is unlocked and has an active session
      if (!terminalState.isUnlocked || !terminalState.activeSessionId) return;

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

      // Parse shortcut string to check for match
      const matchesShortcut = (shortcutStr: string | undefined) => {
        if (!shortcutStr) return false;
        const parts = shortcutStr.toLowerCase().split('+');
        const key = parts[parts.length - 1];
        const needsCmd = parts.includes('cmd');
        const needsShift = parts.includes('shift');
        const needsAlt = parts.includes('alt');

        // Check modifiers
        const cmdMatches = needsCmd ? cmdOrCtrl : !cmdOrCtrl;
        const shiftMatches = needsShift ? e.shiftKey : !e.shiftKey;
        const altMatches = needsAlt ? e.altKey : !e.altKey;

        return e.key.toLowerCase() === key && cmdMatches && shiftMatches && altMatches;
      };

      // Split terminal right (Cmd+D / Ctrl+D)
      if (matchesShortcut(shortcuts.splitTerminalRight)) {
        e.preventDefault();
        createTerminal('horizontal', terminalState.activeSessionId);
        return;
      }

      // Split terminal down (Cmd+Shift+D / Ctrl+Shift+D)
      if (matchesShortcut(shortcuts.splitTerminalDown)) {
        e.preventDefault();
        createTerminal('vertical', terminalState.activeSessionId);
        return;
      }

      // Close terminal (Cmd+W / Ctrl+W)
      if (matchesShortcut(shortcuts.closeTerminal)) {
        e.preventDefault();
        killTerminal(terminalState.activeSessionId);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [terminalState.isUnlocked, terminalState.activeSessionId, shortcuts]);

  // Collect all terminal IDs from a panel tree in order
  const getTerminalIds = (panel: TerminalPanelContent): string[] => {
    if (panel.type === 'terminal') {
      return [panel.sessionId];
    }
    return panel.panels.flatMap(getTerminalIds);
  };

  // Get a STABLE key for a panel - based only on terminal IDs, not tree structure
  // This prevents unnecessary remounts when layout structure changes
  const getPanelKey = (panel: TerminalPanelContent): string => {
    if (panel.type === 'terminal') {
      return panel.sessionId;
    }
    // Use joined terminal IDs - stable regardless of nesting depth
    return `group-${getTerminalIds(panel).join('-')}`;
  };

  // Render panel content recursively
  const renderPanelContent = (content: TerminalPanelContent): React.ReactNode => {
    if (content.type === 'terminal') {
      // Use per-terminal fontSize or fall back to default
      const terminalFontSize = content.fontSize ?? terminalState.defaultFontSize;
      return (
        <TerminalPanel
          key={content.sessionId}
          sessionId={content.sessionId}
          authToken={terminalState.authToken}
          isActive={terminalState.activeSessionId === content.sessionId}
          onFocus={() => setActiveTerminalSession(content.sessionId)}
          onClose={() => killTerminal(content.sessionId)}
          onSplitHorizontal={() => createTerminal('horizontal', content.sessionId)}
          onSplitVertical={() => createTerminal('vertical', content.sessionId)}
          isDragging={activeDragId === content.sessionId}
          isDropTarget={activeDragId !== null && activeDragId !== content.sessionId}
          fontSize={terminalFontSize}
          onFontSizeChange={(size) => setTerminalPanelFontSize(content.sessionId, size)}
        />
      );
    }

    const isHorizontal = content.direction === 'horizontal';
    const defaultSizePerPanel = 100 / content.panels.length;

    return (
      <PanelGroup direction={content.direction}>
        {content.panels.map((panel, index) => {
          const panelSize =
            panel.type === 'terminal' && panel.size ? panel.size : defaultSizePerPanel;

          const panelKey = getPanelKey(panel);
          return (
            <React.Fragment key={panelKey}>
              {index > 0 && (
                <PanelResizeHandle
                  key={`handle-${panelKey}`}
                  className={
                    isHorizontal
                      ? 'w-1 h-full bg-border hover:bg-brand-500 transition-colors data-[resize-handle-state=hover]:bg-brand-500 data-[resize-handle-state=drag]:bg-brand-500'
                      : 'h-1 w-full bg-border hover:bg-brand-500 transition-colors data-[resize-handle-state=hover]:bg-brand-500 data-[resize-handle-state=drag]:bg-brand-500'
                  }
                />
              )}
              <Panel id={panelKey} order={index} defaultSize={panelSize} minSize={30}>
                {renderPanelContent(panel)}
              </Panel>
            </React.Fragment>
          );
        })}
      </PanelGroup>
    );
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
        <div className="p-4 rounded-full bg-destructive/10 mb-4">
          <AlertCircle className="h-12 w-12 text-destructive" />
        </div>
        <h2 className="text-lg font-medium mb-2">Terminal Unavailable</h2>
        <p className="text-muted-foreground max-w-md mb-4">{error}</p>
        <Button variant="outline" onClick={fetchStatus}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  // Disabled state
  if (!status?.enabled) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
        <div className="p-4 rounded-full bg-muted/50 mb-4">
          <TerminalIcon className="h-12 w-12 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-medium mb-2">Terminal Disabled</h2>
        <p className="text-muted-foreground max-w-md">
          Terminal access has been disabled. Set{' '}
          <code className="px-1.5 py-0.5 rounded bg-muted">TERMINAL_ENABLED=true</code> in your
          server .env file to enable it.
        </p>
      </div>
    );
  }

  // Password gate
  if (status.passwordRequired && !terminalState.isUnlocked) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
        <div className="p-4 rounded-full bg-muted/50 mb-4">
          <Lock className="h-12 w-12 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-medium mb-2">Terminal Protected</h2>
        <p className="text-muted-foreground max-w-md mb-6">
          Terminal access requires authentication. Enter the password to unlock.
        </p>

        <form onSubmit={handleAuth} className="w-full max-w-xs space-y-4">
          <Input
            type="password"
            placeholder="Enter password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={authLoading}
            autoFocus
          />
          {authError && <p className="text-sm text-destructive">{authError}</p>}
          <Button type="submit" className="w-full" disabled={authLoading || !password}>
            {authLoading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Unlock className="h-4 w-4 mr-2" />
            )}
            Unlock Terminal
          </Button>
        </form>

        {status.platform && (
          <p className="text-xs text-muted-foreground mt-6">
            Platform: {status.platform.platform}
            {status.platform.isWSL && ' (WSL)'}
            {' | '}Shell: {status.platform.defaultShell}
          </p>
        )}
      </div>
    );
  }

  // No terminals yet - show welcome screen
  if (terminalState.tabs.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
        <div className="p-4 rounded-full bg-brand-500/10 mb-4">
          <TerminalIcon className="h-12 w-12 text-brand-500" />
        </div>
        <h2 className="text-lg font-medium mb-2">Terminal</h2>
        <p className="text-muted-foreground max-w-md mb-6">
          Create a new terminal session to start executing commands.
          {currentProject && (
            <span className="block mt-2 text-sm">
              Working directory:{' '}
              <code className="px-1.5 py-0.5 rounded bg-muted">{currentProject.path}</code>
            </span>
          )}
        </p>

        <Button onClick={() => createTerminal()}>
          <Plus className="h-4 w-4 mr-2" />
          New Terminal
        </Button>

        {status?.platform && (
          <p className="text-xs text-muted-foreground mt-6">
            Platform: {status.platform.platform}
            {status.platform.isWSL && ' (WSL)'}
            {' | '}Shell: {status.platform.defaultShell}
          </p>
        )}
      </div>
    );
  }

  // Terminal view with tabs
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tab bar */}
        <div className="flex items-center bg-card border-b border-border px-2">
          {/* Tabs */}
          <div className="flex items-center gap-1 flex-1 overflow-x-auto py-1">
            {terminalState.tabs.map((tab) => (
              <TerminalTabButton
                key={tab.id}
                tab={tab}
                isActive={tab.id === terminalState.activeTabId}
                onClick={() => setActiveTerminalTab(tab.id)}
                onClose={() => removeTerminalTab(tab.id)}
                isDropTarget={activeDragId !== null}
              />
            ))}

            {/* New tab drop zone (visible when dragging) */}
            {activeDragId && <NewTabDropZone isDropTarget={true} />}

            {/* New tab button */}
            <button
              className="flex items-center justify-center p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              onClick={createTerminalInNewTab}
              title="New Tab"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {/* Toolbar buttons */}
          <div className="flex items-center gap-1 pl-2 border-l border-border">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => createTerminal('horizontal')}
              title="Split Right"
            >
              <SplitSquareHorizontal className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => createTerminal('vertical')}
              title="Split Down"
            >
              <SplitSquareVertical className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Active tab content */}
        <div className="flex-1 overflow-hidden bg-background">
          {activeTab?.layout ? (
            renderPanelContent(activeTab.layout)
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
              <p className="text-muted-foreground mb-4">This tab is empty</p>
              <Button variant="outline" size="sm" onClick={() => createTerminal()}>
                <Plus className="h-4 w-4 mr-2" />
                New Terminal
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Drag overlay */}
      <DragOverlay dropAnimation={null} zIndex={1000}>
        {activeDragId ? (
          <div className="relative inline-flex items-center gap-2 px-3.5 py-2 bg-card border-2 border-brand-500 rounded-lg shadow-xl pointer-events-none overflow-hidden">
            <TerminalIcon className="h-4 w-4 text-brand-500 shrink-0" />
            <span className="text-sm font-medium text-foreground whitespace-nowrap">
              {dragOverTabId === 'new' ? 'New tab' : dragOverTabId ? 'Move to tab' : 'Terminal'}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
