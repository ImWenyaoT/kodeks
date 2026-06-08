// frontend/lib/server/wire/events.test.ts
// 用 Python 录制的黄金 fixtures 反向验证 TS 线缝层的保真度：
//  1) 每个录制的 runtime 事件都符合 rawEventSchema（类型覆盖真实输出）。
//  2) encodeSseFrame 重编码后与 Python runtime.sse 字节完全相等（含中文 \uXXXX 转义、紧凑 JSON、帧格式）。
//  3) toUiTransportPayload + encodeSseFrame 与 Python ui.sse 字节完全相等（验证 UI 映射移植 + 丢弃语义）。
//  4) 每个 UI payload 都符合 uiEventSchema。
import { describe, expect, it } from 'vitest'
import { encodeSseFrame, rawEventSchema, toUiTransportPayload, uiEventSchema } from './events'
import { loadManifest, loadScenario } from '../oracle'

const manifest = loadManifest()

describe('oracle 黄金 fixtures：线缝事件契约保真', () => {
  for (const summary of manifest.scenarios) {
    const scenario = loadScenario(summary.id)

    describe(scenario.id, () => {
      it('每个 runtime 事件都符合 rawEventSchema', () => {
        for (const event of scenario.runtimeEvents) {
          const result = rawEventSchema.safeParse(event)
          expect(
            result.success,
            `非法事件 ${JSON.stringify(event)} → ${result.success ? '' : JSON.stringify(result.error.issues)}`,
          ).toBe(true)
        }
      })

      it('encodeSseFrame 重编码与 Python runtime.sse 字节一致', () => {
        const reencoded = scenario.runtimeEvents
          .map((event) => encodeSseFrame(String(event.type), event))
          .join('')
        expect(reencoded).toBe(scenario.runtimeSse)
      })

      it('toUiTransportPayload + encodeSseFrame 与 Python ui.sse 字节一致', () => {
        const frames: string[] = []
        for (const event of scenario.runtimeEvents) {
          const payload = toUiTransportPayload(event)
          if (payload !== null) frames.push(encodeSseFrame(String(payload.type), payload))
        }
        expect(frames.join('')).toBe(scenario.uiSse)
      })

      it('每个 UI payload 都符合 uiEventSchema', () => {
        for (const event of scenario.runtimeEvents) {
          const payload = toUiTransportPayload(event)
          if (payload === null) continue
          const result = uiEventSchema.safeParse(payload)
          expect(
            result.success,
            `非法 UI payload ${JSON.stringify(payload)} → ${result.success ? '' : JSON.stringify(result.error.issues)}`,
          ).toBe(true)
        }
      })
    })
  }
})
