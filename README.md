# dsh-pi-ai-argon-fix

DeepSeek Harness 的 Gemini 4 Argon 原生 Google / Vertex 协议兼容补丁。

只修复 `thinkingBudget` 与 `thinkingLevel` 的选择，不改 DSH 核心、不转换成 OpenAI 协议、不接管工具调用和签名处理。零运行时依赖，许可证 MIT。

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
dsh plugin --profile web add github:Anonymousnake/dsh-pi-ai-argon-fix#v0.1.0
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

## 本地检查

```sh
npm run check
npm pack --dry-run
```

以上是语法和打包检查，不会调用付费 API。真实端到端验收仍需自己的可用凭据与模型权限。Google 的 429 资源配额错误与本插件修复的参数 400 是两类问题。

## 移除

从 profile 删除插件条目，或从 `dsh.profile.bundles` 移除本 bundle，然后重新加载或重启 profile。原生 provider 配置可保留；确认上游已修复参数识别后再卸载。
