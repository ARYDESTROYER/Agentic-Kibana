/**
 * Co-located typed client for the Round-3 CASE-DETAIL surfaces (Group 5).
 *
 * These wrap the new READ + COLLABORATION endpoints the CaseDetail page consumes,
 * built on the low-level `request`-style verbs re-exported by the shared
 * `@/lib/api`. Kept HERE (not in the shared api.ts) so concurrent builders don't
 * contend on one file.
 *
 * SECURITY (#9): every field returned by these endpoints — a chip `inputs` value, a
 * span `summary`/`payload_ref`, a thread `body`/`mentions`/`reactions`, a task
 * `title`/`logs`, an activity `summary` — is operator-/AI-/log-derived UNTRUSTED
 * data. The TYPES below carry it as plain `string`/`unknown`; the COMPONENTS render
 * it as plain text or inside an escaped <CodeBlock>. Nothing here is ever placed in
 * an href/src or `dangerouslySetInnerHTML`.
 *
 * #3: the triage chips + the timeline `decision` span are PURE READ projections —
 * they never feed `case_manager.decide()`. The thread/tasks endpoints never set a
 * case's status/verdict/disposition (the backend enforces this).
 */
import { api } from '@/lib/api';

/* ------------------------------------------------------------- triage chips -- */

/** Advisory band ladder used by every chip (matches the backend `priority` module). */
export type TriageBand = 'high' | 'medium' | 'low';

/** The deterministic 0-100 risk chip (passed through from the case, never recomputed). */
export interface RiskChip {
  value: number;
  band: TriageBand | string;
  breakdown: Record<string, number | undefined>;
  inputs: { definition?: string } & Record<string, unknown>;
}

/** SOURCE-asserted severity chip (NOT risk). `source` flags asserted vs derived. */
export interface SeverityChip {
  band: TriageBand | string;
  value: number;
  raw: number | null;
  source: 'source_asserted' | 'derived' | string;
  inputs: { definition?: string; severity_max?: number | null; severity_min?: number | null } & Record<
    string,
    unknown
  >;
}

/** Asset-criticality impact chip. */
export interface ImpactChip {
  band: TriageBand | string;
  value: number;
  criticality: number;
  entity: string;
  inputs: { definition?: string; entity_type?: string; entity_value?: string } & Record<string, unknown>;
}

/** ITIL Impact×Urgency priority chip (P1..P4). `urgency` is the nested urgency band. */
export interface PriorityChip {
  level: string | null;
  impact: TriageBand | string;
  matched: boolean;
  default: string;
  urgency: { band: TriageBand | string; value: number; escalated: boolean };
  inputs: {
    definition?: string;
    impact_band?: string;
    urgency_band?: string;
    matrix_enabled?: boolean;
  } & Record<string, unknown>;
}

export interface TriageChips {
  risk: RiskChip;
  severity: SeverityChip;
  impact: ImpactChip;
  priority: PriorityChip;
}

export interface TriageResponse {
  case_id: string;
  found: boolean;
  chips: TriageChips;
}

/** GET /api/cases/{id}/triage — the four honest advisory chips. */
export function getTriage(caseId: string): Promise<TriageResponse> {
  return api.get<TriageResponse>(`cases/${encodeURIComponent(caseId)}/triage`);
}

/* --------------------------------------------------------------- timeline -- */

export type TraceSpanKind = 'invoke_agent' | 'chat' | 'execute_tool' | 'decision' | string;

/** One typed ReAct span (mirrors backend `TraceSpan`). `trusted=false` ⇒ payload is
 *  UNTRUSTED log/tool data → render the summary in an escaped CodeBlock (#9). */
export interface TraceSpan {
  id?: string;
  case_id?: string;
  step_index: number;
  kind: TraceSpanKind;
  name: string;
  ts: string;
  latency_ms: number | null;
  cost: number | null;
  tokens: number | null;
  trusted: boolean;
  summary: string;
  payload_ref: Record<string, unknown>;
}

export interface TimelineResponse {
  case_id: string;
  spans: TraceSpan[];
  total: number;
  totals: { cost: number; tokens: number };
}

/** The exact decision clause carried on a terminal `decision` span's payload_ref. */
export interface DecisionPayload {
  deterministic?: boolean;
  verdict?: string | null;
  confidence?: number;
  risk_score?: number;
  decision_status?: string;
  decision_by?: string;
  escalate?: boolean;
  objection_window_expires_at?: string | null;
  policy_clause?: {
    verdict_class?: string | null;
    auto_closable?: boolean;
    enabled?: boolean;
    min_confidence?: number;
    max_risk_score?: number | null;
    objection_window_minutes?: number;
    note?: string;
  };
}

/** GET /api/cases/{id}/timeline — the typed span timeline + a terminal decision span. */
export function getTimeline(caseId: string): Promise<TimelineResponse> {
  return api.get<TimelineResponse>(`cases/${encodeURIComponent(caseId)}/timeline`);
}

/* ----------------------------------------------------------------- thread -- */

export type AuthorType = 'human' | 'ai' | 'system';

export interface Reaction {
  emoji: string;
  user: string;
}

