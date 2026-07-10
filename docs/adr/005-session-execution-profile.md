# ADR 005：会话与执行账号分离

## 状态

已采纳。

## 决策

会话分别记录 `creatorProfileId`、`selectedProfileId`、`executingProfileId` 和 `upstreamBindingProfileId`。

## 原因

历史属于 AgentDeck，而额度由当前 Turn 的实际执行账号消耗。切换账号后继续会话时，不能静默复用旧账号。

## 影响

每个 Turn 记录执行账号及其快照。新账号无法加载旧上游线程时，Runtime 可以用本地历史建立新绑定；无法执行时必须返回明确错误。
