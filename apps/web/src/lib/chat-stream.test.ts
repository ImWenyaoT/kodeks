import { describe, expect, it } from 'vitest';

import { collectChatStream, parseSseFrames } from './chat-stream';

describe('parseSseFrames', () => {
  it('parses text deltas and completion ids from runtime SSE frames', () => {
    const frames = [
      'event: text_delta\ndata: {"type":"text_delta","delta":"Hel","session_id":"s1"}\n\n',
      'event: text_delta\ndata: {"type":"text_delta","delta":"lo","session_id":"s1"}\n\n',
      'event: response_completed\ndata: {"type":"response_completed","response_id":"resp_1","session_id":"s1"}\n\n'
    ];

    expect(parseSseFrames(frames.join(''))).toEqual([
      { type: 'text_delta', delta: 'Hel', sessionId: 's1' },
      { type: 'text_delta', delta: 'lo', sessionId: 's1' },
      { type: 'response_completed', responseId: 'resp_1', sessionId: 's1' }
    ]);
  });

  it('parses approval and memory events from TS runtime frames', () => {
    const frames = [
      'event: memory_recalled\ndata: {"type":"memory_recalled","memory_ids":["mem_1"],"session_id":"s1"}\n\n',
      'event: approval_required\ndata: {"type":"approval_required","approval_id":"appr_1","message":"danger","session_id":"s1"}\n\n'
    ];

    expect(parseSseFrames(frames.join(''))).toEqual([
      { type: 'memory_recalled', memoryIds: ['mem_1'], sessionId: 's1' },
      {
        type: 'approval_required',
        approvalId: 'appr_1',
        message: 'danger',
        sessionId: 's1'
      }
    ]);
  });

  it('parses persisted plan artifact events', () => {
    const frame =
      'event: plan_artifact\ndata: {"type":"plan_artifact","action":"created","session_id":"s1","plan":{"id":"plan_1","sessionId":"s1","title":"Storage plan","summary":"Persist it","steps":[{"id":"step_1","title":"Add table","status":"pending","details":null}],"status":"active","sourceMessageId":"msg_1","createdAt":"2026-05-27T00:00:00.000Z","updatedAt":"2026-05-27T00:00:00.000Z"}}\n\n';

    expect(parseSseFrames(frame)).toEqual([
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
      }
    ]);
  });

  it('parses runtime-created sessions and folded SSE data lines', () => {
    const frames = [
      'event: session_created\ndata: {"type":"session_created",\ndata: "session_id":"sess_1"}\n\n'
    ];

    expect(parseSseFrames(frames.join(''))).toEqual([
      { type: 'session_created', sessionId: 'sess_1' }
    ]);
  });

  it('parses assistant status without treating it as answer text', async () => {
    const frames = [
      'event: assistant_status\ndata: {"type":"assistant_status","message":"正在读取文件","session_id":"s1"}\n\n',
      'event: text_delta\ndata: {"type":"text_delta","delta":"完成","session_id":"s1"}\n\n'
    ];
    const events: unknown[] = [];
    const deltas: string[] = [];

    await collectChatStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames.join('')));
          controller.close();
        }
      }),
      {
        onDelta(delta) {
          deltas.push(delta);
        },
        onEvent(event) {
          events.push(event);
        }
      }
    );

    expect(events).toEqual([
      { type: 'assistant_status', message: '正在读取文件', sessionId: 's1' },
      { type: 'text_delta', delta: '完成', sessionId: 's1' }
    ]);
    expect(deltas).toEqual(['完成']);
  });
});

describe('collectChatStream', () => {
  it('streams decoded assistant text in arrival order', async () => {
    const chunks = [
      'event: text_delta\ndata: {"type":"text_delta","delta":"A","session_id":"s1"}\n\n',
      'event: text_delta\ndata: {"type":"text_delta","delta":"B","session_id":"s1"}\n\n'
    ];
    const received: string[] = [];

    await collectChatStream(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        }
      }),
      {
        onDelta(delta) {
          received.push(delta);
        }
      }
    );

    expect(received).toEqual(['A', 'B']);
  });
});
