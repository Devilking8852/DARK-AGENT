# DARK AGENT

> **MADE BY - @TEAMDARK_OWNER**

Android AI agent client — one APK, your own API key, any OpenAI-compatible provider.
Dark UI, streaming replies, markdown, local chat history.

## Download

Grab the APK from **[Releases](../../releases/latest)**, or from the `build-apk`
workflow artifacts (Actions tab).

Install → allow "install from unknown sources" → open → ⚙ → paste your API key → pick a model.

## Features

- 🌐 **Web search agent** — model calls `web_search` / `open_url` itself, answers with source chips
- 🔑 **Bring your own key** — Venice AI, OpenRouter, Groq, OpenAI, local Ollama, or any compatible endpoint
- ⚡ **Streaming** replies (token by token)
- 🧠 **Model picker** — loads the provider's model list (`/models`)
- 🎛 **System prompt, temperature, max tokens** editable
- 💬 **Chat history** saved on device (`localStorage`, no server)
- 📝 **Markdown** rendering + code blocks, copy & retry buttons
- 🔒 **No backend** — requests go straight from your phone to the provider
- 🧱 Works without CORS problems thanks to a small native HTTP bridge

## Presets

| Provider | Base URL | Notes |
| --- | --- | --- |
| Venice AI | `https://api.venice.ai/api/v1` | credits / VVV stake needed |
| OpenRouter | `https://openrouter.ai/api/v1` | has free models |
| Groq | `https://api.groq.com/openai/v1` | free tier |
| OpenAI | `https://api.openai.com/v1` | paid |
| Ollama | `http://127.0.0.1:11434/v1` | local, e.g. `qwen2.5:0.5b` |

## Build

Building needs the Android SDK, so the real build runs on GitHub Actions:

```sh
git push            # every push builds a debug APK artifact
git tag v1.0.0 && git push --tags   # also publishes a Release with the APK
```

Workflow: [`.github/workflows/build.yml`](.github/workflows/build.yml) — runs node
tests, then `gradle :app:assembleDebug`, then uploads/publishes the APK.

Native code is intentionally tiny:

| File | Role |
| --- | --- |
| `MainActivity.java` | WebView shell (no AndroidX, no Compose) |
| `Bridge.java` | native `POST`/`GET` with streaming lines → `window.__nativeEvent` |
| `assets/index.html` | UI |
| `assets/styles.css` | dark theme |
| `assets/app.js` | chat logic, agent loop, SSE parsing, markdown, history |
| `assets/tools.js` | `web_search` + `open_url` tools, HTML→text, DDG/Wikipedia parsing |

`app.js` and `tools.js` also run under node, so the core is tested without a device:

```sh
node tests/app.test.js
node tests/tools.test.js
```

## Project layout

```
app/src/main/
├── AndroidManifest.xml
├── java/com/teamdark/darkagent/{MainActivity,Bridge}.java
├── res/{values,drawable}
└── assets/{index.html,styles.css,app.js}
tests/app.test.js
.github/workflows/build.yml
```

## Web search

Tap 🌐 in the composer to switch the agent on. Then the model can call two tools:

- `web_search` — DuckDuckGo Lite, falling back to the Wikipedia API
- `open_url` — fetch a page and read it as text (6k chars, scripts stripped)

Up to 4 tool rounds per message. Sources show up as chips under the answer.
No extra API key needed for search — it goes through the native HTTP bridge.

## Troubleshooting

| What you see | Meaning / fix |
| --- | --- |
| `HTTP 402: Insufficient USD or Diem balance` | Venice account has no credits — top up or switch provider |
| `HTTP 401` | wrong API key |
| `HTTP 404` | wrong base URL (a trailing `/v1` is required) or a retired model id — tap **Load** in Settings to list the ones your key can use |
| `empty response` | model returned no text — usually a non-chat model id or a tool-only reply |
| reasoning models show text late | the app also accepts `reasoning_content` deltas |
| model list empty | tap **Load** (needs a valid key); the dropdown shows real ids |
| web tools do nothing | the model doesn't support tool calling — 🌐 needs Venice/Groq/OpenRouter/OpenAI |

Since v1.2.0 the app shows the provider's real error text in the chat bubble
instead of hiding it, so copy that message if you're stuck.

## Limits (honest notes)

- This is a **client**, not a sandbox escape: Android apps can't run shell commands
  or touch other apps' files without root. So it can't behave like a full
  terminal coding agent.
- Web search needs a model that supports tool calling (Venice, Groq, OpenRouter, OpenAI do).
- Answers depend on the model you pick. Provider terms and content rules still apply.
- Debug-signed APK (self-signed). Sideloading is required — it is not on Play Store.

## License

MIT — see [LICENSE](LICENSE).

---

**MADE BY - @TEAMDARK_OWNER**