/** One thread message (mirrors backend `CaseMessage` + the `deleted` projection flag). */
export interface CaseMessage {
  id: string;
  case_id: string;
  parent_id: string | null;
  author_type: AuthorType | string;
  author: string;
  body: string;
  mentions: string[];
  reactions: Array<{ emoji?: string; user?: string } & Record<string, unknown>>;
  kind: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted?: boolean;
  ai_meta: Record<string, unknown> | null;
}

export interface ThreadResponse {
  case_id: string;
  messages: CaseMessage[];
  count: number;
}

export function getThread(caseId: string, includeDeleted = true): Promise<ThreadResponse> {
  return api.get<ThreadResponse>(`cases/${encodeURIComponent(caseId)}/thread`, {
    include_deleted: includeDeleted,
  });
}

export interface PostThreadInput {
  body: string;
  parent_id?: string | null;
  author_type?: AuthorType;
  kind?: string;
  mentions?: string[];
}

export function postThread(caseId: string, input: PostThreadInput): Promise<CaseMessage> {
  return api.post<CaseMessage>(`cases/${encodeURIComponent(caseId)}/thread`, input);
}

export function editThreadMessage(
  caseId: string,
  msgId: string,
  body: string,
): Promise<CaseMessage> {
  // The backend registers this as PATCH-only (routes_cases_collab.py); a PUT here 405s.
  return api.patch<CaseMessage>(
    `cases/${encodeURIComponent(caseId)}/thread/${encodeURIComponent(msgId)}`,
    { body },
  );
}

export function deleteThreadMessage(caseId: string, msgId: string): Promise<CaseMessage> {
  return api.del<CaseMessage>(
    `cases/${encodeURIComponent(caseId)}/thread/${encodeURIComponent(msgId)}`,
  );
}

export function reactThreadMessage(
  caseId: string,
  msgId: string,
  emoji: string,
  remove = false,
): Promise<CaseMessage> {
  return api.post<CaseMessage>(
    `cases/${encodeURIComponent(caseId)}/thread/${encodeURIComponent(msgId)}/reactions`,
    { emoji, remove },
  );
}

/* ------------------------------------------------------------------ tasks -- */

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'blocked' | string;

export interface CaseTask {
  id: string;
  case_id: string;
  title: string;
  assignee: string | null;
  status: TaskStatus;
  order: number;
  created_at: string;
  logs: Array<{ ts?: string; by?: string; note?: string } & Record<string, unknown>>;
}

export interface TasksResponse {
  case_id: string;
  tasks: CaseTask[];
  count: number;
}

export function getTasks(caseId: string): Promise<TasksResponse> {
  return api.get<TasksResponse>(`cases/${encodeURIComponent(caseId)}/tasks`);
}

export interface AddTaskInput {
  title: string;
  assignee?: string | null;
  status?: TaskStatus;
}

export function addTask(caseId: string, input: AddTaskInput): Promise<CaseTask> {
  return api.post<CaseTask>(`cases/${encodeURIComponent(caseId)}/tasks`, input);
}

export interface PatchTaskInput {
  title?: string;
  assignee?: string | null;
  status?: TaskStatus;
  order?: number;
}

export function patchTask(caseId: string, tid: string, patch: PatchTaskInput): Promise<CaseTask> {
  // The backend registers this as PATCH-only (routes_cases_collab.py); a PUT here 405s.
  return api.patch<CaseTask>(
    `cases/${encodeURIComponent(caseId)}/tasks/${encodeURIComponent(tid)}`,
    patch,
  );
}

export function logTask(caseId: string, tid: string, note: string): Promise<CaseTask> {
  return api.post<CaseTask>(
    `cases/${encodeURIComponent(caseId)}/tasks/${encodeURIComponent(tid)}/log`,
    { note },
  );
}

/* --------------------------------------------------------------- activity -- */

export interface CaseActivityItem {
  source: 'audit' | 'activity' | string;
  ts: string;
  kind: string;
  actor: string;
  summary: string;
  ref?: Record<string, unknown>;
  id?: string;
  case_id?: string;
}

export interface ActivityResponse {
  case_id: string;
  activity: CaseActivityItem[];
  count: number;
}

export function getActivity(caseId: string, limit = 200): Promise<ActivityResponse> {
  return api.get<ActivityResponse>(`cases/${encodeURIComponent(caseId)}/activity`, { limit });
}

/* ----------------------------------------------------------- user picker -- */

/** A minimal user shape for the assignee picker + @mention autocomplete (plain data). */
export interface PickableUser {
  username: string;
  role?: string;
  active?: boolean;
  display_name?: string;
}

/** Best-effort users list for the picker / mention autocomplete. Returns [] when the
 *  user store is unavailable or auth is off (the no-auth profile has no users) so the
 *  caller degrades to a free-text assignee + un-suggested @mentions. */
export async function listPickableUsers(): Promise<PickableUser[]> {
  try {
    const res = await api.users.list();
    const users = (res?.users ?? []) as unknown as Array<Record<string, unknown>>;
    return users
      .map((u) => ({
        username: String(u.username ?? ''),
        role: typeof u.role === 'string' ? u.role : undefined,
        active: typeof u.active === 'boolean' ? u.active : undefined,
        display_name:
          typeof u.display_name === 'string'
            ? u.display_name
            : typeof (u.profile as Record<string, unknown> | undefined)?.display_name === 'string'
              ? String((u.profile as Record<string, unknown>).display_name)
              : undefined,
      }))
      .filter((u) => u.username);
  } catch {
    return [];
  }
}
