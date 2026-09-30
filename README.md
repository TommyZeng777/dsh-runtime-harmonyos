# DSH Runtime for HarmonyOS

在 HarmonyOS 应用里运行 DeepSeek Harness（DSH）Agent 内核的底座：内核跑在 ThreadWorker 中，开发者用 ArkTS 注册工具、接收事件、搭建自己的 Agent 应用。

*Run the DeepSeek Harness agent kernel inside a HarmonyOS ThreadWorker, and build your own agent app on top of it with ArkTS tools and events.*

> 基于 DeepSeek Harness 构建的社区项目，与 DeepSeek 无关联，未获其背书。

**状态：开发中。** 内核构建、运行时和对外接口（`DshAgent`、ArkTS 工具、审批与提问事件）已完成，在 Node 上通过了端到端测试，并已在 HarmonyOS 模拟器上用真实的 DeepSeek 模型跑通示例应用。

## 支持的 DSH 版本

| DSH tag | 源码补丁 | 内核构建 | Node 端到端 | 设备运行 |
| --- | --- | --- | --- | --- |
| `dsh-v0.1.7-rc.2` | 通过 | 通过 | 通过 | 抽离前的同一套移植已在 HarmonyOS 7.0 设备上运行过；本仓库版本未验证 |
| `dsh-v0.2.0-rc.2` | 通过 | 通过 | 通过 | HarmonyOS 模拟器通过（示例应用：只读工具、写入工具经审批后执行、会话持久化）；真机未验证 |

Node 端到端测试覆盖：流式文本回合；调用官方工具（`todo_write`）；应用工具的只读直通、写入前审批（允许与拒绝）；`ask_user_question` 提问作答；会话持久化与重启恢复；以及整个 Worker 包经由消息协议运行一轮带工具调用的对话。

## 快速上手

```ts
import { DshAgent, DshEvent, DshTool } from './dsh/DshAgent';

const deleteNote: DshTool = {
  name: 'delete_note', description: 'Delete one note by its exact title.', effect: 'write',
  parameters: { 'title': { type: 'string', required: true } },
  execute: async (args) => { /* 应用自己的业务逻辑 */ return { deleted: true }; }
};

const agent = await DshAgent.create(context, {
  provider: 'deepseek', model: 'deepseek-flash', providers: { 'deepseek': { preset: 'deepseek' } },
  apiKey: async () => loadKeyFromSecureStorage(),   // 不要把密钥打进安装包
  tools: [deleteNote],
  instructions: 'You help the user manage their notes.'
});
agent.onEvent((event: DshEvent) => {
  if (event.method === 'approval.requested') {
    // 写入/外部类工具执行前会先到这里；由应用自己的界面征求用户同意
    agent.resolveApproval(String(event.params['requestId']), userAllowed);
  }
});
await agent.send('session-1', '删掉我的购物清单');
```

- **工具**：用 ArkTS 编写，声明 `effect`：`read`（只读应用数据，直接执行，可以并行）、`write`（修改应用内数据）、`external`（影响应用之外，如发消息、调用第三方服务）。`write` 和 `external` 默认先经用户确认，可以对单个工具设置 `autoApprove: true`。系统权限（相机、位置等）仍由 HarmonyOS 自己的授权弹窗处理。
- **审批**：基于 DSH 官方的 `user-approval` 服务，每次请求和决定都记入会话审计日志；没有应答时按拒绝处理。底座只发出 `approval.requested` 事件，确认界面由应用实现。
- **提问**：模型通过官方的 `ask_user_question` 提问、提交计划审阅时，应用收到 `question.requested`，用 `answerQuestion` 作答。
- **计划模式**：规划期间只允许执行 `read` 类应用工具。
- **事件**：`session.event`（持久化的会话事件）、`session.assistant-stream`（流式文本）、`session.status`、`session.runtime.error`，以及上面的审批和提问事件。

## 示例应用

`example-app/` 是一个最小的笔记助手：`list_notes`（只读）和 `delete_note`（写入，执行前需要审批）。

```sh
npm run example:prepare -- --dsh <已安装依赖的 DSH 检出>
cd example-app && devecocli build --build-mode debug
```

安装到设备前需要配置你自己的签名。运行时在界面里输入 DeepSeek API Key，只保存在内存中。

## 构建

