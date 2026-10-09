"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PanelLeftCloseIcon, PanelLeftOpenIcon, SparklesIcon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { ChromeIconButton } from "@/components/ChromeIconButton";
import { CHROME_ICON_BUTTON, CHROME_ICON_BUTTON_SIZE } from "@/components/chromeStyles";
import { cn } from "@/components/agent/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/agent/ui/tooltip";
import { DialogSearchField } from "@/components/ui/Dialog";
import { conversationLabel, type AgentConversation } from "@/lib/agent/client/history";
import { HARNESS_LABELS, readinessTone, type AgentReadiness } from "@/lib/agent/client/readiness";
import type { AgentHarnessId } from "@/lib/agent/types";
import { AGENT_ICON, AGENT_POPOVER_LAYER, StatusDot } from "./AgentChrome";
import { relativeTime } from "./AgentHistory";
import { describeReadiness } from "./AgentPanelHeader";
import { HarnessIcon } from "./HarnessIcon";

/** The sidebar's width open, and the icon rail's when collapsed. */
export const CHAT_SIDEBAR_WIDTH = 264;
export const CHAT_RAIL_WIDTH = 52;

/** Remembered per viewer: whether the chat view's sidebar is folded to its rail. */
export const CHAT_SIDEBAR_KEY = "node-banana-agent-chat-sidebar";

export function loadChatSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(CHAT_SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

export function saveChatSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(CHAT_SIDEBAR_KEY, collapsed ? "collapsed" : "open");
  } catch {
    // Storage blocked (private window, quota): the sidebar just won't be remembered.
  }
}

export interface ConversationGroup {
  label: "Today" | "Yesterday" | "Previous 7 days" | "Older";
  conversations: AgentConversation[];
}

/** Conversations by when they were last used, in local days; empty groups are left out, order kept. */
export function groupConversations(conversations: readonly AgentConversation[], now = Date.now()): ConversationGroup[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const groups: ConversationGroup[] = [
    { label: "Today", conversations: [] },
    { label: "Yesterday", conversations: [] },
    { label: "Previous 7 days", conversations: [] },
    { label: "Older", conversations: [] },
  ];
  for (const conversation of conversations) {
    const at = conversation.updatedAt;
    const index = at >= today.getTime() ? 0 : at >= yesterday.getTime() ? 1 : at >= weekAgo.getTime() ? 2 : 3;
    groups[index].conversations.push(conversation);
  }
  return groups.filter((group) => group.conversations.length > 0);
}

/** Matches the label (the agent's summary or the first message) and the workflow's name. */
export function filterConversations(conversations: readonly AgentConversation[], query: string): AgentConversation[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...conversations];
  return conversations.filter(
    (conversation) =>
      conversationLabel(conversation).toLowerCase().includes(needle) ||
      (conversation.workflowName?.toLowerCase().includes(needle) ?? false),
  );
}

export interface AgentChatSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  conversations: AgentConversation[];
  currentId: string;
  /** A turn is running: other conversations wait for it. */
  locked: boolean;
  /** The current chat has messages, so a new one would be different. */
  canStartNewChat: boolean;
  onNewChat: () => void;
  onOpen: (conversation: AgentConversation) => void;
  onDelete: (id: string) => void;
  harness: AgentHarnessId;
  /** No harness chosen yet (checking, the chooser): the marks read "Agent". */
  neutral: boolean;
  readiness: AgentReadiness;
  /** The harness can't run a turn until the user acts: the foot carries a dot. */
  attention: boolean;
  plan?: string;
  modelLabel?: string;
}

/**
 * The chat view's left rail: a new chat, a search over past conversations,
 * the conversations by day, and who answers at the foot. Folds to a 52px rail
 * of icons; the view remembers which.
 */
