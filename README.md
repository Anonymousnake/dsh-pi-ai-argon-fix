# dsh-pi-ai-argon-fix

DeepSeek Harness 的 Gemini 4 Argon 原生 Google / Vertex 协议兼容补丁。

提供 `thinkingBudget` / `thinkingLevel` 参数兼容修复，以及 Web 聊天中更清晰的 Argon 推理摘要展示。不改 DSH 核心、不转换成 OpenAI 协议、不接管工具执行和签名处理。零新增运行时依赖，许可证 MIT。

## 为什么需要

在已验证的 `@earendil-works/pi-ai 0.87.1` 中，`usesGoogleThinkingLevel()` 的模型识别规则遗漏了 `gemini-4-argon`，原生适配器因此发送：

```json
{"thinkingConfig":{"includeThoughts":true,"thinkingBudget":-1}}
```

Google 返回 HTTP 400：

```text
Thinking budget is not supported for this model. Use thinking level instead.
```

本插件将 Argon 请求修正为：

```json
{"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"HIGH"}}
```

支持 `low`、`medium`、`high` 三档，匹配模型必须是 `gemini-4-argon`，provider 必须是 `google` 或 `google-vertex`。其他模型和 provider 原样放行。卸载插件时恢复原适配器。

## 兼容范围

已验证组合：

- DeepSeek Harness `0.2.0-rc.2`。
- `@deepseek-ai/dsh-llm-pi-ai 0.2.0-rc.2`。
- `@earendil-works/pi-ai 0.87.1`。
- DSH 内置 Google 原生适配器，经 CLIProxyAPI 的原生 Gemini 端点访问 Vertex `global` 区域。

插件包装了 pi-ai 适配器的内部 `streamWithSnapshot` 方法，因此升级 DSH 或 pi-ai 后需要重新验证。上游修复 Argon 模型识别并通过无插件对照后，应移除此补丁。

它不是凭据插件，也不会创建 Google provider。请先配置原生 provider，再加载本插件。

## 安装

下面以 `web` profile 为例，仅选择一种加载方式，避免同一插件重复加载。

### 安装为 DSH bundle

```sh
dsh plugin --profile web add github:Anonymousnake/dsh-pi-ai-argon-fix#v0.2.0
```

将 `dsh-pi-ai-argon-fix` 追加到该 profile 的 `package.json` 中 `dsh.profile.bundles` 列表，保留已有条目，并放在提供 `llm-pi-ai` 的 bundle 后面，然后重新加载或重启 profile。本包自带 `cordis.patch.yml`，会注册 `pi-ai-argon-fix` 插件。

### 已克隆源码时直接加载

在 profile 的 `cordis.patch.yml` 末尾添加：

```yaml
- insert:
    - id: pi-ai-argon-fix
      name: 'file:///ABSOLUTE/PATH/dsh-pi-ai-argon-fix/index.mjs'
```

Windows 路径示例是 `file:///C:/plugins/dsh-pi-ai-argon-fix/index.mjs`。确保加载顺序晚于 `llm-pi-ai` 的 provider 注册；如果已有同 ID 的旧条目，请替换它而非重复添加。

## 原生 Google 经 CPA 的配置示例

将下面的 `google` 条目合并到现有 `llm-pi-ai.config.providers`，保留其他 provider：

```yaml
- id: llm-pi-ai
  config:
    providers:
      google:
        displayName: Google Vertex Argon - Native
        # Omit api to reuse the built-in Google native protocol.
        baseURL: http://127.0.0.1:8317/v1beta
        apiKeyEnv: CPA_API_KEY
        reasoning: high
        models:
          - id: gemini-4-argon
            name: Gemini 4 Argon - Google Native
            contextWindow: 1048576
            maxTokens: 65536
            input: [text, image]
            reasoningEfforts:
              low: low
              medium: medium
              high: high
```

通过 DSH 凭据管理设置 `CPA_API_KEY`，不要将真实凭据写入公开配置。CPA 应已配置可用的 Vertex 服务账号、`location: global`，并对外提供 `gemini-4-argon`。

DSH 发出的协议为：

```text
POST /v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse
contents / parts / functionCall / functionResponse / thoughtSignature
```

这里使用 `google` 是为了匹配 CPA 的 Gemini 原生入站路由，不是切换到 OpenAI 兼容接口。直接连接 Google Vertex 的 `google-vertex` provider 也在插件的参数修正范围内，但其认证和端点仍由内置 Vertex 适配器负责；该直连组合尚未做真实端到端验证。

## 工具调用与签名

工具名称、调用 ID、完整 JSON 参数、工具结果、推理摘要，以及 `thoughtSignature` 的持久化和回传，均由现有 DSH / pi-ai 原生适配器处理。

插件不会伪造、复制或移动签名。并行工具调用中可能仅首个 `functionCall` 带签名，其余调用保持原样。

已在上述经 CPA 的组合中验证：

- 无插件时发送 `thinkingBudget`，上游返回 400；有插件时发送 `thinkingLevel`，上游接受请求。
- 两个并行工具调用的名称、ID 和参数完整，结果回传后模型正确完成汇总。
- 签名经过 DSH 的 JSON 持久化形状后原样回传。
- 当前 Web GUI 后端的真实 Agent 调用了 `pwsh`，执行结果与第二轮回复均成功入库；不是仅测一次 API 返回 200。
- `low / medium / high` 参数映射、非目标路由隔离与插件卸载恢复完成了本地检查。

## Web 推理摘要展示（0.2.0）

同一个包附带 Web 客户端，使用 DSH 的 `conversation.chat.node` 公共插槽，不修改核心文件，也不通过 DOM 扫描或模拟点击实现。

- 只对 `google` / `google-vertex` 的 `gemini-4-argon` 生效，其他模型沿用原渲染器。
- `detailed` / `verbose` 模式下，打开已有外层过程分组后，内部推理摘要默认展开；不会强制展开整段历史回合。
- 箭头始终可见，明确标注“推理摘要”和已收到的字符数，支持鼠标与键盘展开 / 收起。
- 收起后显示正文预览，而不是只显示类似 `Creating Miku's Animation` 的标题。
- 长摘要在面板内滚动；原正文、图片、文件卡片、工具调用和执行结果继续由 DSH 渲染。
- 模型仍在发送摘要时显示真实等待状态，不伪造逐行代码或工具执行进度。
- 旧会话缺少展示层 provider 字段时，从该步骤之前的请求头读取归属，不用当前模型选择来猜测历史消息。历史窗口缺少归属证据时保持原展示。

本版本**不启用工具参数增量**。Vertex 的 `streamFunctionCallArguments` 会返回 `partialArgs` / `willContinue`；当前 SDK 的 Gemini 模式不接受该开关，pi-ai 0.87.1 也未组装这些增量字段。直接打开可能造成空参数或重复工具调用，因此这里仍使用完整 `functionCall.args`，只改善实际已收到内容的可见性。

已在现有 DSH Web GUI 的旧会话验证完整摘要显示、字符计数、收起正文预览、键盘切换和原文件卡片保留，并完成非 Argon 路由隔离检查。Headless 使用宿主参数修复，不加载 Web 客户端。

## 本地检查

```sh
npm run check
npm pack --dry-run
```

以上是语法和打包检查，不会调用付费 API。真实端到端验收仍需自己的可用凭据与模型权限。Google 的 429 资源配额错误与本插件修复的参数 400 是两类问题。

## 移除

从 profile 删除插件条目，或从 `dsh.profile.bundles` 移除本 bundle，然后重新加载或重启 profile。原生 provider 配置可保留；确认上游已修复参数识别后再卸载。
