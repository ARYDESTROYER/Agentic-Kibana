/**
 * CaseDetail — the lifecycle confirm-action dialog (Coupling-D split).
 *
 * ONE dialog drives EVERY lifecycle action (close / escalate / resolve / hold / …).
 * The dialog is polymorphic on the pending `ActionDef.fields`: it renders only the
 * structured inputs that action declares (disposition / resolution / tags / assignee
 * / priority / reason) plus an always-present analyst note. It is fully CONTROLLED —
 * the orchestrator owns the field state + the submit handler.
 *
 * #3 CONTRACT: this dialog NEVER posts an action itself. It calls `onSubmit`, and the
 * orchestrator's `runAction` POSTs the EXISTING backend verb (`pending.wireAction ??
 * pending.key`) — so `close_disposition` maps to `close` and the server still runs the
 * real `decide()`/`apply()`. The unified Close-with-disposition submit is disabled
 * until a disposition is chosen (mandatory).
 *
 * SECURITY (#9): resolution/priority/disposition options are static enums; the free
 * text (assignee / reason / note / tags) is stored, never rendered as markup here.
 */
import * as React from 'react';
import { RefreshCw } from 'lucide-react';

import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';

import {
  type ActionDef,
  DISPOSITION_OPTIONS,
  PRIORITY_OPTIONS,
  RESOLUTION_OPTIONS,
  TagInput,
} from './shared';

export interface ConfirmActionDialogProps {
  /** The pending action, or null when the dialog is closed. */
  pending: ActionDef | null;
  /** True while the action POST is in flight (disables controls + shows a spinner). */
  acting: boolean;
  /** Close the dialog (only allowed while not `acting`). */
  onClose: () => void;
  /** Run the action — the orchestrator's `runAction` (posts the wire verb, #3). */
  onSubmit: () => void;

  // Controlled field values + setters (owned by the orchestrator).
  note: string;
  onNoteChange: (v: string) => void;
  resolution: string;
  onResolutionChange: (v: string) => void;
  priority: string;
  onPriorityChange: (v: string) => void;
  assignee: string;
  onAssigneeChange: (v: string) => void;
  tags: string[];
  onTagsChange: (v: string[]) => void;
  tagDraft: string;
  onTagDraftChange: (v: string) => void;
  disposition: string;
  onDispositionChange: (v: string) => void;
  reason: string;
  onReasonChange: (v: string) => void;
}

export const ConfirmActionDialog: React.FC<ConfirmActionDialogProps> = ({
  pending,
  acting,
  onClose,
  onSubmit,
  note,
  onNoteChange,
  resolution,
  onResolutionChange,
  priority,
  onPriorityChange,
  assignee,
  onAssigneeChange,
  tags,
  onTagsChange,
  tagDraft,
  onTagDraftChange,
  disposition,
  onDispositionChange,
  reason,
  onReasonChange,
}) => (
  <Dialog
    open={pending !== null}
    onOpenChange={(o) => {
      if (!o && !acting) onClose();
    }}
  >
    {pending ? (
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <pending.icon className="h-5 w-5" />
            {pending.confirmTitle}
          </DialogTitle>
          <DialogDescription>{pending.confirmBody}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Disposition first: it's the REQUIRED outcome for the unified close
              flow, and the primary Close button is disabled until one is picked. */}
          {pending.fields.includes('disposition') ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Disposition (required)</Label>
              <Select value={disposition} onValueChange={onDispositionChange}>
                <SelectTrigger className="h-9" aria-label="Disposition (required)">
                  <SelectValue placeholder="Select an outcome…" />
                </SelectTrigger>
                <SelectContent>
                  {DISPOSITION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.text}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {pending.fields.includes('resolution') ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Resolution (optional)</Label>
              <Select
                value={resolution || '__none__'}
                onValueChange={(v) => onResolutionChange(v === '__none__' ? '' : v)}
              >
                <SelectTrigger className="h-9" aria-label="Resolution (optional)">
                  <SelectValue placeholder="— No resolution —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— No resolution —</SelectItem>
                  {RESOLUTION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.text}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {pending.fields.includes('tags') ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Tags (optional)</Label>
              <TagInput
                tags={tags}
                draft={tagDraft}
                onDraftChange={onTagDraftChange}
                onTagsChange={onTagsChange}
              />
            </div>
          ) : null}

          {pending.fields.includes('assignee') ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Assign to (optional)</Label>
              <Input
                placeholder="e.g. tier-2 or jdoe"
                value={assignee}
                onChange={(e) => onAssigneeChange(e.target.value)}
              />
            </div>
          ) : null}

          {pending.fields.includes('priority') ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Priority (optional)</Label>
              <Select
                value={priority || '__none__'}
                onValueChange={(v) => onPriorityChange(v === '__none__' ? '' : v)}
              >
                <SelectTrigger className="h-9" aria-label="Priority (optional)">
                  <SelectValue placeholder="— No priority —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— No priority —</SelectItem>
                  {PRIORITY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.text}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {pending.fields.includes('reason') ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Reason (optional)</Label>
              <Input
                placeholder="Why — e.g. awaiting vendor reply, confirmed benign…"
                value={reason}
                onChange={(e) => onReasonChange(e.target.value)}
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label className="text-xs">Analyst note (optional)</Label>
            <Textarea
              rows={3}
              placeholder="Add context for the next analyst…"
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={acting}>
            Cancel
          </Button>
          <Button
            variant={pending.variant === 'outline' ? 'default' : pending.variant}
            onClick={onSubmit}
            disabled={acting || (pending.fields.includes('disposition') && !disposition)}
          >
            {acting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <pending.icon className="h-4 w-4" />}
            {pending.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    ) : null}
  </Dialog>
);

export default ConfirmActionDialog;
