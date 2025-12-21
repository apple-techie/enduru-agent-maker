import type { NavigateOptions } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { AutomakerLogo } from './automaker-logo';
import { BugReportButton } from './bug-report-button';

interface SidebarHeaderProps {
  sidebarOpen: boolean;
  navigate: (opts: NavigateOptions) => void;
}

export function SidebarHeader({ sidebarOpen, navigate }: SidebarHeaderProps) {
  return (
    <>
      {/* Logo */}
      <div
        className={cn(
          'h-20 shrink-0 titlebar-drag-region',
          // Subtle bottom border with gradient fade
          'border-b border-border/40',
          // Background gradient for depth
          'bg-gradient-to-b from-transparent to-background/5',
          'flex items-center',
          sidebarOpen ? 'px-3 lg:px-5 justify-start' : 'px-3 justify-center'
        )}
      >
        <AutomakerLogo sidebarOpen={sidebarOpen} navigate={navigate} />
        {/* Bug Report Button - Inside logo container when expanded */}
        {sidebarOpen && <BugReportButton sidebarExpanded />}
      </div>

      {/* Bug Report Button - Collapsed sidebar version */}
      {!sidebarOpen && (
        <div className="px-3 mt-1.5 flex justify-center">
          <BugReportButton sidebarExpanded={false} />
        </div>
      )}
    </>
  );
}
