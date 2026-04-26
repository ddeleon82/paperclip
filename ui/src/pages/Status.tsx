import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock,
  HeartPulse,
  Play,
} from "lucide-react";
import { routinesApi } from "../api/routines";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { dashboardApi } from "../api/dashboard";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { groupBy } from "../lib/groupBy";
import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { MetricCard } from "../components/MetricCard";
import { AgentIcon } from "../components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import type { Agent, Approval, RoutineListItem, RoutineRunSummary } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimeWindow = "today" | "7d" | "30d";

type RoutineState = "success" | "awaiting_review" | "failed" | "overdue" | "paused" | "idle";

interface RoutineRowData {
  routine: RoutineListItem;
  state: RoutineState;
  lastRunAt: Date | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROUTINE_STATE_ORDER: Record<RoutineState, number> = {
  failed: 0,
  overdue: 1,
  awaiting_review: 2,
  success: 3,
  idle: 4,
  paused: 5,
};

const routineStateBadge: Record<RoutineState, string> = {
  success: statusBadge.done ?? statusBadgeDefault,
  awaiting_review: statusBadge.in_review ?? statusBadgeDefault,
  failed: statusBadge.failed ?? statusBadgeDefault,
  idle: statusBadgeDefault,
  paused: statusBadge.paused ?? statusBadgeDefault,
  overdue: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-400",
};

const routineStateDot: Record<RoutineState, string> = {
  success: "bg-green-400",
  awaiting_review: "bg-violet-400",
  failed: "bg-red-400",
  overdue: "bg-amber-400",
  paused: "bg-orange-400",
  idle: "bg-neutral-400",
};

const routineStateLabel: Record<RoutineState, string> = {
  success: "success",
  awaiting_review: "awaiting review",
  failed: "failed",
  idle: "idle",
  paused: "paused",
  overdue: "overdue",
};

function deriveRoutineState(routine: RoutineListItem): RoutineState {
  if (routine.status === "paused" || routine.status === "archived") return "paused";

  const lastRun = routine.lastRun;
  if (!lastRun) return "idle";

  if (lastRun.status === "failed" || lastRun.status === "error") return "failed";

  // Check active issue for in_review status
  if (routine.activeIssue?.status === "in_review") return "awaiting_review";

  // Check if overdue: has an enabled schedule trigger but nextRunAt is in the past
  const scheduleTrigger = routine.triggers.find(
    (t) => t.kind === "schedule" && t.enabled && t.nextRunAt,
  );
  if (scheduleTrigger?.nextRunAt) {
    const nextRun = new Date(scheduleTrigger.nextRunAt);
    // If next run was more than 30 minutes ago, consider overdue
    if (nextRun.getTime() < Date.now() - 30 * 60 * 1000) return "overdue";
  }

  if (lastRun.status === "succeeded" || lastRun.status === "completed") return "success";

  return "idle";
}

function relativeTime(date: Date | string | null): string {
  if (!date) return "Never run";
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

function absoluteTime(date: Date | string | null): string {
  if (!date) return "";
  return new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function humanCron(routine: RoutineListItem): string {
  const trigger = routine.triggers.find((t) => t.kind === "schedule" && t.enabled);
  if (!trigger) {
    const webhookTrigger = routine.triggers.find((t) => t.kind === "webhook" && t.enabled);
    if (webhookTrigger) return "Webhook";
    const apiTrigger = routine.triggers.find((t) => t.kind === "api" && t.enabled);
    if (apiTrigger) return "API";
    return "No trigger";
  }
  return trigger.label ?? "Scheduled";
}

function isRunInWindow(run: RoutineRunSummary, window: TimeWindow): boolean {
  if (!run.triggeredAt) return false;
  const triggeredAt = new Date(run.triggeredAt).getTime();
  const now = Date.now();
  switch (window) {
    case "today":
      return now - triggeredAt < 86_400_000;
    case "7d":
      return now - triggeredAt < 7 * 86_400_000;
    case "30d":
      return now - triggeredAt < 30 * 86_400_000;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-20" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border p-4">
            <Skeleton className="h-6 w-12" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-5 lg:col-span-3 space-y-4">
          {Array.from({ length: 2 }).map((_, group) => (
            <div key={group} className="space-y-1">
              <Skeleton className="h-5 w-40" />
              {Array.from({ length: 3 }).map((_, row) => (
                <Skeleton key={row} className="h-11 w-full" />
              ))}
            </div>
          ))}
        </div>
        <div className="col-span-5 lg:col-span-2 space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusEmptyState({ onCreateRoutine }: { onCreateRoutine: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Activity className="h-12 w-12 text-muted-foreground/40 mb-4" />
      <p className="text-sm font-medium text-foreground">No routines yet.</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-[300px]">
        Create a routine to start tracking agent work on a schedule.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onCreateRoutine}>
        Create routine
        <ChevronRight className="ml-1 h-3 w-3" />
      </Button>
    </div>
  );
}

function StatusErrorState({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <AlertTriangle className="h-12 w-12 text-destructive/60 mb-4" />
      <p className="text-sm font-medium text-foreground">Couldn't load status data.</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-[300px]">
        {error?.message ?? "This usually resolves on its own. If it persists, check the server logs."}
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function RoutineStatusPill({ state }: { state: RoutineState }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        routineStateBadge[state],
      )}
    >
      {routineStateLabel[state]}
    </span>
  );
}

function RoutineRow({
  data,
  onClick,
}: {
  data: RoutineRowData;
  onClick: () => void;
}) {
  const { routine, state, lastRunAt } = data;
  const isFailed = state === "failed";

  return (
    <div
      className={cn(
        "group flex items-center gap-3 h-11 px-3 cursor-pointer transition-colors hover:bg-accent/50",
        isFailed && "bg-red-50/50 dark:bg-red-950/20",
      )}
      onClick={onClick}
    >
      <span className={cn("h-2 w-2 rounded-full shrink-0", routineStateDot[state])} />

      <span className="text-sm text-foreground truncate flex-1 min-w-0">
        {routine.title}
      </span>

      <span className="text-xs text-muted-foreground font-mono hidden sm:block shrink-0">
        {humanCron(routine)}
      </span>

      <RoutineStatusPill state={state} />

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground font-mono shrink-0 min-w-[48px] text-right">
              {state === "overdue" && lastRunAt
                ? `overdue by ${relativeTime(lastRunAt).replace(" ago", "")}`
                : relativeTime(lastRunAt)}
            </span>
          </TooltipTrigger>
          {lastRunAt && (
            <TooltipContent>{absoluteTime(lastRunAt)}</TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>

      <Button
        variant="ghost"
        size="icon-sm"
        className="opacity-0 group-hover:opacity-100 shrink-0 hidden sm:flex"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function AgentGroupHeader({
  agentName,
  agentIcon,
  routineCount,
  attentionCount,
  isOpen,
  onToggle,
}: {
  agentName: string;
  agentIcon: string | null;
  routineCount: number;
  attentionCount: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <CollapsibleTrigger
      className="flex w-full items-center gap-2 py-2 px-3 hover:bg-accent/30 transition-colors"
      onClick={onToggle}
    >
      <ChevronRight
        className={cn(
          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
          isOpen && "rotate-90",
        )}
      />
      {agentIcon ? (
        <AgentIcon icon={agentIcon} className="h-4 w-4 shrink-0" />
      ) : (
        <div className="h-4 w-4 rounded-full bg-muted shrink-0" />
      )}
      <span className="text-sm font-semibold text-foreground">{agentName}</span>
      <span className="text-xs text-muted-foreground">
        ({routineCount} routine{routineCount !== 1 ? "s" : ""})
      </span>
      {attentionCount > 0 && (
        <span className="ml-auto text-xs font-medium text-amber-600 dark:text-amber-400">
          {attentionCount} need attention
        </span>
      )}
    </CollapsibleTrigger>
  );
}

function ApprovalCard({
  approval,
  agentById,
}: {
  approval: Approval;
  agentById: Map<string, Agent>;
}) {
  const navigate = useNavigate();
  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;

  const summary =
    (approval.payload as Record<string, unknown> | null)?.summary as string | undefined;
  const title =
    (approval.payload as Record<string, unknown> | null)?.title as string | undefined;
  const truncatedSummary = summary
    ? summary.length > 80
      ? `${summary.slice(0, 80)}...`
      : summary
    : null;

  return (
    <div className="border border-border bg-card rounded-md p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground truncate">
          {agent?.name ?? "Unknown agent"}
          {title ? ` — ${title}` : ""}
        </span>
      </div>
      {truncatedSummary && (
        <div className="border-l-2 border-muted pl-2">
          <p className="text-xs text-muted-foreground">{truncatedSummary}</p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-mono">
          {relativeTime(approval.createdAt as unknown as string)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => navigate(`/approvals/${approval.id}`)}
        >
          View
          <ChevronRight className="ml-1 h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function RunSparkline({ runs }: { runs: RoutineRunSummary[] }) {
  const last10 = runs.slice(0, 10).reverse();
  const squares = Array.from({ length: 10 }, (_, i) => last10[i] ?? null);

  const statusColor = (run: RoutineRunSummary | null): string => {
    if (!run) return "bg-muted";
    if (run.status === "succeeded" || run.status === "completed") return "bg-green-400";
    if (run.status === "failed" || run.status === "error") return "bg-red-400";
    if (run.linkedIssue?.status === "in_review") return "bg-violet-400";
    return "bg-muted";
  };

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1">
        {squares.map((run, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <span className={cn("h-3 w-3 rounded-sm shrink-0", statusColor(run))} />
            </TooltipTrigger>
            {run && (
              <TooltipContent>
                {new Date(run.triggeredAt).toLocaleDateString()} — {run.status}
              </TooltipContent>
            )}
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

function StatusDrawer({
  routine,
  agentById,
  onClose,
}: {
  routine: RoutineListItem | null;
  agentById: Map<string, Agent>;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  if (!routine) return null;

  const agent = routine.assigneeAgentId
    ? agentById.get(routine.assigneeAgentId)
    : null;
  const recentRuns = (routine as RoutineListItem & { recentRuns?: RoutineRunSummary[] }).recentRuns ?? [];
  const lastRun = routine.lastRun;
  const latestComment = lastRun?.linkedIssue;

  return (
    <Sheet open={!!routine} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-[400px] sm:max-w-[400px]">
        <SheetHeader>
          <SheetTitle className="text-sm">{routine.title}</SheetTitle>
          <SheetDescription>
            {agent?.name ?? "Unassigned"} · {humanCron(routine)}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Last 10 runs</p>
            <RunSparkline runs={recentRuns.length > 0 ? recentRuns : (lastRun ? [lastRun] : [])} />
          </div>

          {lastRun && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Latest run · {relativeTime(lastRun.triggeredAt)}
              </p>
              {latestComment && (
                <div className="bg-muted/50 rounded-md p-3">
                  <p className="text-xs text-muted-foreground">
                    {latestComment.title.length > 200
                      ? `${latestComment.title.slice(0, 200)}...`
                      : latestComment.title}
                  </p>
                  {latestComment.title.length > 200 && (
                    <button
                      className="text-xs text-primary mt-1 hover:underline"
                      onClick={() => navigate(`/issues/${latestComment.identifier ?? latestComment.id}`)}
                    >
                      View full
                      <ChevronRight className="inline h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => navigate(`/routines/${routine.id}`)}
            >
              View all runs
              <ChevronRight className="ml-1 h-3 w-3" />
            </Button>
            {lastRun?.linkedIssue && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => navigate(`/issues/${lastRun.linkedIssue!.identifier ?? lastRun.linkedIssue!.id}`)}
              >
                Open issue
                <ChevronRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Status() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [drawerRoutine, setDrawerRoutine] = useState<RoutineListItem | null>(null);
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(new Set());

  const window = (searchParams.get("window") as TimeWindow) || "today";
  const agentFilter = searchParams.get("agent") || "__all";

  useEffect(() => {
    setBreadcrumbs([{ label: "Status" }]);
  }, [setBreadcrumbs]);

  // Data fetching
  const {
    data: routines,
    isLoading: routinesLoading,
    error: routinesError,
    refetch: refetchRoutines,
  } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: pendingApprovals } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending_approval"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending_approval"),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: dashboardSummary } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  // Derived data
  const agentById = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a])),
    [agents],
  );

  const routineRows = useMemo<RoutineRowData[]>(() => {
    if (!routines) return [];
    let filtered = routines;

    // Agent filter
    if (agentFilter !== "__all") {
      filtered = filtered.filter((r) => r.assigneeAgentId === agentFilter);
    }

    return filtered.map((routine) => {
      const state = deriveRoutineState(routine);
      const lastRunAt = routine.lastRun?.triggeredAt
        ? new Date(routine.lastRun.triggeredAt)
        : null;
      return { routine, state, lastRunAt };
    });
  }, [routines, agentFilter]);

  // Group by agent
  const agentGroups = useMemo(() => {
    const groups = groupBy(routineRows, (r) => r.routine.assigneeAgentId ?? "__unassigned");
    return Object.entries(groups)
      .map(([agentId, rows]) => {
        const agent = agentId !== "__unassigned" ? agentById.get(agentId) : null;
        const sortedRows = [...rows].sort(
          (a, b) => ROUTINE_STATE_ORDER[a.state] - ROUTINE_STATE_ORDER[b.state],
        );
        const attentionCount = rows.filter(
          (r) => r.state === "failed" || r.state === "overdue" || r.state === "awaiting_review",
        ).length;
        return {
          agentId,
          agentName: agent?.name ?? "Unassigned",
          agentIcon: agent?.icon ?? null,
          rows: sortedRows,
          attentionCount,
        };
      })
      .sort((a, b) => {
        // Sort agents with attention items first
        if (a.attentionCount > 0 && b.attentionCount === 0) return -1;
        if (b.attentionCount > 0 && a.attentionCount === 0) return 1;
        return a.agentName.localeCompare(b.agentName);
      });
  }, [routineRows, agentById]);

  // KPI calculations
  const kpis = useMemo(() => {
    const allRows = routineRows;
    const runsToday = (routines ?? []).filter((r) => r.lastRun && isRunInWindow(r.lastRun, window)).length;
    const failedCount = allRows.filter((r) => r.state === "failed").length;
    const approvalCount = pendingApprovals?.length ?? 0;
    const totalAgents = dashboardSummary
      ? dashboardSummary.agents.active + dashboardSummary.agents.running + dashboardSummary.agents.paused + dashboardSummary.agents.error
      : agents?.filter((a) => a.status !== "terminated").length ?? 0;
    const healthyAgents = dashboardSummary
      ? dashboardSummary.agents.active + dashboardSummary.agents.running
      : agents?.filter((a) => a.status === "active" || a.status === "running").length ?? 0;

    return { runsToday, failedCount, approvalCount, healthyAgents, totalAgents };
  }, [routineRows, routines, pendingApprovals, dashboardSummary, agents, window]);

  // Auto-collapse fully-green agents when total > 5
  useEffect(() => {
    if (agentGroups.length > 5) {
      const toCollapse = agentGroups
        .filter((g) => g.attentionCount === 0)
        .map((g) => g.agentId);
      setCollapsedAgents(new Set(toCollapse));
    } else {
      setCollapsedAgents(new Set());
    }
  }, [agentGroups.length]);

  const toggleAgentCollapse = useCallback((agentId: string) => {
    setCollapsedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  const windowLabel = window === "today" ? "Runs today" : window === "7d" ? "Runs (7d)" : "Runs (30d)";

  // Loading / Error / Empty states
  if (!selectedCompanyId) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Activity className="h-12 w-12 text-muted-foreground/40 mb-4" />
        <p className="text-sm text-muted-foreground">Select a company to view status.</p>
      </div>
    );
  }

  if (routinesLoading) {
    return <StatusPageSkeleton />;
  }

  if (routinesError) {
    return (
      <StatusErrorState
        error={routinesError instanceof Error ? routinesError : null}
        onRetry={() => refetchRoutines()}
      />
    );
  }

  if (!routines || routines.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-lg font-semibold">Status</h1>
        <StatusEmptyState onCreateRoutine={() => navigate("/routines")} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold">Status</h1>
        <div className="flex items-center gap-2">
          {/* Window selector */}
          <div className="inline-flex items-center rounded-md border border-border bg-muted/30 p-0.5 text-xs">
            {(["today", "7d", "30d"] as const).map((w) => (
              <button
                key={w}
                className={cn(
                  "px-2.5 py-1 rounded-sm transition-colors",
                  window === w
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.set("window", w);
                  setSearchParams(next);
                }}
              >
                {w === "today" ? "Today" : w === "7d" ? "7d" : "30d"}
              </button>
            ))}
          </div>

          {/* Agent filter */}
          <Select
            value={agentFilter}
            onValueChange={(val) => {
              const next = new URLSearchParams(searchParams);
              if (val === "__all") next.delete("agent");
              else next.set("agent", val);
              setSearchParams(next);
            }}
          >
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All agents</SelectItem>
              {(agents ?? [])
                .filter((a) => a.status !== "terminated")
                .map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <div className="rounded-lg border border-border">
          <MetricCard
            icon={Play}
            value={kpis.runsToday}
            label={windowLabel}
          />
        </div>
        <div className="rounded-lg border border-border">
          <MetricCard
            icon={Clock}
            value={kpis.approvalCount}
            label="Pending approvals"
            description={
              kpis.approvalCount > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">{kpis.approvalCount} awaiting action</span>
              ) : undefined
            }
          />
        </div>
        <div className="rounded-lg border border-border">
          <MetricCard
            icon={AlertTriangle}
            value={kpis.failedCount}
            label="Failed runs"
            description={
              kpis.failedCount > 0 ? (
                <span className="text-red-600 dark:text-red-400">{kpis.failedCount} need attention</span>
              ) : undefined
            }
          />
        </div>
        <div className="rounded-lg border border-border">
          <MetricCard
            icon={HeartPulse}
            value={`${kpis.healthyAgents} / ${kpis.totalAgents}`}
            label="Healthy agents"
            description={
              kpis.healthyAgents < kpis.totalAgents ? (
                <span className="text-amber-600 dark:text-amber-400">
                  {kpis.totalAgents - kpis.healthyAgents} need attention
                </span>
              ) : kpis.totalAgents > 0 ? (
                <span className="text-green-600 dark:text-green-400">All healthy</span>
              ) : undefined
            }
          />
        </div>
      </div>

      {/* Main grid: Routines + Approvals */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Left: Routines by agent */}
        <div className="lg:col-span-3 space-y-1">
          {/* Mobile: pending approvals first */}
          <div className="lg:hidden space-y-3 mb-6">
            <PendingApprovalsSection approvals={pendingApprovals ?? []} agentById={agentById} />
          </div>

          {agentFilter !== "__all" && routineRows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No routines for this agent.</p>
          ) : (
            agentGroups.map((group) => {
              const isOpen = !collapsedAgents.has(group.agentId);
              return (
                <Collapsible key={group.agentId} open={isOpen}>
                  <AgentGroupHeader
                    agentName={group.agentName}
                    agentIcon={group.agentIcon}
                    routineCount={group.rows.length}
                    attentionCount={group.attentionCount}
                    isOpen={isOpen}
                    onToggle={() => toggleAgentCollapse(group.agentId)}
                  />
                  <CollapsibleContent>
                    {group.rows.map((row) => (
                      <RoutineRow
                        key={row.routine.id}
                        data={row}
                        onClick={() => setDrawerRoutine(row.routine)}
                      />
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              );
            })
          )}
        </div>

        {/* Right: Pending approvals (desktop only) */}
        <div className="hidden lg:block lg:col-span-2 space-y-3">
          <PendingApprovalsSection approvals={pendingApprovals ?? []} agentById={agentById} />
        </div>
      </div>

      {/* Drawer */}
      <StatusDrawer
        routine={drawerRoutine}
        agentById={agentById}
        onClose={() => setDrawerRoutine(null)}
      />
    </div>
  );
}

function PendingApprovalsSection({
  approvals,
  agentById,
}: {
  approvals: Approval[];
  agentById: Map<string, Agent>;
}) {
  if (approvals.length === 0) {
    return (
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground mb-2">
          Pending approvals
        </p>
        <p className="text-sm text-muted-foreground">No pending approvals</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground mb-2">
        Pending approvals ({approvals.length})
      </p>
      <div className="space-y-3">
        {approvals.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} agentById={agentById} />
        ))}
      </div>
    </div>
  );
}