本仓库不包含 DSH 源码。构建时读取一份 DSH 官方 tag 的检出，并安装好它的依赖：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness dsh && cd dsh && git checkout dsh-v0.2.0-rc.2
pnpm install --frozen-lockfile --ignore-scripts
cd ../dsh-runtime-harmonyos && npm install
npm run build -- --dsh ../dsh --expect 0.2.0-rc.2     # 输出 dist/dsh-worker.js
```

产物 `dsh-worker.js` 是一个 ES 模块，导出 `mount(port, primitives)`，其中包含 [`harmonyos-node-compat`](https://github.com/TommyZeng777/harmonyos-node-compat)、DSH 内核（ES2016，不含任何 Node 内置模块导入）和运行时。把它放在 `DshWorker.ts` 旁边，命名为 `DshWorkerBundle.js`。加上 `--kernel-only` 则只输出内核。

## 对官方源码做了什么

所有改动都是构建时的源码补丁（`build/patches/`）。每个补丁先检查目标源码片段是否与预期一致，不一致就让构建失败，避免上游变更后补丁悄悄失效。

| 补丁 | 原因 |
| --- | --- |
| `cordis` | ArkTS 虚拟机不会通过原型链上的 Proxy 解析 Cordis 子上下文的服务访问器；另外，默认参数里的箭头函数会丢失 `this` |
| `async-helper` | esbuild 把 async 函数降级后，会丢失 zone.js 上下文；AsyncLocalStorage 依赖这个上下文 |
| `agent-resume` | 增加 `Agent.resume()`，不用伪造用户输入就能继续被中断的回合 |
| `context-pressure` | 失败或中止的请求会上报全零用量，不应据此重置上下文统计 |
| `error-classification` | 让 Worker 网络错误的分类信息完整穿过 pi-ai 和 OpenAI SDK |
| `public-web` | DNS 解析和固定 IP 连接交给 ArkTS 宿主，其余网页抓取策略沿用 DSH 原逻辑 |
| `attachment-admission` | 用 atob/btoa 代替 Node 的 Buffer 做 base64 编解码 |
| `openai-request-body` | 超大请求正常报错，而不是让 Worker 崩溃 |

此外，构建时不打包以下内容：桌面沙盒、子进程形式的子代理、stdio 形式的 MCP、会话日志上传和遥测。

## 运行时

`src/runtime/` 在 Worker 里启动内核：

- `createRuntime(DshCore, options)`：装配官方服务和所选模块，提供 `send`、`history`、`list`、`cancel`、`dispose`，所有会话事件通过 `onEvent` 推送。
- 模块默认启用待办、目标、上下文压缩、提问、计划模式、子代理（在同一 Worker 内运行）、后台任务、会话查询和标题；网页工具需要显式开启。
- 会话存储：索引加内容寻址的只读记录，追加以事件分段写入（段数不超过 log2(n)+1），大记录自动分块，每次读取都校验哈希。宿主只需实现 `read(name)` 和 `write(name, text)`，ArkTS 实现见 `harmony/DshFileStore.ets`（临时文件、fsync、rename 原子替换）。
- 模型：`providers.js` 提供 DeepSeek 和任意 OpenAI 兼容接口的路由预设；API Key 由应用在运行时提供，不写进包里。

## 已知限制

- 计划模式下"只允许 `read` 类应用工具"的限制已经实现，但还没有自动化测试。
- 工具调用被取消时，ArkTS 侧正在执行的 `execute` 不会被中断，只是结果被丢弃。
- 待处理的审批和提问只保存在内存中：应用重启后，内核会把它们当作已取消。
- 暂不支持图片附件和 OAuth 类的模型账号。

## 路线图

1. ~~运行时启动与会话存储~~（已完成）。
2. ~~对外接口：`DshAgent`、用 ArkTS 注册工具、事件流~~（已完成）。
3. ~~面向沙盒应用的审批~~（已完成，基于官方 `user-approval`）。
4. ~~示例应用与模拟器验证~~（已完成）。真机验证、拒绝审批与提问作答的设备验证待做（Node 已覆盖）。
5. 以后：图片附件、OAuth 类模型账号、可选的 ArkUI 聊天与审批组件。

## 测试

```sh
npm test                                   # 不依赖 DSH 源码的部分
DSH_REPO=<DSH git 仓库> npm test            # 在每个支持的 tag 上跑补丁契约测试
DSH_ROOT=<已安装依赖的 DSH 检出> npm test    # 构建内核，并在 Node 上跑端到端对话
```

## 许可

MIT，见 [LICENSE](LICENSE)。构建产物包含 DeepSeek Harness（MIT）及其第三方依赖，分发时请一并附上 [NOTICE](NOTICE) 和 DSH 的 THIRD_PARTY_NOTICES.md。
