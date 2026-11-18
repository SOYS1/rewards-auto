# Vibe Coding 提示词：Microsoft Rewards 自动助手

> 用法：在新会话里把**本文件全文**作为上下文，再把 `ms-rewards-auto.user.js` 一并给出（或直接让代理读仓库）。
> 每次只丢一个优先级小节给它，比一次性让它「全面优化」的产出质量高得多。

---

## 角色

你是一名资深前端工程师，长期维护 Tampermonkey 用户脚本，熟悉浏览器扩展沙箱、
React 站点的 DOM 逆向、Shadow DOM 样式隔离，以及「页面会随时改版」这类不确定性下的防御式编程。
你写代码的原则是：**能少一行就少一行，能不改就不改，改了就一定能解释为什么。**

## 项目背景

- 仓库：`https://github.com/SOYS1/rewards-auto`
- `ms-rewards-auto.user.js`：约 1300 行单文件。自动化核心 + 悬浮面板（Shadow DOM）。
- `index.html`：面板的 UI 设计稿（静态预览，不参与运行）。
- `README.md`：安装、配置项、工作流程、已知限制。
- 零依赖、无构建、无测试框架。**唯一的分发方式是整段粘贴进 Tampermonkey**，所以不能拆模块。

## 架构速查（改任何东西之前先读这几处）

| 关注点 | 位置 |
| --- | --- |
| 存储 | `readRaw` / `writeRaw`（`GM_getValue` 优先，回退 `localStorage`），`STATE_KEY` / `SETTINGS_KEY` / `PANEL_KEY` |
| 全局状态 | `state`（`running` / `phase` / `date` / `search` / `scanned` / `stats` / `tasks` / `log`），`createState()` / `loadState()` / `persist()` / `publicState()` |
| 阶段流转 | `idle → daily → search → search-review → done`，另有 `paused`（用户停止）与 `error`；一律通过 `setPhase()` 改 |
| 入口 | `boot()` → `rewardsStep()` / `bingStep()` / `runTaskPage()` |
| 唯一跳转出口 | `go(url)`，内部先过 `navigationTarget()` 白名单校验，再按 `navBudget()` 的阶段性预算计数 |
| 任务复核 | `scanCards()` → `scanCardsSettled()`（等懒加载）→ `syncTasks()` / `settleUnseen()` |
| 搜索计分 | `searchCap()`（上限 = 次数 × 每次积分）、`addSearchPoints()`、`attributeSearchGain()`（异常值折算） |
| 选择器与文案 | 文件顶部常量区：`CARD_SELECTOR`、`SKIP_PATHS`、`TASK_HOSTS`、`NEXT_TEXTS`、`OPTION_SELECTOR`、`TEXT_PATTERNS`、`DONE_TEXTS` |
| 面板 | `PANEL_CSS` + `PANEL_HTML` + `mountPanel()` / `renderPanel()` / `bindPanelEvents()`，`refreshStats()` 每 `PANEL_REFRESH_MS`（10 秒）轮询，后台标签页跳过 |
| 对外 API | `window.MSRewards = { version, start, stop, configure, getSettings, getState, isRunning, subscribe }` |

核心模型是「单标签页状态机」：脚本跟随页面跳转，每次加载从存储恢复状态、只推进一步，然后跳走。
**不要引入常驻后台、Service Worker、多标签页协同**——那会让它同时被反爬和浏览器节流影响。

## 硬性约束（违反即打回）

1. 单文件、零依赖、无构建步骤。新增逻辑必须能整段粘贴回 Tampermonkey。
2. 安全边界不可放宽：只允许 `TASK_HOSTS` 内的域名；永远不进入 `/redeem`、`/sweeps`、`/account`、`aka.ms`；
   遇到人机验证立即 `finish(..., 'error')`，**不做任何绕过、不做重试试探**。
3. 所有导航都必须走 `go()`，禁止新增裸 `location.assign` / `window.open`。
4. 页面文案与选择器集中管理，同时提供中英文模式（`TEXT_PATTERNS` 就是范例）。
5. UI 必须留在 Shadow DOM 内，样式不能污染宿主页面；不引入 CSS 框架、不引入外部字体。
6. 保持现有命名与中文注释风格。注释解释**为什么**这么做，不复述代码。
7. 不新增会消耗用户积分的操作（兑换、抽奖、购买）——任何情况都不自动点击。
8. 向后兼容：`getState()` 可以加字段，不能删字段或改字段含义；旧存储数据必须能正常加载。

## 进度（v1.2.0 已交付，别再重做）

- P0-1 任务复核：已加 `scanCardsSettled()`（等待卡片渲染）+ `settleUnseen()`（等过一轮仍看不到卡片时按尝试次数收尾）。
- P0-2 搜索积分高估：已加 `attributeSearchGain()`，差值超过「配置值 / 历史中位数」两倍时只按 `pointsPerSearch` 记账。
- P0-3 跳转阈值：已改为 `navBudget()` 按阶段计算，`state.navByPhase` 分开计数。
- P1 面板：summary 与搜索区块已合并为一张主卡（左：搜索积分 + 进度条；右：任务小环形），
  搜索阶段有流动条动画、底栏显示「第 N/30 次搜索中」、打满变绿并提示「明天 0 点重置」、
  折叠后仍显示 `45/90` 迷你进度；进度条与开关补了 ARIA；轮询 10 秒 + 跳过后台标签页 + 只读 `main` 区域。
