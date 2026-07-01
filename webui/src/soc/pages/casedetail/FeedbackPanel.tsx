/**
 * CaseDetail — Feedback panel (Coupling-D split).
 *
 * The AI-decision grading surface: assessment (agree/partial/disagree), quality star
 * ratings, actual outcome, time saved, an optional comment, and the prior gradings
 * list. This tab is intentionally scoped to grading the AI decision ONLY — ownership
 * (assignee + tags) and the discussion/notes thread live on the sibling Collaboration
 * tab (CollaborationThreadTab). There is NO duplication of that ownership+notes block.
 *
 * SECURITY (#9): analyst-authored comments render as plain text. #3: submitting
 * feedback via `api.caseFeedback` never changes the case verdict/status/disposition.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  Clock,
  Info,
  RefreshCw,
  Star,
  X,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { CaseFeedbackInput } from '@/lib/api';
import type { Case } from '@/lib/types';
import { DASH, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Alert, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import { Slider } from '@/ui/slider';
import { Separator } from '@/ui/separator';

import { type ScoreTone, TONE_BORDER, TONE_TEXT, PanelCard, SectionHeading, tsValue } from './shared';

const ASSESSMENTS: Array<{
  key: 'agree' | 'partial' | 'disagree';
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: ScoreTone;
}> = [
  { key: 'agree', label: 'Agree', icon: CheckCircle2, tone: 'low' },
  { key: 'partial', label: 'Partially', icon: Info, tone: 'medium' },
  { key: 'disagree', label: 'Disagree', icon: X, tone: 'critical' },
];

const OUTCOME_OPTIONS: Array<{ value: string; text: string }> = [
  { value: 'true_positive', text: 'True positive' },
  { value: 'false_positive', text: 'False positive' },
  { value: 'true_negative', text: 'True negative' },
  { value: 'false_negative', text: 'False negative' },
];

function assessmentMeta(key?: string) {
  return ASSESSMENTS.find((a) => a.key === key);
}

const StarRating: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
}> = ({ label, value, onChange }) => (
  <div className="flex items-center gap-3">
    <span className="flex-1 text-sm text-foreground">{label}</span>
    <div className="flex items-center">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${label}: ${n} of 5`}
          // ≥24x24 hit area (#4 — WCAG 2.5.8); the star glyph stays 16px, the button
          // box is 24px so each rating step is an easy pointer/keyboard target.
          className="inline-flex h-6 w-6 items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onChange(n === value ? 0 : n)}
        >
          <Star
            className={cn(
              'h-4 w-4',
              n <= value ? 'fill-warning text-warning' : 'text-muted-foreground',
            )}
            aria-hidden
          />
        </button>
      ))}
    </div>
    <span className="w-8 text-right text-xs text-muted-foreground">
      {value ? `${value}/5` : DASH}
    </span>
  </div>
);

function starsToScore(n: number): number | undefined {
  if (!n || n < 1) return undefined;
  return Math.max(0, Math.min(1, n / 5));
}

export const FeedbackTab: React.FC<{
  c: Case;
  onUpdated: (next: Case) => void;
}> = ({ c, onUpdated }) => {
  const caseId = c.case_id;

  /* ------------------------------------------------ AI-decision grading */
  const [assessment, setAssessment] = React.useState<'agree' | 'partial' | 'disagree'>('agree');
  const [accuracy, setAccuracy] = React.useState(0);
  const [reasoning, setReasoning] = React.useState(0);
  const [appropriateness, setAppropriateness] = React.useState(0);
  const [outcome, setOutcome] = React.useState('');
  const [timeSaved, setTimeSaved] = React.useState(0);
  const [fbAnalyst, setFbAnalyst] = React.useState('');
  const [fbComment, setFbComment] = React.useState('');
  const [submittingFb, setSubmittingFb] = React.useState(false);
  const [fbError, setFbError] = React.useState<unknown>(null);

  const submitFeedback = React.useCallback(async () => {
    setSubmittingFb(true);
    setFbError(null);
    try {
      const body: CaseFeedbackInput = { assessment };
      const a = starsToScore(accuracy);
      const r = starsToScore(reasoning);
      const ap = starsToScore(appropriateness);
      if (a !== undefined) body.accuracy = a;
      if (r !== undefined) body.reasoning_quality = r;
      if (ap !== undefined) body.action_appropriateness = ap;
      if (outcome) body.actual_outcome = outcome;
      if (timeSaved > 0) body.time_saved_minutes = timeSaved;
      if (fbAnalyst.trim()) body.analyst = fbAnalyst.trim();
      if (fbComment.trim()) body.comment = fbComment.trim();
      const next = await api.caseFeedback(caseId, body);
      onUpdated(next);
      setAccuracy(0);
      setReasoning(0);
      setAppropriateness(0);
      setOutcome('');
      setTimeSaved(0);
      setFbComment('');
    } catch (e) {
      setFbError(e);
    } finally {
      setSubmittingFb(false);
    }
  }, [
    assessment,
    accuracy,
    reasoning,
    appropriateness,
    outcome,
    timeSaved,
    fbAnalyst,
    fbComment,
    caseId,
    onUpdated,
  ]);

  const priorFeedback = React.useMemo(
    () => [...(c.feedback || [])].sort((x, y) => tsValue(y.ts) - tsValue(x.ts)),
    [c.feedback],
  );

  // NOTE: ownership (assignee + tags) and the discussion/notes thread live on the
  // sibling Collaboration tab (CollaborationThreadTab). This Feedback tab is
  // intentionally scoped to grading the AI decision ONLY — no duplication.

  const gradingDirty =
    accuracy > 0 ||
    reasoning > 0 ||
    appropriateness > 0 ||
    !!outcome ||
    timeSaved > 0 ||
    !!fbComment.trim();

  return (
    <div className="space-y-7 p-6">
      {/* ------------------------------------------- AI-decision feedback */}
      <PanelCard>
        <SectionHeading
          icon={Brain}
          tone="medium"
          actions={
            priorFeedback.length ? (
              <Badge variant="medium">
                {priorFeedback.length} grading{priorFeedback.length === 1 ? '' : 's'}
              </Badge>
            ) : undefined
          }
        >
          Rate the AI decision
        </SectionHeading>
        <p className="mb-4 text-xs text-muted-foreground">
          Calibrate the agent: do you agree with the verdict, and how good were the reasoning
          and recommended action?
        </p>

        <div className="grid grid-cols-3 gap-2">
          {ASSESSMENTS.map((a) => {
            const Icon = a.icon;
            const active = assessment === a.key;
            return (
              <button
                key={a.key}
                type="button"
                aria-pressed={active}
                onClick={() => setAssessment(a.key)}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-ring',
                  active
                    ? TONE_BORDER[a.tone] + ' ' + TONE_TEXT[a.tone]
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                <Icon className="h-4 w-4" />
                {a.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 rounded-md border border-border bg-muted/30 p-4">
          <div className="mb-3 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Quality (optional)
          </div>
          <div className="space-y-2">
            <StarRating label="Accuracy" value={accuracy} onChange={setAccuracy} />
            <StarRating label="Reasoning quality" value={reasoning} onChange={setReasoning} />
            <StarRating
              label="Action appropriateness"
              value={appropriateness}
              onChange={setAppropriateness}
            />
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Actual outcome</Label>
            <Select
              value={outcome || '__unknown__'}
              onValueChange={(v) => setOutcome(v === '__unknown__' ? '' : v)}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Unknown" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unknown__">Unknown</SelectItem>
                {OUTCOME_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Analyst id (optional)</Label>
            <Input
              placeholder="e.g. jdoe"
              value={fbAnalyst}
              onChange={(e) => setFbAnalyst(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 space-y-1.5">
          <Label className="text-xs">Analyst time saved: {timeSaved} min</Label>
          <Slider
            min={0}
            max={120}
            step={5}
            value={[timeSaved]}
            onValueChange={(v) => setTimeSaved(v[0] ?? 0)}
          />
        </div>

        <div className="mt-4 space-y-1.5">
          <Label className="text-xs">Comment (optional)</Label>
          <Textarea
            rows={2}
            placeholder="Anything the agent missed or got right?"
            value={fbComment}
            onChange={(e) => setFbComment(e.target.value)}
          />
        </div>

        {fbError ? (
          <Alert variant="destructive" className="mt-4">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not submit feedback</AlertTitle>
          </Alert>
        ) : null}

        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            disabled={submittingFb || !gradingDirty}
            onClick={() => void submitFeedback()}
          >
            {submittingFb ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Submit grading
          </Button>
        </div>

        {priorFeedback.length ? (
          <>
            <Separator className="my-4" />
            <div className="mb-3 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
              Previous gradings
            </div>
            <div className="space-y-2">
              {priorFeedback.map((f, i) => {
                const meta = assessmentMeta(f.assessment);
                const Icon = meta?.icon;
                return (
                  <div key={i} className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={meta ? (meta.tone === 'low' ? 'success' : meta.tone) : 'outline'} className="gap-1">
                        {Icon ? <Icon className="h-3 w-3" /> : null}
                        {meta?.label || humanizeToken(f.assessment) || 'Graded'}
                      </Badge>
                      {f.actual_outcome ? (
                        <Badge variant="outline">{humanizeToken(f.actual_outcome)}</Badge>
                      ) : null}
                      {typeof f.time_saved_minutes === 'number' && f.time_saved_minutes > 0 ? (
                        <Badge variant="outline" className="gap-1">
                          <Clock className="h-3 w-3" />
                          {f.time_saved_minutes} min saved
                        </Badge>
                      ) : null}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {f.analyst ? `${f.analyst} · ` : ''}
                        {f.ts ? humanizeAge(f.ts) : DASH}
                      </span>
                    </div>
                    {f.comment ? (
                      /* UNTRUSTED — plain text. */
                      <p className="mt-2 whitespace-pre-wrap text-xs text-foreground/90">
                        {f.comment}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </PanelCard>
    </div>
  );
};

export default FeedbackTab;
