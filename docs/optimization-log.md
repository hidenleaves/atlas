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

## 待办队列

1. 失败链路：`draw_plan` 的 ok/finished 语义、`clear` 回滚、`align` 预扫描。
2. 电源端子检查（advisor warn）与“无法判断回路闭合”措辞。
3. `draw_template` 工具，让模型和内置路由共用参数化模板。
4. 更多模板：星三角 / 主电路组合。
5. UI：错误定位、空状态引导、移动端。
6. 测试与 CI：GitHub Actions 跑 route / api / prompt 测试。
7. README / 使用说明。
8. 参考开源：QElectroTech（符号/连线）、OpenPLC/Beremiz（IEC 61131-3）。

## 参考

- QElectroTech：符号库、导线模型、引脚吸附。
- Together AI function calling best practices：schema 是准确率第一杠杆，enum / required / 明确“何时不用”。
- Persona 分层实践：角色卡与行为规则分开，关键约束放开头和结尾。
