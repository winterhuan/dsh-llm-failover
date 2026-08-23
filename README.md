# @winterchenhuan/dsh-llm-failover

English | [中文](README.zh.md)

A DeepSeek Harness plugin that routes a conversation request through an ordered model group. A group may contain different models from one provider and models from different providers. When an eligible request failure occurs, the plugin tries the next target in the same Agent Loop step.

## Install

The package is not yet published to npm. Develop it inside a DeepSeek Harness source checkout so its TypeScript references resolve, then install the built directory into the Web profile:

```sh
pnpm --dir custom-plugins/dsh-llm-failover run build
pnpm dsh plugin --profile web add ./custom-plugins/dsh-llm-failover
pnpm dsh --profile web web
```

After publication, the npm form is:

```sh
dsh plugin --profile web add @winterchenhuan/dsh-llm-failover
dsh --profile web web
```

The bundle installs one host row and one browser plugin. Open **Settings → Model failover** to configure groups. Every configured group also appears under the **模型组** provider in the conversation model selector, where it can be selected per session.

## Configuration

The plugin registers the `llm-failover` Settings namespace and reads or writes it through a plugin-owned same-origin Host endpoint. This does not depend on the Harness `settings.describe` built-in namespace allowlist and requires no Harness change. The Web UI writes this section without a restart. A step that has already entered failover keeps the group state selected for that step; a saved configuration affects subsequent request steps.

```yaml
llm-failover:
  activeGroup: production
  groups:
    - id: production
      targets:
        - provider: deepseek-official
          model: deepseek-v4-pro
          retryCount: 2
        - provider: deepseek-official
          model: deepseek-v4-flash
          retryCount: 1
        - provider: openai-gateway
          model: gpt-4.1-mini
          retryCount: 0
      retryableCodes:
        - EMPTY_RESPONSE
        - RATE_LIMIT
        - SERVER
        - TIMEOUT
        - TRANSPORT
```

Each group needs at least two distinct `{ provider, model }` targets. A target's non-negative `retryCount` is the number of additional attempts on that same route after its first eligible failure; omission defaults to `0`, preserving immediate failover. The conversation model selector lists every group under the **模型组** provider, and that choice applies to the selected session. `activeGroup` remains a global default when no group is explicitly selected; omit it to leave normal model selection unchanged. The default eligible codes are `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`.

Every referenced provider must already be configured and live in DSH. This plugin never stores credentials or creates provider routes.

## Recovery order

`dsh-llm-failover` calls the `agent/request-error` downstream first. A downstream `{ kind: 'retry' }` wins, so composition order decides whether a provider retry or compaction policy runs before this plugin. If no downstream listener retries and the error code is eligible, the plugin consumes the current target's remaining `retryCount`; after those retries it selects the next group target. The final target's exhausted failure is returned to the Agent Loop.

Each successful switch appends a non-surface `llm/failover` session event containing its group, source route, destination route, and provider-neutral failure. It is not sent to the model. Failed partial output remains excluded from the derived message history by the Agent Loop.

## Web UI

The settings page loads provider and model catalogs from the Host. The provider dropdown includes only currently active routes, the model dropdown follows the selected provider, and each target has an editable retry count. Retryable errors use a multi-select dropdown; when omitted, the default set is displayed and selected. The page also supports adding groups, choosing the active group, and arranging targets with the up/down buttons beside each row. The header shows an unsaved-changes chip, saves are gated by inline validation against the host rules, and a Discard control restores the last saved snapshot. Save uses the host Settings revision, so a conflicting external edit is rejected rather than overwritten.

## Model Experience

None, as this plugin only changes provider routing after a failed model request; its events and settings UI do not enter model context.

#### KV Cache effect

A same-provider retry may retain provider cache eligibility. A failover target is a new provider/model request and cache reuse follows that target's provider rules.

## Limitations

- **No health circuit breaker** — a group advances only after an individual request fails; it does not suppress a target globally after a failure.
- **No capability negotiation** — operators must order only targets compatible with their prompt modality, tools, reasoning settings, and context needs.
- **One active group** — the initial release applies one selected group to conversation requests rather than offering per-agent or per-purpose group selection.
