# plc-atlas 优化 session

- 起始：2026-10-23 19:35 +0800
- 目标结束：2026-10-24 01:35 +0800
- 规则：每轮一个主题；跑完测试再 commit + push；轮次之间用 ScheduleWakeup 继续。

## Session 总结（19:35 起，20 轮）

- 20 轮迭代，每轮先跑测试再 commit + push；抽查的 GitHub Actions 全部成功。
- 提示词/人设卡：单一事实源 `js/prompt.js`，8 个工具 schema 收紧，`draw_template` few-shot 示例，`提示词.md` 自动生成。
- 路由 v2：否定作用域、角色判定、复合指令、前置/后置属性；route 55 条 + fuzz 102 条组合回归。
- 画板可靠性：`draw_plan` 原子回滚、`align` 预排序、母线避让、端子引线、电源回路闭合检查。
- 模板：点动 / 起保停 / 互锁 / 正反转 / 正反转+主电路 / 两地控制；路由、对话、模板库共用 `drawTemplate`。
- UX：对话快捷指令、问题定位高亮、窄屏面板、focus-visible、reduced-motion。
- 工程：`npm test` + GitHub Actions；README、提示词文档、优化日志同步。
- 回归：route 55 / fuzz 102 / api 42 / template 8 / prompt 37。
- 剩余大项：星三角（需要 6 端子电机 + 侧向走线）、`wireNodes` 侧向引出、主电路模板参数化、重复 `type:key`、复合指令边界。

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
首次 GitHub Actions 运行：`test / completed / success / 1e0a8b1`。

## 第 7 轮 · 22:39

主题：README / 使用说明。

- 重写仓库 README：快速开始、截图、指令表、AI 配置、模块图、测试、符号来源/许可、已知限制、路线图。
- 明确哪些指令走内置规则、哪些需要模型。
- 加 CI badge、`npm test` / `npm run prompt:check` 用法。
- 说明 `file://` 打开、网络诊断、localStorage 存储和教学用途边界。

验证：`npm test` 全过，`npm run prompt:check` 无 diff。

## 第 8 轮 · 23:11

主题：接线助手问题定位高亮。

- `editor-model.js` 新增 `targetBox(doc, kind, id)`：元件 / 导线 / 接点 / 虚线 / 文字统一成定位矩形。
- `editor-ui.js` 新增 `flashTarget`：点击接线助手的问题项时选中目标，并画 1.5 秒脉冲框。
- CSS 新增 `.flash-box` 和 `flashPulse` 动画；`select` / `loadDoc` 会清理计时器。
- 顺手去掉 `PLCEditor` 里重复的 `applySim` 键。
- 真页面 iframe 测试：`flash-box=yes`，1.7 秒后 `cleared=true`。

验证：`npm test` 全过（api 32/32，含 `targetBox`），Edge iframe `RESULT=PASS`。
CI：`ce6df0c` 复查为 `completed / success`。

## 第 9 轮 · 23:45

主题：对话快捷指令 + 空状态引导。

- `chat.js` 在挂载时动态创建 `#chatQuick`：起保停 / 互锁 / 正反转 / 点动 / 加自锁 / 检查。
- 点击 chip 直接填入并发送，不需要用户记说法；问候语提示“也可以点下面的快捷指令”。
- CSS 增加 `chat-quick` chips 样式，窄屏自动换行。
- iframe 真页面测试：`buttons=6 / comps=4 / reply=yes / RESULT=PASS`。

验证：`npm test` 全过，Edge iframe PASS。

## 第 10 轮 · 23:48

主题：后置否定 + 跨子句属性合并。

- `route.js` 支持后置否定：“正反转主电路不要”“互锁不要”。
- 只有属性、没有主体/动词的子句会生成 `attrs` 步骤，附着到上一张 `draw`：
  “画个正反转，不要自锁” → reverse + selflock=false。
- 新增 11 条路由用例，覆盖属性合并、复合指令、否定和前置否定，route 48/48。
- `interpretV2` 端到端：reverse 不带自锁时 `no=0 / nc=2 / coils=2`，回复包含“没有加自锁”。
- 真页面 iframe 测试 `RESULT=PASS`。

验证：`npm test` 全过（route 48、api 34、prompt 34），Edge iframe PASS。

## 第 11 轮 · 23:50

主题：两地控制模板。

- `templates.js` 抽出 `fromAtlas`，新增 `remote`：复用图集 1-14，一条模板出主电路 + 两地控制 + 自锁。
- `draw_template` 的 `kind` enum 增加 `remote`；路由 TERMS 增加“两地控制 / 多地控制 / 远程控制”。
- `canRunStep` / `execStep` 支持 `remote`；固定版带主电路和端子。
- README 指令表增加“画一个两地控制”。

