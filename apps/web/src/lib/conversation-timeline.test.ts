import { describe, expect, it } from 'vitest';

import {
  appendAssistantDelta,
  formatTimelinePayload,
  updateApprovalState,
  upsertRuntimeTimelineItem,
  type TimelineItem
} from './conversation-timeline';

describe('conversation timeline', () => {
  it('appends assistant deltas into the active assistant item', () => {
    const items: TimelineItem[] = [
      { type: 'message', id: 'a1', role: 'assistant', content: 'Hel' }
    ];

    expect(appendAssistantDelta(items, 'a1', 'lo')).toEqual([
      { type: 'message', id: 'a1', role: 'assistant', content: 'Hello' }
    ]);
  });

  it('merges tool results into the matching tool call row', () => {
    const withCall = upsertRuntimeTimelineItem(
      [],
      {
        type: 'tool_call',
        toolCallId: 'tc1',
        toolName: 'read_file',
        toolArguments: { path: 'README.md' }
      },
      () => 'id1'
    );
    const withResult = upsertRuntimeTimelineItem(
      withCall,
      {
        type: 'tool_result',
        toolCallId: 'tc1',
        toolName: 'read_file',
        toolStatus: 'ok',
        toolOutput: 'done'
      },
      () => 'id2'
    );

    expect(withResult).toEqual([
      {
        type: 'tool',
        id: 'tool-tc1',
        toolCallId: 'tc1',
        name: 'read_file',
        status: 'completed',
        input: { path: 'README.md' },
        output: 'done'
      }
    ]);
  });

  it('tracks approval decisions in the visible conversation', () => {
    const items = upsertRuntimeTimelineItem(
      [],
      {
        type: 'approval_required',
        approvalId: 'ap1',
        toolCallId: 'tc1',
        message: 'run command'
      },
      () => 'id1'
    );

    expect(updateApprovalState(items, 'ap1', 'approved')).toEqual([
      {
        type: 'approval',
        id: 'approval-ap1',
        approvalId: 'ap1',
        toolCallId: 'tc1',
        reason: 'run command',
        state: 'approved'
      }
    ]);
  });

  it('adds saved plan artifacts to the visible timeline', () => {
    const items = upsertRuntimeTimelineItem(
      [],
      {
        type: 'plan_artifact',
        action: 'created',
        sessionId: 's1',
        plan: {
          id: 'plan_1',
          sessionId: 's1',
          title: 'Storage plan',
          summary: 'Persist it',
          steps: [
            {
              id: 'step_1',
              title: 'Add table',
              status: 'pending',
              details: null
            }
          ],
          status: 'active',
          sourceMessageId: 'msg_1',
          createdAt: '2026-05-27T00:00:00.000Z',
          updatedAt: '2026-05-27T00:00:00.000Z'
        }
      },
      () => 'id1'
    );

    expect(items).toEqual([
      {
        type: 'plan',
        id: 'plan-plan_1',
        action: 'created',
        title: 'Storage plan',
        summary: 'Persist it',
        stepCount: 1
      }
    ]);
  });

  it('adds backend errors to the visible runtime timeline', () => {
    const items = upsertRuntimeTimelineItem(
      [],
      {
        type: 'error',
        message: 'MoonBridge could not start',
        sessionId: 's1'
      },
      () => 'id1'
    );

    expect(items).toEqual([
      {
        type: 'error',
        id: 'error-id1',
        message: 'MoonBridge could not start'
      }
    ]);
  });

  it('formats structured payloads for compact timeline cards', () => {
    expect(formatTimelinePayload({ ok: true })).toBe('{\n  "ok": true\n}');
    expect(formatTimelinePayload('plain')).toBe('plain');
  });
});
