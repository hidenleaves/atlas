# Changelog

本文件汇总 2026-10-23 起的一轮集中优化。逐轮细节见 [`docs/optimization-log.md`](docs/optimization-log.md)。

## 优化 session（21 轮，2026-10-23 19:35 起，后于 10-24 续跑）

### Added

- `js/prompt.js`：人设卡与系统提示词的单一事实源；`提示词.md` 由 `tools/export-prompt.js` 自动生成。
- `tools/prompt-test.js`：提示词结构、工具名、schema 约束的静态回归。
- `js/route.js`：中文意图路由 v2 —— 否定作用域、角色判定、双重否定、把字句、前置/后置属性、复合指令。
- `tools/route-test.js` / `tools/route-fuzz.js`：55 条定向用例 + 102 条组合回归。
- `js/templates.js` + `PLCApi.drawTemplate`：模板单一实现，路由 / 对话 / 模板库共用。
- 内置模板：点动、起保停、互锁、正反转、正反转+主电路、两地控制。
- `draw_plan` 的 `terminals`、端子引线、电源端子与回路闭合检查。
- 模板库一键入口、对话快捷指令（8 个）、问题定位脉冲高亮。
- 窄屏聊天面板、`focus-visible`、`prefers-reduced-motion`。
- `package.json` 脚本：`npm test`、`npm run prompt`、`npm run prompt:check`。
- `.github/workflows/test.yml`：push / PR 跑 route、fuzz、api、template、prompt 回归，并检查提示词文档一致性。
- `tools/template-test.js`：8 个内置模板的画廊回归。
- `README.md`、`docs/optimization-log.md`、本 `CHANGELOG.md`。

### Changed

- 系统提示词按“角色卡 / 工具纪律 / 失败处理 / 输出契约 / 风险边界”分层。
- 工具 schema 收紧：元件类型 `enum`、`branch` 1–6、`nodes.pins` 至少 2 个。
- 路由的 `draw` 步骤携带 `explicit` 标记；明确否定属性时交给模型，否则可离线走固定模板。
- 模板、路由、对话、模板库统一走 `api.drawTemplate`，避免多处实现漂移。
- 端子不再压在引脚上，而是引 28px 短线放到引脚外侧。
- 母线引出线命中同列其他引脚时，自动侧移绕开。

### Fixed

- `clear:true` + 放置/连线失败会留下空图或半张图 → `draw_plan` 现在快照 + 原子回滚。
- `draw_plan` 只按放置/连线判断成功，忽略电气 `error` → 现在纳入 `analyze.level`。
- `align/near` 目标写在 `components` 后面时静默错位 → 依赖预排序 + 成环报错。
- 两条水平母线重叠、被并成一个网 → `pickBusY` 避让已有导线。
- 短路报错显示“和节点 undefined” → 使用真实节点名。
- `removeInterlock` 只取一个对端，T 接点会漏接自锁 → 收集两端所有邻居统一旁路。
- 清空后 `deco`（分区虚线）残留 → `clear` 一并清理。
- 删除同名代号时只回复“没找到” → 透传 API 的具体错误。
- `draw_plan` 没给 `nodes` 时输出 `undefined/0` → 改为“没有给 nodes”。
- “画布上有什么”被当成绘图请求 → `wantDraw` 不再误判。
- 同一轮 `draw_plan` 成功后仍执行后续 `remove/place` → 现在跳过剩余 tool calls。
- 端子压住符号、没有引线 → 改为外侧短线 + 标签。
- 跨列布局下母线引出线穿过同列引脚造成短路 → 侧向引出绕开。

### Tests

| 套件 | 用例数 |
|---|---|
| route | 55 |
| route-fuzz | 102 |
| api | 43 |
| template | 8 |
| prompt | 37 |
| **合计** | **245** |

另有 Edge headless 真页面测试：模板库、快捷指令、问题高亮、窄屏面板、端子引线、主电路路由、侧向引出。

### Known limitations / Backlog

- 星三角 / 降压启动模板尚未内置：需要 6 端子电机类型和更完整的星三角主电路。
- 固定主电路模板不能单独去掉热继电器/熔断器/自锁/互锁；这些情况会交给模型。
- 重复 `type:key` 元件（如三极主触点的多极副本）的选中/删除仍需按内部 id 处理。
- 复合指令的多步骤属性边界（“画个正反转然后别画互锁”）仍可能交给模型。
- AI 需要浏览器能访问所配置的 OpenAI 兼容端点；`file://` 打开通常最稳。
- 仅用于教学绘图，不做电气仿真或安全认证。