验证：route 50/50、api 36/36、prompt 36/36，Edge headless `18 元件 / 5 端子 / level=ok / PASS`。

## 第 12 轮 · 23:51

主题：模板画廊测试 + 两地控制意图识别。

- 新增 `tools/template-test.js`：8 个模板逐个画，检查落盘、元件数、导线、标题、电气 error、SVG 渲染。
- `npm test` 加入 template-test；CI 会自动覆盖。
- advisor 的 `detectIntent` 增加“两地控制”识别（1 线圈 + 2 个 nc + 3 个 no）。
- api-test 增加两地控制意图断言。

验证：模板 8/8 全部 `level=ok`；`npm test` 全过（route 50、api 37、template 8、prompt 36）。

## 第 13 轮 · 23:53

主题：移动端 / 无障碍。

- `max-width: 640px` 时聊天面板铺满可视宽度、最大高度 62vh，快捷 chips 可滚动、不横向溢出。
- 增加 `:focus-visible` 外框和 `prefers-reduced-motion`（关闭闪光和刀口动画）。
- 对话区补 `role="region"`、`aria-label`、`aria-live="polite"`。
- 390×844 iframe 测试：面板 `339×271` 在视口内，快捷区 `scrollWidth=clientWidth`，`RESULT=PASS`。

验证：`npm test` 全过，Edge 窄屏 iframe PASS。

## 第 14 轮 · 23:54

主题：路由组合回归。

- 新增 `tools/route-fuzz.js`：动词 × 类型 × 否定 × 属性 + 固定命令，共 97 条确定性组合。
- 校验 `ok / steps / op / type / confidence / attrs` 字段合法性，并断言关键语义：
  - 各模板的 type；
  - 否定类型的 `ok:false`；
  - 属性否定的 `attrs` 值；
  - 清空 + 绘制、接线、删除、放置、检查等固定命令。
- `npm test` 和 CI 加入 route-fuzz。

验证：fuzz 97/97 通过；`npm test` 全过（route 50、fuzz 97、api 37、template 8、prompt 36）。

## 第 15 轮 · 23:56

主题：模板库一键入口。

- 元件库顶部新增“模板”组：点动 / 起保停 / 互锁 / 正反转 / 正反转+主电路 / 两地控制。
- 点击后确认替换，再调用 `api.drawTemplate`；和对话作图共用同一实现，Undo 可恢复。
- CSS 模板项高亮；窄屏仍可滚动。
- iframe 真页面：6 个模板按钮，起保停 4 元件，正反转+主电路 26 元件，`RESULT=PASS`。

验证：`npm test` 全过，Edge iframe PASS。

## 第 16 轮 · 23:58

主题：正反转带主电路离线化。

- `route.js` 的绘制步骤增加 `explicit` 标记：记录用户是否明确提到了某个属性。
- `canRunStep`：`main:true` 直接走固定主电路模板；用户明确不要热继电器 / 熔断器 / 自锁 / 互锁时仍交给模型。
- `execStep` 把 `main` 传给 `drawTemplate`；提示词和 README 同步说明固定版边界。
- 新增 route 52 / fuzz 99 用例；真页面：`画一个正反转带主电路` 出 26 元件，
  `不带热继电器` 保持空图并提示配置模型。

验证：route 52/52、fuzz 99/99、api 38/38、template 8/8、prompt 36/36；Edge `main=true / negative=true / PASS`。

## 第 17 轮 · 00:00

主题：属性前置 + explicit 传播。

- `attrs` 步骤生成 `explicit` 标记；没有上一步绘制时先暂存，合并到下一张 `draw`。
- 前置和后置属性都能生效：
  - “主电路要，画个正反转” → 主电路模板；
  - “不要自锁，画个正反转” → 不带自锁；
  - “主电路不带热继电器，画个正反转带主电路” → explicit thermal=false，交给模型。
- 新增 route 55 / fuzz 102 / api 41 用例。

验证：route 55/55、fuzz 102/102、api 41/41、template 8/8、prompt 36/36。

## 第 18 轮 · 00:02

主题：端子落点优化。

- `drawPlan` 的 `terminals` 不再直接压在引脚上：先引 28px 短线，把 term 放在引脚外侧。
- 选方向时避开元件包围盒、非本节点的引脚、已有端子；没有安全方向才回退到引脚。
- 端子仍通过引线和节点同网，回路闭合检查继续有效。
- 回归：端子有引线、不压引脚、标签渲染、`clear` 同时清 `deco`。

