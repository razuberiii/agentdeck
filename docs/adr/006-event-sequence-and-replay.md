# ADR 006：事件序列与重放

## 状态

已采纳。

## 决策

AgentDeck 区分 `runtimeLatestSequence`、`snapshotCoveredSequence`、`browserAppliedSequence` 和 `browserAcknowledgedSequence`。

## 原因

把快照覆盖范围误当成浏览器确认会跳过已持久化事件。浏览器只有真正接受事件或快照后，才能推进应用游标。

## 影响

重连发送浏览器已应用序列。Web 从 Runtime 缓冲并重放事件，按序列与 generation 去重。允许重复投递，不允许永久丢失。
