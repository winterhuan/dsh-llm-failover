# @winterhuan/dsh-llm-failover

[English](README.md) | 中文

这是一个 DeepSeek Harness 插件，用于把一次会话模型请求按顺序路由到模型组中的目标。组内可以同时包含同一 provider 的不同模型，以及不同 provider 的模型。当请求发生可切换错误时，插件会在同一个 Agent Loop step 中尝试下一个目标。

## 安装

该包尚未发布到 npm。开发时需要放在 DeepSeek Harness 源码 checkout 的 `custom-plugins/dsh-llm-failover` 路径，使 TypeScript reference 能够解析，然后把构建后的目录安装到 Web profile：

```sh
pnpm --dir custom-plugins/dsh-llm-failover run build
pnpm dsh plugin --profile web add ./custom-plugins/dsh-llm-failover
pnpm dsh --profile web web
```

发布 npm 后可直接使用：

```sh
dsh plugin --profile web add @winterhuan/dsh-llm-failover
dsh --profile web web
```

安装 bundle 后会同时加载 Host 路由插件和浏览器设置插件。打开 **设置 → 模型故障切换** 即可配置。

## 配置

插件注册 `llm-failover` Settings namespace。Web 界面写入该段配置，无需重启即可生效。已经进入 failover 的 step 会继续使用该 step 选定的组状态；保存后的配置影响后续请求 step。

```yaml
llm-failover:
  activeGroup: production
  groups:
    - id: production
      targets:
        - provider: deepseek-official
          model: deepseek-v4-pro
        - provider: deepseek-official
          model: deepseek-v4-flash
        - provider: openai-gateway
          model: gpt-4.1-mini
      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
```

每个组至少需要两个不同的 `{ provider, model }` 目标。`activeGroup` 选择会话请求使用的模型组；省略它会保留 DSH 原有模型选择。默认可切换错误码为 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`。

所有 provider 必须先由 DSH 的 adapter 配置并处于可用状态。本插件不保存凭据，也不创建 provider route。

## 恢复顺序

插件会先调用 `agent/request-error` 下游 listener。下游返回 `{ kind: 'retry' }` 时优先采用该决定，因此 composition 顺序决定 provider retry 或 compaction 是否先于 failover 执行。没有下游 retry 且错误码允许切换时，插件选择组内下一个 target；最后一个 target 失败时，将失败返回给 Agent Loop。

每次成功切换都会写入不进入模型上下文的 `llm/failover` session event，其中包括模型组、来源 route、目标 route 和 provider-neutral failure。Agent Loop 仍会排除失败的部分输出。

## Web 界面

设置页支持添加模型组、选择当前组、按顺序编辑 targets、设置 provider/model，以及控制可切换错误码。保存使用 Host Settings revision；外部配置被同时修改时会拒绝覆盖。

## 模型体验

无。本插件只在模型请求失败后改变 provider 路由；设置界面和事件不会进入模型上下文。

#### KV Cache 影响

同 provider 的 retry 仍可能复用该 provider 的 cache。切换到新 provider/model 后，cache 复用遵循目标 provider 的规则。

## 限制

- **没有全局熔断器**：每次请求独立触发切换，不会因为一次失败全局禁用某个 target。
- **没有能力协商**：操作者需要确保组内 target 与 prompt modality、工具、推理参数和上下文需求兼容。
- **一个当前模型组**：首版对会话请求使用一个选中的组，不提供按 agent 或 purpose 分组选择。
