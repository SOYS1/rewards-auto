# Microsoft Rewards 自动助手

`ms-rewards-auto.user.js` 是自动化核心 + 悬浮面板（油猴脚本），`index.html` 是最初的 UI 设计预览（面板已按它的视觉移植进脚本）。

## 安装

1. 浏览器安装 Tampermonkey（或 Violentmonkey）。
2. 新建脚本，把 `ms-rewards-auto.user.js` 的内容整体粘贴进去并保存；或直接打开
   <https://raw.githubusercontent.com/SOYS1/rewards-auto/main/ms-rewards-auto.user.js> 由插件接管安装。
3. 脚本带有 `@updateURL` / `@downloadURL`，之后仓库 `main` 分支更新时插件会自动拉取新版本。
4. 确保**没有同时启用其它 Rewards 自动脚本**（例如旧的 `Rewards 自动助手 v1.1.3`），否则两边会互相抢标签页。

## 运行

页面上会出现悬浮面板，把底栏的「自动运行」拨开即开始；也可以用控制台：

```js
// 在任意 bing.com / rewards.bing.com 页面的控制台里
MSRewards.start();                 // 开始（会自动跳到 rewards.bing.com/dashboard）
MSRewards.stop();                  // 停止
MSRewards.getState();              // 查看当前阶段、任务列表、日志
MSRewards.configure({ desktopTarget: 20 });  // 修改配置
```

也可以直接在地址后加参数触发一次：`https://rewards.bing.com/dashboard?msr=start`。

## 配置项（`MSRewards.configure({...})`）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `searchEnabled` | `true` | 是否自动搜索 |
| `desktopTarget` | `30` | 每日 PC 搜索次数（各地区额度不同） |
| `mobileTarget` | `0` | 移动端搜索次数，桌面浏览器无法完成，保留占位 |
| `pointsPerSearch` | `3` | 每次搜索发放的积分，用于换算每日搜索积分上限（`desktopTarget × pointsPerSearch`） |
| `minDelayMs` / `maxDelayMs` | `4500` / `9000` | 两次搜索的随机间隔 |
| `dailySet` | `true` | 是否扫 dashboard / earn 的每日活动卡片 |
| `quizzes` | `true` | 是否在答题页尝试自动作答 |
| `punchcards` | `false` | 拼图卡片（`/earn/quest/`），多数需要桌面应用，默认跳过 |
| `maxAttemptsPerTask` | `2` | 同一任务最多访问次数 |
| `stallAfter` | `6` | 连续多少次搜索没加分就提前收尾 |
| `maxRuntimeMin` | `45` | 单次运行最长分钟数 |
| `autoStart` | `false` | 每天第一次打开 Rewards 时自动运行 |
| `showPanel` | `true` | 是否显示悬浮面板 |

## 面板

脚本会自己在页面右下角注入一块悬浮面板（Shadow DOM，样式与 Bing 页面隔离）：

- **今日积分 / 总积分 / 连续天数**：从 Rewards 页面文字解析；在 Bing 搜索页则实时读右上角积分挂件。
- **必应搜索**：今日已获搜索积分 / 每日搜索积分上限，进度条按 `desktopTarget × pointsPerSearch` 计算
  （默认 30 次 × 3 积分 = 90），下方显示「已完成 X/30 次 · 每次搜索 +3 积分 · 还差 N 积分」；打满后整块变绿。
- **进度环 + 分段条**：按扫描到的每日任务完成比例绘制。
- **未完成任务**：直接列出今天还没做完的卡片标题。
- **底栏**：状态点（绿=待机、蓝=运行、黄=暂停、红=出错）与「自动运行」开关，拨动即开始/停止。
- **右上角**：拖拽手柄（位置会记住）、折叠、立即刷新。

面板在 dashboard 与 earn 上会把两处扫到的卡片合并去重，所以你切到哪个页面都能看到完整清单。数据每 5 秒随页面变化自动更新。

## 工作流程

