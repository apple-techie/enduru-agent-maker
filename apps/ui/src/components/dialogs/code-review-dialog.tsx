/**
 * CodeReviewDialog Component
 *
 * A dialog for displaying code review results from automated code analysis.
 * Shows the review verdict, summary, and detailed comments organized by severity.
 */

import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  FileCode,
  Copy,
  Check,
  AlertCircle,
  Info,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Clock,
  Wrench,
  RotateCcw,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import type {
  CodeReviewResult,
  CodeReviewComment,
  CodeReviewSeverity,
  CodeReviewCategory,
  CodeReviewVerdict,
} from '@automaker/types';

// ============================================================================
// Types
// ============================================================================

export interface CodeReviewDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** The code review result to display */
  review: CodeReviewResult | null;
  /** Optional loading state */
  loading?: boolean;
  /** Optional error message */
  error?: string | null;
  /** Optional callback when user wants to retry */
  onRetry?: () => void;
}

// ============================================================================
// Constants & Helpers
// ============================================================================

const SEVERITY_CONFIG: Record<
  CodeReviewSeverity,
  { label: string; variant: 'error' | 'warning' | 'info' | 'muted'; icon: typeof AlertCircle }
> = {
  critical: { label: 'Critical', variant: 'error', icon: AlertCircle },
  high: { label: 'High', variant: 'error', icon: AlertTriangle },
  medium: { label: 'Medium', variant: 'warning', icon: AlertTriangle },
  low: { label: 'Low', variant: 'info', icon: Info },
  info: { label: 'Info', variant: 'muted', icon: Info },
};

const SEVERITY_ORDER: CodeReviewSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

const CATEGORY_LABELS: Record<CodeReviewCategory, string> = {
  tech_stack: 'Tech Stack',
  security: 'Security',
  code_quality: 'Code Quality',
  implementation: 'Implementation',
  architecture: 'Architecture',
  performance: 'Performance',
  testing: 'Testing',
  documentation: 'Documentation',
};

const VERDICT_CONFIG: Record<
  CodeReviewVerdict,
  { label: string; variant: 'success' | 'warning' | 'info'; icon: typeof CheckCircle2 }
> = {
  approved: { label: 'Approved', variant: 'success', icon: CheckCircle2 },
  changes_requested: { label: 'Changes Requested', variant: 'warning', icon: AlertTriangle },
  needs_discussion: { label: 'Needs Discussion', variant: 'info', icon: MessageSquare },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// ============================================================================
// Sub-components
// ============================================================================

interface VerdictBadgeProps {
  verdict: CodeReviewVerdict;
  className?: string;
}

function VerdictBadge({ verdict, className }: VerdictBadgeProps) {
  const config = VERDICT_CONFIG[verdict];
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} size="lg" className={cn('gap-1.5', className)}>
      <Icon className="w-3.5 h-3.5" />
      {config.label}
    </Badge>
  );
}

interface SeverityBadgeProps {
  severity: CodeReviewSeverity;
  count?: number;
  className?: string;
}

function SeverityBadge({ severity, count, className }: SeverityBadgeProps) {
  const config = SEVERITY_CONFIG[severity];
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} size="sm" className={cn('gap-1', className)}>
      <Icon className="w-3 h-3" />
      {config.label}
      {count !== undefined && count > 0 && <span className="ml-0.5">({count})</span>}
    </Badge>
  );
}

interface CategoryBadgeProps {
  category: CodeReviewCategory;
  className?: string;
}

function CategoryBadge({ category, className }: CategoryBadgeProps) {
  return (
    <Badge variant="outline" size="sm" className={className}>
      {CATEGORY_LABELS[category]}
    </Badge>
  );
}

interface CommentCardProps {
  comment: CodeReviewComment;
  defaultExpanded?: boolean;
}

