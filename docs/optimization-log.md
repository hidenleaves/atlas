# plc-atlas 优化 session

- 起始：2026-10-23 19:35 +0800
- 目标结束：2026-10-24 01:35 +0800
- 规则：每轮一个主题；跑完测试再 commit + push；轮次之间用 ScheduleWakeup 继续。

## 第 1 轮 · 19:35

主题：人设卡 + 提示词单一事实源 + 工具 schema 收紧。

- 新增 `js/prompt.js`：SYS 从 `chat.js` 抽出，按角色卡 / 工具纪律 / 失败处理 / 输出契约 / 风险边界分层。
- 统一示例代号前缀为 `FA` / `BB`，和画板 `tryKey`、图集一致。
- `draw_plan` / `place_component` schema 增加 `enum`、branch 1–6、pins `minItems: 2`。
- 新增 `tools/export-prompt.js`（生成 `提示词.md`）与 `tools/prompt-test.js`（28 项静态回归）。
- 修好了原来被压扁、和代码不同步的 `提示词.md`。

验证：prompt 28/28、route 37/37、api 14/14、Edge headless PASS。

## 第 2 轮 · 20:09

主题：`draw_plan` 原子化、align 预排序、失败回滚与母线避让。

- `drawPlan` 先校验类型、重复 `type:key`、`align/near` 目标，再决定是否清空。
- 快照 + 失败回滚（`rolledBack:true`）：`clear` 不再留下空图或半张图。
- `ok` 纳入电气检查的 `error`；`finished` 不再把“接上了但有短路”当成功。
- `align/near` 依赖预排序：目标写在 components 后面也能同行；成环提前报错。
- `pickBusY` 避让已有水平母线；短路报错的节点名不再显示 `undefined`。
- `clear` 同时清理 `deco`；`brief` 回传 `rolledBack / placed / components / wiring / placeErrors`。
- 同一轮 `draw_plan` 成功后跳过剩余 tool calls。

验证：api 20/20、route 37/37、prompt 28/28、Edge headless `rollback=true / align=true / PASS`。

遗留：极端跨列布局下，母线引出线仍可能穿过同列另一个引脚；当前会回滚并报短路，后续做侧向引出。

## 第 3 轮 · 20:44

主题：电源端子与回路闭合判断。

- `draw_plan` 新增 `terminals: [{name, node}]`：端子落在指定节点的首个引脚上，并渲染名称标签。
- advisor 新增“可能导通”可达性：从线圈两端沿导线和开关/触点/保护件走，看能否碰到 `term`。
- 没有任何端子：给 `info`“图上没有电源端子，无法判断线圈回路是否闭合”。
- 有端子但某线圈两端到不了 L/N：给 `warn`“... 的线圈回路没有回到电源（缺 L 或 N 端子）”。
- `check` 回复改为“局部接法没发现问题，但有一点要说明”，不再把 info 当成“没问题”。
- 提示词和 `draw_plan` schema 增加 `terminals` 用法与示例。

验证：prompt 30/30、route 37/37、api 25/25、Edge headless `terminals=true / check=true / PASS`。

## 第 4 轮 · 21:02

主题：`draw_template` 工具与模板单一实现。

- 新增 `js/templates.js`：`jog / selflock / interlock / reverse`，返回 `{ok, kind, title, reply}`。
- 新增 `api.drawTemplate`：快照 + 失败回滚 + 电气自检；路由和模型共用同一入口。
- `chat.js` 的四个 `build*` 改为薄封装；`execStep` 的 draw 分支统一走 `drawTemplate`。
- 新增模型工具 `draw_template`（`kind` enum + `interlock/selflock` 开关），工具总数 8。
- 提示词增加 `draw_template` 用法；`draw_template` 成功也进入收尾，避免模型回头改图。

验证：prompt 32/32、route 37/37、api 29/29、Edge headless `reverse=true / interlock=true / route=true / tools=true / PASS`。

## 第 5 轮 · 21:35

主题：正反转 + 主电路模板。

- `templates.js` 新增 `reverseMain`：通过 `PLCEditorModel.fromCircuit` 复用图集 1-12「双重互锁正反转」。
- 一条模板同时产出主电路（隔离开关、熔断器、接触器主触点、热继电器、电机、相序交换、接地）和控制回路，并带 L/N 端子。
- `draw_template` 新增 `main:true`（reverse 专用）；主电路固定是双重互锁 + 自锁，不能单独关互锁/自锁。
- 提示词和 schema 同步说明；主电路模板与图集共用同一套符号和代号。

验证：prompt 34/34、route 37/37、api 31/31、Edge headless `26 元件 / 10 主触点 / 5 端子 / level=ok / PASS`。

## 第 6 轮 · 22:07

主题：CI + 一键测试。

- 新增 `package.json`：`npm test` 串跑 route / api / prompt；`npm run prompt` 生成文档；`npm run prompt:check` 校验文档没有过期。
- 新增 `.github/workflows/test.yml`：push / PR / 手动触发，Node 22，先跑单元测试，再检查 `提示词.md` 与 `js/prompt.js` 是否同步。
- 工作流加了 `contents: read` 和 concurrency，重复 push 会取消旧任务。

验证：本地 `npm test` 全过，`npm run prompt:check` 无 diff。

## 待办队列

1. ~~失败链路：`draw_plan` 的 ok/finished 语义、`clear` 回滚、`align` 预扫描。~~（第 2 轮完成）
2. ~~电源端子检查（advisor warn）与“无法判断回路闭合”措辞。~~（第 3 轮完成）
3. ~~`draw_template` 工具，让模型和内置路由共用参数化模板。~~（第 4 轮完成）
4. 星三角 / 降压启动模板（主电路组合已由第 5 轮覆盖正反转）。
5. UI：错误定位、空状态引导、移动端。
6. ~~测试与 CI：GitHub Actions 跑 route / api / prompt 测试。~~（第 6 轮完成）
7. README / 使用说明。
8. 参考开源：QElectroTech（符号/连线）、OpenPLC/Beremiz（IEC 61131-3）。
9. `wireNodes` 侧向引出：避免母线引出线穿过同列其他引脚。
10. 端子落点优化：目前放节点首引脚，后续可放到母线端点并自动避让元件。
11. `draw_template` 的主电路模板目前复用图集固定版，后续可参数化熔断器/热继电器。
12. 主电路模板的可编辑性回归：多极元件、重复 `type:key` 的选中/删除。
13. 首次 GitHub Actions 运行结果确认（push 后查 API）。

## 参考

- QElectroTech：符号库、导线模型、引脚吸附。
- Together AI function calling best practices：schema 是准确率第一杠杆，enum / required / 明确“何时不用”。
- Persona 分层实践：角色卡与行为规则分开，关键约束放开头和结尾。
