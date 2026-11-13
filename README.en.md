# Magpie Doubao Work Plugin · 豆包工作插件

[简体中文](README.md)

`magpie-doubao-work` adds the `doubaowork` provider to Magpie on Windows, Linux and macOS. It supports browser sign-in, account JSON import, account model discovery, text chat, streaming, quota readings and daily check-in.

## Install

Install a recent version of [Magpie](https://github.com/yetone/magpie), then run the following commands.

```sh
magpie plugin add github:3294798852/magpie-doubao-work
magpie plugin login doubaowork
```

You can also find it in Magpie's Plugins → Discover page. The provider is named “豆包工作 Doubao Work”. Select `doubaowork/<model-id>` using an ID from your account's model list.

## Search names and keywords

Both English and Chinese interfaces can find these names, aliases and phrases.

| Purpose | Search terms |
| --- | --- |
| Chinese names | `豆包`, `豆包工作`, `豆包插件`, `豆包工作插件` |
| English names | `Doubao`, `Doubao Work`, `Doubao Work Plugin` |
| Package identifiers | `magpie-doubao-work`, `doubao-work`, `doubaowork` |
| Provider | `Magpie provider plugin`, `provider plugin`, `供应商插件`, `Magpie 豆包工作` |
| Sign-in and import | `browser login`, `浏览器登录`, `JSON`, `导入` |
| Text and streaming | `OpenAI`, `text chat`, `SSE`, `streaming`, `流式` |
| Usage and rewards | `quotas`, `额度`, `daily check-in`, `自动签到` |
| Platforms | `Windows`, `Linux`, `macOS` |

The repository description, README, GitHub topics and package keywords carry bilingual search information. The plugin name and both localized summaries include the terms above and are tested against Magpie's actual search rule. Magpie currently matches contiguous phrases. Use one of the phrases above. Its discovery list reads repositories with the `magpie-plugin` topic, and refreshed listings use the current metadata.

## Sign-in and accounts

A graphical desktop needs Chrome or Edge. Chromium is supported on Linux. Sign-in opens a dedicated temporary browser session. After you complete the official login, the plugin verifies the account identity and lets Magpie store it.

On headless Linux, export an account JSON from the [standalone Doubao Work gateway](https://github.com/3294798852/doubao-work-gateway), then import it.

```sh
magpie accounts import doubaowork /absolute/path/doubao-accounts.json --yes
```

The plugin accepts v2/v3 account backups, with up to 20 accounts and 512 KB per file. Backups contain credentials and belong in a private directory. Set `DW_CHROME_BIN` or `DW_EDGE_BIN` in Magpie's launch environment to use a custom absolute browser path.

Magpie manages account switches, proxies, routing and check-in scheduling. Before claiming a daily reward, the plugin persists the submission state. Later attempts query the upstream result when a claim is still unconfirmed.

An account that requires official verification is paused. Complete verification on Doubao's website with the same account, then sign in to that account again in Magpie.

## Move from the gateway's bundled plugin

After installing this repository, users of the previous repository can select it to serve `doubaowork`.

```sh
magpie plugin add github:3294798852/magpie-doubao-work
magpie plugin use github:3294798852/magpie-doubao-work doubaowork
```

Check accounts and models on Magpie's provider page. The standalone gateway and its releases are maintained in [doubao-work-gateway](https://github.com/3294798852/doubao-work-gateway).

## Capabilities and verification

The plugin serves OpenAI-style text `chat/completions`, streaming and non-streaming responses, and upstream `reasoning_content`. Cancellation aborts the upstream request. Streaming follows consumer backpressure.

Tool calls, structured output, images and workflows remain pending. Context and output limits also need upstream metadata. Live account login, model requests and reward claims require validation by an account holder.

To verify a source checkout, use Node.js 22 or newer and run the following commands.

```sh
npm run check
npm test
```

For the real Magpie Bun-host smoke test, set `MAGPIE_BUN_BIN` and `MAGPIE_HOST_FILE` to Bun and Magpie's `internal/plugin/host.js`, then run `npm run test:magpie-host`. See the [verification record](docs/verification.md) for results and search coverage.

## Source and license

The plugin was extracted from [doubao-work-gateway v0.5.0](https://github.com/3294798852/doubao-work-gateway/tree/v0.5.0). Original Magpie integration uses MIT. Inherited code and brand assets retain their upstream provenance and declarations. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
