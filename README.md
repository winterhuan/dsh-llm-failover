# @winterhuan/dsh-llm-failover

English | [中文](README.zh.md)

A DeepSeek Harness plugin that routes a conversation request through an ordered model group. A group may contain different models from one provider and models from different providers. When an eligible request failure occurs, the plugin tries the next target in the same Agent Loop step.

## Install

The package is not yet published to npm. Develop it inside a DeepSeek Harness source checkout so its TypeScript references resolve, then install the built directory into the Web profile:

```sh
# From a DeepSeek Harness checkout that contains this repository at custom-plugins/dsh-llm-failover:
pnpm --dir custom-plugins/dsh-llm-failover run build
pnpm dsh plugin --profile web add ./custom-plugins/dsh-llm-failover
pnpm dsh --profile web web
```

After publication, the npm form is:

```sh
dsh plugin --profile web add @winterhuan/dsh-llm-failover
dsh --profile web web
```

The bundle installs one host row and one browser plugin. Open **Settings → Model failover** to configure groups.

## Configuration

The plugin registers the `llm-failover` Settings namespace. The Web UI writes this section without a restart. A step that has already entered failover keeps the group state selected for that step; a saved configuration affects subsequent request steps.

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
      retryableCodes:
        - EMPTY_RESPONSE
        - RATE_LIMIT
        - SERVER
        - TIMEOUT
        - TRANSPORT
```

Each group needs at least two distinct `{ provider, model }` targets. `activeGroup` selects the group for Agent Loop conversation requests. Omit it to leave normal model selection unchanged. The default eligible codes are `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`.

Every referenced provider must already be configured and live in DSH. This plugin never stores credentials or creates provider routes.

## Recovery order

`dsh-llm-failover` calls the `agent/request-error` downstream first. A downstream `{ kind: 'retry' }` wins, so composition order decides whether a provider retry or compaction policy runs before failover. If no downstream listener retries and the error code is eligible, failover selects the next group target. The final target's failure is returned to the Agent Loop.

Each successful switch appends a non-surface `llm/failover` session event containing its group, source route, destination route, and provider-neutral failure. It is not sent to the model. Failed partial output remains excluded from the derived message history by the Agent Loop.

## Web UI

The settings page supports adding groups, choosing the active group, arranging targets in order, editing provider/model pairs, and controlling the failure-code list. Save uses the host Settings revision, so a conflicting external edit is rejected rather than overwritten.

## Model Experience

None, as this plugin only changes provider routing after a failed model request; its events and settings UI do not enter model context.

#### KV Cache effect

A same-provider retry may retain provider cache eligibility. A failover target is a new provider/model request and cache reuse follows that target's provider rules.

## Limitations

- **No health circuit breaker** — a group advances only after an individual request fails; it does not suppress a target globally after a failure.
- **No capability negotiation** — operators must order only targets compatible with their prompt modality, tools, reasoning settings, and context needs.
- **One active group** — the initial release applies one selected group to conversation requests rather than offering per-agent or per-purpose group selection.