function CommentCard({ comment, defaultExpanded = false }: CommentCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const commentId = `comment-${comment.id}`;

  const lineRange =
    comment.startLine === comment.endLine
      ? `Line ${comment.startLine}`
      : `Lines ${comment.startLine}-${comment.endLine}`;

  const handleCopyCode = async () => {
    if (comment.suggestedCode) {
      await navigator.clipboard.writeText(comment.suggestedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card/50 overflow-hidden transition-all duration-200',
        'hover:border-border/80',
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2'
      )}
    >
      {/* Header - accessible expand/collapse button */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 p-3 text-left hover:bg-accent/30 transition-colors focus:outline-none focus-visible:bg-accent/30"
        aria-expanded={expanded}
        aria-controls={commentId}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} comment for ${comment.filePath} at ${lineRange}`}
      >
        <div className="flex-shrink-0 mt-0.5" aria-hidden="true">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          {/* File and line info */}
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileCode className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="font-mono truncate max-w-[200px]" title={comment.filePath}>
                {comment.filePath}
              </span>
              <span className="text-muted-foreground/60" aria-hidden="true">
                :
              </span>
              <span>{lineRange}</span>
            </div>
          </div>

          {/* Comment preview */}
          <p className={cn('text-sm text-foreground', !expanded && 'line-clamp-2')}>
            {comment.body}
          </p>

          {/* Visual indicator for truncated content */}
          {!expanded && comment.body.length > 150 && (
            <span className="text-xs text-muted-foreground/60 mt-1 inline-block">
              Click to expand...
            </span>
          )}
        </div>

        {/* Badges */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <SeverityBadge severity={comment.severity} />
          <CategoryBadge category={comment.category} />
          {comment.autoFixed && (
            <Badge variant="success" size="sm" className="gap-1">
              <Wrench className="w-3 h-3" aria-hidden="true" />
              <span>Fixed</span>
            </Badge>
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div
          id={commentId}
          className="px-3 pb-3 pt-0 space-y-3 border-t border-border/50"
          role="region"
          aria-label={`Details for comment on ${comment.filePath}`}
        >
          {/* Full body */}
          <div className="pl-7 pt-3">
            <p className="text-sm text-foreground whitespace-pre-wrap">{comment.body}</p>
          </div>

          {/* Suggested fix */}
          {comment.suggestedFix && (
            <div className="pl-7">
              <div className="rounded-md bg-muted/50 p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2">
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Suggested Fix</span>
                </div>
                <p className="text-sm text-foreground">{comment.suggestedFix}</p>
              </div>
            </div>
          )}

          {/* Suggested code */}
          {comment.suggestedCode && (
            <div className="pl-7">
              <div className="rounded-md bg-muted/80 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-muted border-b border-border/50">
                  <span className="text-xs font-medium text-muted-foreground">Suggested Code</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyCode}
                    className="h-6 px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={copied ? 'Code copied to clipboard' : 'Copy code to clipboard'}
                  >
                    {copied ? (
                      <>
                        <Check className="w-3 h-3 mr-1" aria-hidden="true" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3 mr-1" aria-hidden="true" />
                        <span>Copy</span>
                      </>
                    )}
                  </Button>
                </div>
                <pre className="p-3 overflow-x-auto text-xs font-mono text-foreground" tabIndex={0}>
                  <code>{comment.suggestedCode}</code>
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface StatsOverviewProps {
  review: CodeReviewResult;
}

function StatsOverview({ review }: StatsOverviewProps) {
  const { stats } = review;

  return (
    <div className="flex flex-wrap gap-2">
      {SEVERITY_ORDER.map((severity) => {
        const count = stats.bySeverity[severity] || 0;
        if (count === 0) return null;
        return <SeverityBadge key={severity} severity={severity} count={count} />;
      })}
      {stats.autoFixedCount > 0 && (
        <Badge variant="success" size="sm" className="gap-1">
          <Wrench className="w-3 h-3" />
          {stats.autoFixedCount} auto-fixed
        </Badge>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function CodeReviewDialog({
  open,
  onOpenChange,
  review,
  loading = false,
  error = null,
  onRetry,
}: CodeReviewDialogProps) {
  const [activeTab, setActiveTab] = useState<'severity' | 'file'>('severity');

  // Group comments by severity
  const commentsBySeverity = useMemo(() => {
    if (!review) return {};
    const grouped: Partial<Record<CodeReviewSeverity, CodeReviewComment[]>> = {};
    for (const comment of review.comments) {
      if (!grouped[comment.severity]) {
        grouped[comment.severity] = [];
      }
      grouped[comment.severity]!.push(comment);
    }
    return grouped;
  }, [review]);

  // Group comments by file
  const commentsByFile = useMemo(() => {
    if (!review) return {};
    const grouped: Record<string, CodeReviewComment[]> = {};
    for (const comment of review.comments) {
      if (!grouped[comment.filePath]) {
        grouped[comment.filePath] = [];
      }
      grouped[comment.filePath].push(comment);
    }
    // Sort comments within each file by line number
    Object.values(grouped).forEach((comments) => {
      comments.sort((a, b) => a.startLine - b.startLine);
    });
    return grouped;
  }, [review]);

  // Render loading state with improved skeleton and progress
  if (loading) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-w-3xl"
          data-testid="code-review-dialog"
          aria-busy="true"
          aria-describedby="loading-description"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileCode className="w-5 h-5 text-brand-500" aria-hidden="true" />
              Code Review
            </DialogTitle>
            <DialogDescription id="loading-description">
              Analyzing your code for best practices, security, and performance issues...
            </DialogDescription>
          </DialogHeader>

          {/* Loading skeleton with spinner and placeholders */}
          <div className="space-y-4 py-4">
            {/* Spinner and status */}
            <div className="flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div
                  className="animate-spin rounded-full h-10 w-10 border-3 border-primary border-t-transparent"
                  role="progressbar"
                  aria-label="Code review in progress"
                />
                <p className="text-sm text-muted-foreground font-medium">Running code review...</p>
              </div>
            </div>

            {/* Skeleton placeholders for expected content */}
            <div className="space-y-3 animate-pulse">
              {/* Verdict skeleton */}
              <div className="flex items-center justify-between">
                <div className="h-4 w-32 bg-muted rounded" />
                <div className="h-6 w-24 bg-muted rounded-full" />
              </div>

              {/* Summary skeleton */}
              <div className="space-y-2 py-3 border-y border-border/50">
                <div className="h-4 w-full bg-muted rounded" />
                <div className="h-4 w-3/4 bg-muted rounded" />
                <div className="flex gap-2 mt-2">
                  <div className="h-5 w-16 bg-muted rounded-full" />
                  <div className="h-5 w-16 bg-muted rounded-full" />
                  <div className="h-5 w-16 bg-muted rounded-full" />
                </div>
              </div>

              {/* Comments skeleton */}
              <div className="space-y-2">
                <div className="h-16 w-full bg-muted/50 rounded-lg" />
                <div className="h-16 w-full bg-muted/50 rounded-lg" />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              data-testid="code-review-loading-close"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Render error state with improved accessibility
  if (error) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-w-md"
          data-testid="code-review-dialog"
          role="alertdialog"
          aria-describedby="error-description"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="w-5 h-5" aria-hidden="true" />
              Review Failed
            </DialogTitle>
            <DialogDescription id="error-description">
              Something went wrong during the code review.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4" role="alert" aria-live="polite">
            <p className="text-sm text-destructive bg-destructive/10 rounded-md p-3 border border-destructive/20">
              {error}
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              data-testid="code-review-error-close"
            >
              Close
            </Button>
            {onRetry && (
              <Button
                onClick={onRetry}
                data-testid="code-review-retry"
                aria-label="Retry code review"
              >
                <RotateCcw className="w-4 h-4 mr-2" aria-hidden="true" />
                Retry
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Render empty state with helpful guidance
  if (!review) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md" data-testid="code-review-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileCode className="w-5 h-5 text-brand-500" aria-hidden="true" />
              Code Review
            </DialogTitle>
            <DialogDescription>No review results available yet.</DialogDescription>
          </DialogHeader>
          <div className="py-6 text-center">
            <Info className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              Start a code review to analyze your changes for best practices, security
              vulnerabilities, and performance issues.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              data-testid="code-review-empty-close"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl max-h-[85vh] flex flex-col overflow-hidden"
        data-testid="code-review-dialog"
        aria-describedby="review-summary"
      >
        {/* Header */}
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <DialogTitle className="flex items-center gap-2 text-lg">
                <FileCode className="w-5 h-5 text-brand-500" aria-hidden="true" />
                Code Review Results
              </DialogTitle>
              <DialogDescription className="mt-1">
                Reviewed {review.filesReviewed.length} file
                {review.filesReviewed.length !== 1 ? 's' : ''}
                {review.gitRef && (
                  <span
                    className="ml-1 font-mono text-xs"
                    aria-label={`Git reference: ${review.gitRef.slice(0, 7)}`}
                  >
                    ({review.gitRef.slice(0, 7)})
                  </span>
                )}
              </DialogDescription>
            </div>
            <VerdictBadge verdict={review.verdict} />
          </div>
        </DialogHeader>

        {/* Summary section */}
        <div className="flex-shrink-0 space-y-3 py-3 border-y border-border/50" id="review-summary">
          {/* Summary text */}
          <p className="text-sm text-foreground leading-relaxed">{review.summary}</p>

          {/* Stats and metadata */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <StatsOverview review={review} />

            {review.durationMs && (
              <div
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                aria-label={`Review completed in ${formatDuration(review.durationMs)}`}
              >
                <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{formatDuration(review.durationMs)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Comments section */}
        {review.comments.length > 0 ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as 'severity' | 'file')}
              className="flex-1 flex flex-col min-h-0"
            >
              <TabsList className="flex-shrink-0">
                <TabsTrigger value="severity">By Severity</TabsTrigger>
                <TabsTrigger value="file">By File</TabsTrigger>
              </TabsList>

              <TabsContent value="severity" className="flex-1 min-h-0 mt-3 overflow-hidden">
                <ScrollArea className="h-[350px]">
                  <Accordion
                    type="multiple"
                    defaultValue={['critical', 'high']}
                    className="space-y-2 pr-4"
                  >
                    {SEVERITY_ORDER.map((severity) => {
                      const comments = commentsBySeverity[severity];
                      if (!comments || comments.length === 0) return null;

                      const config = SEVERITY_CONFIG[severity];
                      const Icon = config.icon;

                      return (
                        <AccordionItem
                          key={severity}
                          value={severity}
                          className="border rounded-lg bg-card/30 overflow-hidden"
                        >
                          <AccordionTrigger className="px-4 py-3 hover:no-underline hover:bg-accent/30">
                            <div className="flex items-center gap-2">
                              <Icon
                                className={cn(
                                  'w-4 h-4',
                                  severity === 'critical' || severity === 'high'
                                    ? 'text-[var(--status-error)]'
                                    : severity === 'medium'
                                      ? 'text-[var(--status-warning)]'
                                      : 'text-[var(--status-info)]'
                                )}
                              />
                              <span className="font-medium">{config.label}</span>
                              <Badge variant="muted" size="sm">
                                {comments.length}
                              </Badge>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-4 pb-3">
                            <div className="space-y-2">
                              {comments.map((comment) => (
                                <CommentCard
                                  key={comment.id}
                                  comment={comment}
                                  defaultExpanded={severity === 'critical'}
                                />
                              ))}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                  </Accordion>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="file" className="flex-1 min-h-0 mt-3 overflow-hidden">
                <ScrollArea className="h-[350px]">
                  <Accordion type="multiple" className="space-y-2 pr-4">
                    {Object.entries(commentsByFile).map(([filePath, comments]) => {
                      // Determine the highest severity in this file
                      const highestSeverity = comments.reduce((highest, comment) => {
                        const currentIndex = SEVERITY_ORDER.indexOf(comment.severity);
                        const highestIndex = SEVERITY_ORDER.indexOf(highest);
                        return currentIndex < highestIndex ? comment.severity : highest;
                      }, 'info' as CodeReviewSeverity);

                      const severityConfig = SEVERITY_CONFIG[highestSeverity];
                      const Icon = severityConfig.icon;

                      return (
                        <AccordionItem
                          key={filePath}
                          value={filePath}
                          className="border rounded-lg bg-card/30 overflow-hidden"
                        >
                          <AccordionTrigger className="px-4 py-3 hover:no-underline hover:bg-accent/30">
                            <div className="flex items-center gap-2 min-w-0">
                              <FileCode className="w-4 h-4 text-brand-500 flex-shrink-0" />
                              <span className="font-mono text-sm truncate" title={filePath}>
                                {filePath}
                              </span>
                              <Badge
                                variant={severityConfig.variant}
                                size="sm"
                                className="flex-shrink-0"
                              >
                                <Icon className="w-3 h-3 mr-1" />
                                {comments.length}
                              </Badge>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-4 pb-3">
                            <div className="space-y-2">
                              {comments.map((comment) => (
                                <CommentCard key={comment.id} comment={comment} />
                              ))}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                  </Accordion>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <div
            className="flex-1 flex items-center justify-center py-8"
            role="status"
            aria-live="polite"
          >
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-[var(--status-success)]/10 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2
                  className="w-10 h-10 text-[var(--status-success)]"
                  aria-hidden="true"
                />
              </div>
              <h3 className="text-base font-semibold text-foreground mb-1">No issues found!</h3>
              <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                Your code looks great. The review found no issues, suggestions, or improvements
                needed.
              </p>
            </div>
          </div>
        )}

        {/* Footer */}
        <DialogFooter className="flex-shrink-0 border-t border-border/50 pt-4 mt-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="code-review-close"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