- P2：`visitRewardsTaskPage()` 已合掉重复分支；`DONE_TEXTS` / `DONE_LINE_TEXTS` 已集中；`setPhase()` 已加校验。
- `start()` 里最后一处裸 `location.assign` 也已改用 `go()`，现在全仓库只有 `go()` 会导航。

## 下一轮目标

### P0 · 稳定性（剩余）

- `stats.search.count` 是逐次累加的，用户手动刷新同一张结果页会多加一次；请评估用
  「本次运行的 `state.search.done` + 已持久化的基线」替代，避免面板次数虚高。
- `settleUnseen()` 把任务打回 `pending` 会重新排队，如果卡片只是当天不显示（例如活动结束但没标完成），
  它会白白消耗 `maxAttemptsPerTask`。考虑加一个「连续两轮都没看到就判 skipped」的规则。
- `nextQuery()` 的 `state.queryHistory` 只在 `start()` 时保留，跨天不重置但也不清理，跑一个月会顶到 400 条上限后
  永久拒绝新查询候选；确认这条截断策略是否会造成查询重复。

### P1 · 面板 UI（剩余）

1. **移动端实测**：`@media (max-width: 620px)` 下主卡已缩到 4.6rem 环形，但还没有在真机 360px 宽度下验证过折叠/展开的滚动。
2. **打满态**：现在是「今日搜索积分已满 · 明天 0 点重置」，可以再考虑把主卡标题换成「今日搜索已完成」。
3. **信息密度**：面板现在 508px 高，接近小屏上限；评估是否把「任务分段」并入「每日任务」块来省 40px。
4. **数字动效**（可选）：积分变化时给大数字一个 200ms 的淡入位移，注意 `prefers-reduced-motion`。

### P2 · 可维护性（剩余）

- `PANEL_CSS` 已接近 100 行且和 `index.html` 的设计稿开始漂移，考虑在 README 里注明「以脚本内为准」。
- `publicState()` 用 JSON 深拷贝，日志里带 `at` 时间戳，事件高频时会有额外开销；确认 `emit` 频率是否需要节流。

### P3 · 可选增强（先讨论，不要直接写）

- 运行结束写一条本地历史（`msr:history:v1`，只保留 30 天），面板上加「近 7 天搜索积分」小柱状图。
- 支持导出 JSON 日志，方便排查某个任务为什么没给分。
- 搜索查询池支持用户自定义（`configure({ queries: [...] })`）。

### P3 · 可选增强（先讨论，不要直接写）

- 运行结束写一条本地历史（`msr:history:v1`，只保留 30 天），面板上加「近 7 天搜索积分」小柱状图。
- 支持导出 JSON 日志，方便排查某个任务为什么没给分。
- 搜索查询池支持用户自定义（`configure({ queries: [...] })`）。

## 验收标准

1. `node --check ms-rewards-auto.user.js` 通过。
2. 用本地静态页验证面板：起一个静态服务器，页面里 `localStorage.setItem('msr:state:v1', ...)` 预置状态，
   加载脚本后检查 `#msr-capsule-host` 的 shadow root——不改代码只改预置数据，就要能分别复现
   「搜索中」「搜索打满」「跨天重置」三种形态。
3. 控制台无报错；`MSRewards.getState()` 返回结构包含新增字段。
4. README 的配置表、面板说明、更新日志同步改动。
5. 一次提交只做一件事，中文提交信息，说明「改了什么 + 为什么」。

## 输出要求

- 先给**改动计划**：涉及哪些函数、为什么、风险点、如何回滚。
- 拿到确认后再写代码；代码用最小 diff，不要整文件重写。
- 每处改动后面跟一句理由，不要写「优化了代码结构」这种空话。
- 如果发现我的需求与某个硬性约束冲突，**先停下来指出冲突**，不要擅自妥协。

## 已知坑（别重复踩）

- Bing / Rewards 是 React 应用，卡片懒加载，直接 `querySelectorAll` 常常拿到空数组，要 `waitFor()`。
- `innerText` 会强制 layout，面板轮询已经降到 10 秒且只读 `main` 区域，别再改回整页 5 秒。
- 中英文界面文案不同，正则只写中文会在英文账号下全部失效（已修，别改回去）。
- 桌面浏览器无法完成移动端搜索、Edge 浏览时长、Xbox / 桌面奖励应用类任务——这些只能跳过，不要尝试伪造 UA 或环境。
- 拼图（`spotlight/imagepuzzle`）无法自动完成，只能记日志跳过。
- 面板组件都在 Shadow DOM 里，MutationObserver 观察 `document.body` 看不到面板自身的改动，别用它去做「避免自触发」的假设。