验证：api 42/42、template 8/8、`npm test` 全过；Edge `terms=2 / labels=true / deco=0 / PASS`。

## 第 19 轮 · 00:03

主题：`draw_template` few-shot 示例。

- SYS 增加 4 条“用户 → 工具调用”示例：正反转+主电路、正反转不带自锁、互锁、两地控制。
- `prompt-test` 增加“示例存在”检查；提示词 4217 字符，工具 8 个。
- 目标是减少模型该用模板却去调 `draw_plan` 的概率。

验证：prompt 37/37、route 55/55、fuzz 102/102、api 42/42、template 8/8、`npm test` 全过。

## 第 20 轮 · 00:04

主题：收尾打磨。

- 对话快捷指令从 6 个扩到 8 个：增加“正反转+主电路”“两地控制”。
- README 补一键模板、快捷指令、回归规模和优化日志链接。
- 优化日志补 session 总结与剩余 backlog。
- 收尾测试覆盖新 chip 的端到端行为。

验证：`npm test` 全过；真页面点击“正反转+主电路”出 26 元件，快捷区无横向溢出。

## 第 21 轮 · 11:44（续跑）

主题：`wireNodes` 侧向引出。

- 竖直母线引出会穿过同列其他引脚时，先向外走 16px，再侧移 18/30/44px 绕开。
- 候选路径检查元件包围盒、非本节点引脚、终点是否落在别的引脚上；没有安全方向才回退到竖直。
- 修复了“跨列布局下母线引出线穿过同列引脚导致短路”的已知问题。
- 新增回归：病态布局 `wiring=全部连通`，存在 1 条 4 点侧向引线，`level=ok`。

验证：api 43/43、template 8/8、`npm test` 全过；Edge `ok=true / side=1 / PASS`。

## 待办队列

1. ~~失败链路：`draw_plan` 的 ok/finished 语义、`clear` 回滚、`align` 预扫描。~~（第 2 轮完成）
2. ~~电源端子检查（advisor warn）与“无法判断回路闭合”措辞。~~（第 3 轮完成）
3. ~~`draw_template` 工具，让模型和内置路由共用参数化模板。~~（第 4 轮完成）
4. 星三角 / 降压启动模板（主电路/正反转/两地控制已覆盖；星三角仍待做）。
5. UI：~~错误定位~~（第 8 轮完成）、~~对话快捷指令/空状态~~（第 9 轮完成）、~~移动端/无障碍~~（第 13 轮完成）。
6. ~~测试与 CI：GitHub Actions 跑 route / api / prompt 测试。~~（第 6 轮完成）
7. ~~README / 使用说明。~~（第 7 轮完成）
8. 参考开源：QElectroTech（符号/连线）、OpenPLC/Beremiz（IEC 61131-3）。
9. `wireNodes` 侧向引出：避免母线引出线穿过同列其他引脚。
10. 端子落点优化：目前放节点首引脚，后续可放到母线端点并自动避让元件。
11. `draw_template` 的主电路模板目前复用图集固定版，后续可参数化熔断器/热继电器。
12. 主电路模板的可编辑性回归：多极元件、重复 `type:key` 的选中/删除。
13. ~~首次 GitHub Actions 运行结果确认（push 后查 API）。~~（第 6 轮完成，success）
14. 跨子句属性前置（“主电路要，画个正反转”）暂不合并到下一张图。
15. 复合指令多步骤属性合并边界（“画个正反转然后别画互锁”）。
16. ~~模板画廊测试 + 两地控制意图识别。~~（第 12 轮完成）
17. ~~路由组合回归（97 条确定性用例）。~~（第 14 轮完成）
18. ~~模板库一键入口（6 个模板）。~~（第 15 轮完成）
19. ~~正反转带主电路离线化（明确去掉元件时交模型）。~~（第 16 轮完成）
20. ~~属性前置 + explicit 传播。~~（第 17 轮完成）
21. ~~端子落点优化（引线到引脚外侧）。~~（第 18 轮完成）
22. ~~draw_template few-shot 示例。~~（第 19 轮完成）
23. ~~收尾打磨：8 个快捷指令 + README/会话总结。~~（第 20 轮完成）
24. ~~wireNodes 侧向引出（绕开同列引脚）。~~（第 21 轮完成）

## 参考

- QElectroTech：符号库、导线模型、引脚吸附。
- Together AI function calling best practices：schema 是准确率第一杠杆，enum / required / 明确“何时不用”。
- Persona 分层实践：角色卡与行为规则分开，关键约束放开头和结尾。
