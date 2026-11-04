# DARK AGENT

> **MADE BY - @TEAMDARK_OWNER**

Android AI agent client — one APK, your own API key, any OpenAI-compatible provider.
Dark UI, streaming replies, markdown, local chat history.

## Download

Grab the APK from **[Releases](../../releases/latest)**, or from the `build-apk`
workflow artifacts (Actions tab).

Install → allow "install from unknown sources" → open → ⚙ → paste your API key → pick a model.

## Features

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
| `Bridge.java` | native `POST` with streaming lines → `window.__nativeEvent` |
| `assets/index.html` | UI |
| `assets/styles.css` | dark theme |
| `assets/app.js` | chat logic, SSE parsing, markdown, history |

`app.js` also runs under node, so the core is tested without a device:

```sh
node tests/app.test.js
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

## Limits (honest notes)

- This is a **client**, not a sandbox escape: Android apps can't run shell commands
  or touch other apps' files without root. So it can't behave like a full
  terminal coding agent.
- Answers depend on the model you pick. Provider terms and content rules still apply.
- Debug-signed APK (self-signed). Sideloading is required — it is not on Play Store.

## License

MIT — see [LICENSE](LICENSE).

---

**MADE BY - @TEAMDARK_OWNER**