export const AgentChatSidebar = memo(function AgentChatSidebar(props: AgentChatSidebarProps) {
  const { onCollapsedChange } = props;
  // The pressed toggle goes away with its layout: the other layout's toggle takes the focus.
  const toggle = useCallback(
    (next: boolean) => {
      const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.hasAttribute(TOGGLE_ATTRIBUTE);
      onCollapsedChange(next);
      if (hadFocus) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[${TOGGLE_ATTRIBUTE}]`)?.focus());
    },
    [onCollapsedChange],
  );
  const inner = { ...props, onCollapsedChange: toggle };
  return props.collapsed ? <CollapsedRail {...inner} /> : <OpenSidebar {...inner} />;
});

/** Marks the open sidebar's collapse button and the rail's expand button. */
const TOGGLE_ATTRIBUTE = "data-sidebar-toggle";

/** How often the open sidebar's times and day groups are brought up to date. */
const CLOCK_TICK_MS = 60_000;

function OpenSidebar({
  onCollapsedChange,
  conversations,
  currentId,
  locked,
  canStartNewChat,
  onNewChat,
  onOpen,
  onDelete,
  harness,
  neutral,
  readiness,
  attention,
  plan,
  modelLabel,
}: AgentChatSidebarProps) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // The view can stay open for hours without a turn: "Just now" ages, and midnight moves the groups.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const visible = useMemo(() => filterConversations(conversations, query), [conversations, query]);
  const groups = useMemo(() => groupConversations(visible, now), [visible, now]);

  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    // Escape empties the search; it never leaves the view.
    if (event.key === "Escape" && query) {
      event.preventDefault();
      setQuery("");
    }
  };

  const remove = (conversation: AgentConversation) => {
    const label = conversationLabel(conversation);
    if (!window.confirm(`Delete “${label}”? This can't be undone.`)) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-conversation-row]") ?? []);
    const index = rows.findIndex((row) => row.dataset.conversationRow === conversation.id);
    onDelete(conversation.id);
    // The row and its delete button are gone: focus the row that takes its place, so keys stay in the view.
    requestAnimationFrame(() => {
      const next = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-conversation-row]") ?? []);
      (next[Math.min(index, next.length - 1)] ?? searchRef.current)?.focus({ preventScroll: true });
    });
  };

  return (
    <nav
      aria-label="Chats"
      className="flex min-h-0 shrink-0 flex-col border-r border-white/[0.06] bg-pane"
      style={{ width: CHAT_SIDEBAR_WIDTH }}
    >
      {/* The marks at the head and foot line up with the rows' text, 20px in. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 pl-5 pr-2.5">
        <SidebarMark harness={harness} neutral={neutral} />
        <h2 className="font-display text-[15px] font-semibold leading-5 tracking-[-0.01em] text-neutral-100">Chats</h2>
        <div className="ml-auto">
          <ChromeIconButton
            label="Collapse sidebar"
            onClick={() => onCollapsedChange(true)}
            size="md"
            tooltipPlacement="bottom"
            className="[&_svg]:size-4"
            data-sidebar-toggle=""
          >
            <PanelLeftCloseIcon {...AGENT_ICON} />
          </ChromeIconButton>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 px-2.5 pb-2">
        <button
          type="button"
          onClick={onNewChat}
          disabled={!canStartNewChat}
          title={canStartNewChat ? undefined : "This chat is already empty"}
          className={cn(
            "flex h-9 items-center gap-2.5 rounded-lg squircle px-2.5 text-left text-[13px] font-medium text-neutral-200",
            "transition-colors duration-[120ms] hover:bg-white/[0.05] hover:text-neutral-100",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
            "disabled:cursor-not-allowed disabled:text-neutral-500 disabled:hover:bg-transparent",
          )}
        >
          <SquarePenIcon className="size-4 shrink-0" {...AGENT_ICON} />
          New chat
        </button>
        <DialogSearchField
          ref={searchRef}
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKey}
        />
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2.5 pb-3">
        {conversations.length === 0 ? (
          <SidebarEmpty title="No chats yet">Your conversations with the agent show up here.</SidebarEmpty>
        ) : groups.length === 0 ? (
          <SidebarEmpty title="No matches">No chat or workflow matches “{query.trim()}”.</SidebarEmpty>
        ) : (
          groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="pt-3 first:pt-2">
              <p aria-hidden="true" className="px-2.5 pb-1 font-mono text-[10px] uppercase leading-[14px] tracking-eyebrow text-ink-3">
                {group.label}
              </p>
              <ul className="flex flex-col gap-px">
                {group.conversations.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    current={conversation.id === currentId}
                    locked={locked}
                    now={now}
                    onOpen={onOpen}
                    onDelete={remove}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      <SidebarFoot
        harness={harness}
        neutral={neutral}
        readiness={readiness}
        attention={attention}
        plan={plan}
        modelLabel={modelLabel}
      />
    </nav>
  );
}

function ConversationRow({
  conversation,
  current,
  locked,
  now,
  onOpen,
  onDelete,
}: {
  conversation: AgentConversation;
  current: boolean;
  locked: boolean;
  now: number;
  onOpen: (conversation: AgentConversation) => void;
  onDelete: (conversation: AgentConversation) => void;
}) {
  const label = conversationLabel(conversation);
  const meta = [conversation.workflowName, relativeTime(conversation.updatedAt, now)].filter(Boolean).join(" · ");
  const waits = locked && !current;
  return (
    <li className="group/row relative">
      <button
        type="button"
        data-conversation-row={conversation.id}
        aria-current={current || undefined}
        aria-disabled={waits || undefined}
        title={waits ? "Wait for the agent to finish" : undefined}
        onClick={() => {
          if (!waits) onOpen(conversation);
        }}
        className={cn(
          "flex w-full flex-col rounded-lg squircle py-1.5 pl-2.5 pr-9 text-left transition-colors duration-[120ms]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
          current ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent",
        )}
      >
        <span className={cn("truncate text-[13px] leading-5", current ? "text-neutral-100" : "text-neutral-300")}>{label}</span>
        <span className="truncate text-[11px] leading-4 text-ink-3">{meta}</span>
      </button>
      <button
        type="button"
        aria-label={`Delete “${label}”`}
        onClick={() => onDelete(conversation)}
        className={cn(
          "absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md squircle text-neutral-500 opacity-0",
          "transition-[opacity,background-color,color] duration-[120ms] hover:bg-white/10 hover:text-neutral-200",
          "group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
        )}
      >
        <Trash2Icon className="size-3.5" {...AGENT_ICON} />
      </button>
    </li>
  );
}

function SidebarEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-2.5 py-8 text-center">
      <p className="text-[13px] leading-5 text-neutral-300">{title}</p>
      <p className="mt-1 text-xs leading-4 text-ink-3">{children}</p>
    </div>
  );
}

function SidebarMark({ harness, neutral, className }: { harness: AgentHarnessId; neutral: boolean; className?: string }) {
  return neutral ? (
    <SparklesIcon className={cn("size-4 shrink-0 text-neutral-400", className)} {...AGENT_ICON} />
  ) : (
    <HarnessIcon harness={harness} className={className} />
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Who answers: the harness, its plan and model while it is ready, otherwise what it needs. */
function SidebarFoot({
  harness,
  neutral,
  readiness,
  attention,
  plan,
  modelLabel,
}: Pick<AgentChatSidebarProps, "harness" | "neutral" | "readiness" | "attention" | "plan" | "modelLabel">) {
  const name = neutral ? "Agent" : HARNESS_LABELS[harness];
  const detail = neutral
    ? "Choose Claude Code or Codex"
    : readiness.kind === "ready"
      ? [plan && capitalise(plan), modelLabel].filter(Boolean).join(" · ")
      : describeReadiness(readiness);
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-white/[0.06] py-3 pl-5 pr-4">
      <SidebarMark harness={harness} neutral={neutral} className="size-5" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-5 text-neutral-200">{name}</p>
        {detail && <p className="truncate text-[11px] leading-4 text-ink-3">{detail}</p>}
      </div>
      {attention && !neutral && <StatusDot tone={readinessTone(readiness)} />}
    </div>
  );
}

/** An icon button on the folded rail, its label to the right. */
function RailButton({
  label,
  onClick,
  disabled,
  toggle = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** The sidebar's own toggle. */
  toggle?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          data-sidebar-toggle={toggle ? "" : undefined}
          className={cn(CHROME_ICON_BUTTON, CHROME_ICON_BUTTON_SIZE.md, "[&_svg]:size-4")}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10} className={AGENT_POPOVER_LAYER}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function CollapsedRail({
  onCollapsedChange,
  canStartNewChat,
  onNewChat,
  harness,
  neutral,
  readiness,
  attention,
}: AgentChatSidebarProps) {
  const name = neutral ? "Agent" : HARNESS_LABELS[harness];
  const state = neutral ? undefined : readiness.kind === "ready" ? undefined : describeReadiness(readiness);
  return (
    <nav
      aria-label="Chats"
      className="flex min-h-0 shrink-0 flex-col items-center gap-1 border-r border-white/[0.06] bg-pane pb-3 pt-2.5"
      style={{ width: CHAT_RAIL_WIDTH }}
    >
      <RailButton label="Expand sidebar" onClick={() => onCollapsedChange(false)} toggle>
        <PanelLeftOpenIcon {...AGENT_ICON} />
      </RailButton>
      <RailButton label="New chat" onClick={onNewChat} disabled={!canStartNewChat}>
        <SquarePenIcon {...AGENT_ICON} />
      </RailButton>
      <div
        role="img"
        aria-label={state ? `${name}: ${state}` : name}
        title={state ? `${name} · ${state}` : name}
        className="relative mt-auto flex size-8 items-center justify-center"
      >
        <SidebarMark harness={harness} neutral={neutral} className="size-5" />
        {attention && !neutral && (
          <StatusDot tone={readinessTone(readiness)} className="absolute right-0.5 top-0.5 ring-2 ring-pane" />
        )}
      </div>
    </nav>
  );
}
