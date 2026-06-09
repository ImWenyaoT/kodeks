# oracle — 行为黄金基准（golden master fixtures）

这个目录存放 kodeks **迁移期录制的行为快照**：把（已退役的）Python 后端在一组确定性场景下
吐出的事件流、SSE 线缝字节、审计记录，一字不差地"拍照存档"成静态数据文件。

TypeScript 后端的测试（`frontend/lib/server/agent/oracle-replay.test.ts`、`wire/events.test.ts`、
`routes/routes.test.ts`）会读取这些快照并**逐事件 / 逐字节对拍**，以证明 TS 实现与原 Python 行为完全一致。
这是一种经典的迁移验证手法——golden master / 特征测试（characterization testing）。

## 目录结构

```
oracle/
  manifest.json          # 场景索引 + 录制时的 Python commit + volatileFieldPaths（需归一化的易变字段）
  scenarios/<id>/
    setup.json           # 复现条件：workspace 文件 / env / 预置记忆（供跨语言重放重建）
    request.json         # 请求体
    script.json          # 假模型剧本（每轮 Responses-shaped 事件）
    runtime-events.json  # 黄金答案：runPythonChatTurn 吐出的 runtime 事件序列（最稳的 oracle）
    runtime.sse          # /api/chat/stream 的逐字 SSE 文本（snake_case 原始事件）
    ui.sse               # /api/chat/ui 的逐字 SSE 文本（kebab/camelCase UI 事件）
    audit.json           # 审计日志行（type + payload）
```

## 10 个场景

`text-only`、`single-tool`、`unknown-tool`、`approval`、`plan-mode`、`memory-recall`、`stream-error`、
`large-tool`、`multi-tool`、`pseudo-tool-call`（覆盖文本/工具/审批暂停/计划/记忆召回/错误/多轮续跑/大输出卸载等控制流）。

## 这些快照是怎么来的？

迁移期由 `oracle/record.py`（一台"相机"）驱动**真实的 Python kodeks 运行时** + 脚本化假模型录制而成。
Python 后端已在迁移完成后（M7）移除，故 `record.py` 不再保留——快照已**冻结**为黄金基准。
若将来需要修改后端行为，应同时更新 TS 实现与对应快照（或参考 git 历史中的 `record.py` 重建录制器）。

## 比对时的归一化

`runtime-events.json` 含生成式易变字段（`appr_`/`atom_`/`plan_`/`msg_` 等 32 位 hex id、ISO 微秒时间戳）。
TS 测试在比对前对两侧施加同样的归一化（正则替换为占位符，详见 `manifest.json` 的 `volatileFieldPaths`），
再做深比较 / 逐字符比较。
