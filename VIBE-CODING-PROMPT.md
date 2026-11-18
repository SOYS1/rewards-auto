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
| 阶段流转 | `idle → daily → search → search-review → done`，另有 `paused`（用户停止）与 `error` |
| 入口 | `boot()` → `rewardsStep()` / `bingStep()` / `runTaskPage()` |
| 唯一跳转出口 | `go(url)`，内部先过 `navigationTarget()` 白名单校验 |
| 选择器与文案 | 文件顶部常量区：`CARD_SELECTOR`、`SKIP_PATHS`、`TASK_HOSTS`、`NEXT_TEXTS`、`OPTION_SELECTOR`、`TEXT_PATTERNS` |
| 面板 | `PANEL_CSS` + `PANEL_HTML` + `mountPanel()` / `renderPanel()` / `bindPanelEvents()`，`refreshStats()` 每 5 秒轮询 |
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

## 本轮目标

### P0 · 稳定性

- `syncTasks()` 的 `attempts` 判定：任务「访问过但未完成」时依赖回到 Rewards 后的卡片状态，
  如果卡片是懒加载，可能在本轮被误判 `failed`。请给出更稳的复核策略（例如二次 `waitFor` + 仅在同一次运行内重试）。
- `onSearchResult()` 的 `pointsLast` 差值在「积分被其他来源同时增加」时会高估搜索积分。
  现在的兜底是 `reviewSearches()` 取整段差值。请评估是否需要用「每次搜索后的增量中位数」做异常值剔除。
- `state.navCount > 120` 的硬阈值在任务很多时可能误伤，请改成「按阶段限量」而不是全局限量。

### P1 · 面板 UI（重点）

现状：header → 今日积分 + 环形任务进度 → **必应搜索** → 任务分段 → 每日任务 → 连续天数/总积分 → 底栏开关。

「必应搜索」区块是 v1.1.0 新加的，字段为：今日已获搜索积分 / 每日上限（`desktopTarget × pointsPerSearch`）、
进度条、已完成 X/Y 次、每次搜索 +N 积分、还差 N 积分；打满后整块转绿并显示「今日搜索积分已满」。

希望优化：

1. **信息层级**：脚本的主要价值是搜索积分，这块应该比「今日已获得积分」更容易一眼扫到。
   考虑把它和 summary 合并成一张主卡（左边大数字＝搜索积分，右边小环形＝任务完成度），而不是两块并列。
2. **运行中反馈**：搜索阶段让进度条有轻微的流动/呼吸动画（`prefers-reduced-motion` 下必须关闭），
   并在底栏状态文字里显示「第 N 次搜索中」。
3. **打满态**：除了变绿，加一行轻量说明（例如「明天 0 点重置」），不要用庆祝动画。
4. **折叠态**：折叠后标题栏右侧显示 `45/90` 的迷你进度，不用展开就能看到搜索积分。
5. **移动端**：`@media (max-width: 620px)` 下当前是整块贴底，检查内容是否超高、滚动是否顺手。
6. **性能**：`refreshStats()` 每 5 秒调用 `scanCards()` + `document.body.innerText`，
   在长列表页会反复触发 layout。请给出不牺牲准确性的降频或按需触发方案（例如只在 DOM 变化时重扫）。
7. **可访问性**：进度条补 `role="progressbar"` + `aria-valuenow`，开关补 `aria-checked` 语义。

改进时必须保持：暗色玻璃拟态风格（`--panel` / `--line` / `--blue` / `--green` 变量）、24px 大圆角、
不使用图片资源（图标全部内联 SVG）、文本全部中文。

### P2 · 可维护性

- 把 `rewardsStep()` 里「拼图页 / Rewards 站内页」两段几乎重复的分支抽成一个函数。
- `TEXT_PATTERNS` 之外，把「已完成 / Completed」这类状态词也集中成常量。
- 给 `state.phase` 的取值做个校验函数，避免拼错字符串后静默失效。

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
- `innerText` 会强制 layout，5 秒一轮回的全量读取在长页面上很贵。
- 中英文界面文案不同，正则只写中文会在英文账号下全部失效（已修，别改回去）。
- 桌面浏览器无法完成移动端搜索、Edge 浏览时长、Xbox / 桌面奖励应用类任务——这些只能跳过，不要尝试伪造 UA 或环境。
- 拼图（`spotlight/imagepuzzle`）无法自动完成，只能记日志跳过。