脚本是「单标签页状态机」：每次页面加载都从存储里恢复状态，只推进一小步，然后跳转。因此不需要常驻后台，也不会被后台标签页节流卡住。

```
rewards.bing.com/dashboard  扫描卡片 → 记录未完成任务
        │
        ├─ 逐个访问任务（同标签页跳转）→ 回 dashboard 复核是否完成
        │     未完成且未超过重试次数 → 再试一次
        │
rewards.bing.com/earn       再扫一遍（两个入口卡片集合不同）
        │
        └─ 每日任务清空 → 开始搜索
                │
bing.com/search?q=...       随机查询，每次停留 4.5~9 秒、轻微滚动
                │  结果页右上角积分没涨 → 连续 6 次就提前收尾
        ┌───────┘
rewards.bing.com/dashboard  复核积分、写入日志、结束
```

安全边界：

- 只跳转 `www.bing.com`、`cn.bing.com`、`rewards.bing.com`、`www.msn.com`、`www.microsoft.com` 白名单内的任务链接。
- 跳过 `/redeem`（兑换）、`/sweeps`（抽奖）、`aka.ms` 推广、账号与语言设置等入口。
- 遇到人机验证页面立即停止，不做任何绕过。
- 所有点击都限制在识别到的答题容器内，答题失败不会乱点页面。

## 已知限制

- **搜索积分是脚本实测值**：面板里的「必应搜索」积分靠结果页积分挂件逐次累计，返回 Rewards 后再用整段差值兜底。手动搜索的部分不会被统计；如果你改了地区额度，记得同步调整 `desktopTarget` / `pointsPerSearch`。
- **统计只解析中英文界面**：Rewards 的文案选择器集中在 `TEXT_PATTERNS`，其他语言需要补一条正则。
- **移动端搜索**（`mobileTarget`）需要移动 UA，脚本无法在桌面浏览器完成。
- **Edge 浏览时长**、**Xbox / 桌面奖励应用**类任务需要真实使用对应客户端，脚本只能跳过。
- **图片拼图**（`spotlight/imagepuzzle`）无法自动完成，会记日志后跳过。
- 答题自动作答是启发式的：能点选项、点「下一个/提交」，但选中答案不保证正确（Bing 通常完成后即给分）。
- Rewards 页面结构随时可能改版，选择器集中在文件顶部常量区，方便维护。

## 扩展接口

`window.MSRewards` 对外暴露（面板就是用它驱动的），想自己接管界面或做统计时可以：

```js
const api = window.MSRewards;

api.start();                 // 开关 / 按钮
api.stop();
api.getState();              // 阶段、搜索进度、任务列表、统计、日志
api.getSettings();           // 当前配置
api.configure({ ... });      // 保存配置

// 事件：msr:ready / msr:log / msr:change / msr:stats / msr:finish / msr:stop
window.addEventListener('msr:log', (event) => {
  console.log(event.detail.detail.message);
});

// 也可以不用 DOM 事件，直接订阅
const off = api.subscribe(({ type, state, detail }) => { /* 刷新自己的界面 */ });
```

`getState()` 返回：`running`、`phase`、`search`（`done` / `target` / `pointsStart` / `pointsLast`）、`scanned`（哪些页面已扫描）、`stats`（`today` / `total` / `streak` / `tasks`，以及搜索统计 `search`：`gained` / `count`）、`tasks`（每个任务的 `status`：`pending` / `active` / `visited` / `done` / `failed` / `skipped`）、`log`。

## 更新日志

- **1.1.0**：面板新增「必应搜索」积分区块（今日搜索积分 / 每日上限 / 每次积分）；统计支持中英文界面；跳转前二次白名单校验；`phase` 增加 `paused`；超时不再标记为错误；补齐 `@updateURL` 自动更新。
- **1.0.0**：首个版本。

## 开发

想继续用 AI 迭代这个项目，可以直接把 [`VIBE-CODING-PROMPT.md`](./VIBE-CODING-PROMPT.md) 整份作为上下文——
里面写清了架构速查、硬性约束、面板 UI 规格、验收标准和已知坑。
