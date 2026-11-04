# DARK AGENT

> **MADE BY - @TEAMDARK_OWNER**

Android AI agent client — one APK, your own API key, any OpenAI-compatible provider.
Dark UI, streaming replies, markdown, local chat history — plus a built-in
**image editor**, **music maker** and a **token/credits meter**.

## Download

Grab the APK from **[Releases](../../releases/latest)**, or from the `build-apk`
workflow artifacts (Actions tab).

Install → allow "install from unknown sources" → open → ⚙ → paste your API key → pick a model.

## Features

- 🎨 **Image editor** — load a photo, brightness/contrast/saturation/blur, rotate/flip, brush, text, save as PNG
- 🎵 **Music maker** — 16-step drum + melody sequencer, WebAudio preview, export a real `.wav`
- ✦ **Token meter** — 1000 on first run, 300 daily, 50 per ad, premium codes; 1 token/message, 3 per web round
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
| `assets/app.js` | chat logic, agent loop, tabs, token hooks, SSE parsing, markdown, history |
| `assets/tools.js` | `web_search` + `open_url` tools, HTML→text, DDG/Wikipedia parsing |
| `assets/credits.js` | token ledger (`1000` start, `+300` daily, ads, premium codes) |
| `assets/image.js` | canvas image editor (filters, brush, text, PNG export) |
| `assets/music.js` | step sequencer + WAV encoder (16-bit PCM, no dependencies) |

Every asset except the DOM wiring runs under node, so the core is tested without a device:

```sh
node tests/app.test.js
node tests/tools.test.js
node tests/features.test.js

# optional UI smoke test (boots index.html in jsdom)
npm i --no-save jsdom && node tests/dom.test.js
```

## Project layout

```
app/src/main/
├── AndroidManifest.xml
├── java/com/teamdark/darkagent/{MainActivity,Bridge}.java
├── res/{values,drawable}
└── assets/{index.html,styles.css,app.js,tools.js,credits.js,image.js,music.js}
tests/{app,tools,features}.test.js
.github/workflows/build.yml
```

## Web search

Tap 🌐 in the composer to switch the agent on. Then the model can call two tools:

- `web_search` — DuckDuckGo Lite, falling back to the Wikipedia API
- `open_url` — fetch a page and read it as text (6k chars, scripts stripped)

Up to 4 tool rounds per message. Sources show up as chips under the answer.
No extra API key needed for search — it goes through the native HTTP bridge.

## Tabs

| Tab | What it does |
| --- | --- |
| **Chat** | the agent; 🌐 enables `web_search` / `open_url` |
| **Image** | pick a photo → filters, rotate/flip, brush, text → **Save PNG** (Downloads) |
| **Music** | tap steps, ▶ Play, **Save WAV** (Downloads) |
| **Credits** | balance, 4 premium plans (Buy now → Telegram), daily reward, ad bonus, redeem code, owner panel |

## Premium plans

| Plan | Price | Premium |
| --- | --- | --- |
| 1 month | ₹89 | 30 days |
| 3 months | ₹150 | 90 days |
| 6 months | ₹350 | 180 days |
| 1 year | ₹600 | 365 days |

Each card has a **Buy now** button that opens
**Telegram → [@TEAMDARK_OWNER](https://t.me/TEAMDARK_OWNER)** with the plan
already written in the message, so payment + code happen in one chat. No store,
no card details inside the app. Links go through `Native.openUrl` (system
handler), so the Telegram app opens directly when installed.

Premium = unlimited chat, no token spend (daily + ad rewards still work).

## Redeem panel (owner)

Tap **MADE BY - @TEAMDARK_OWNER** at the bottom of the Credits tab **7 times**,
enter the panel PIN, then:

1. pick a plan, tap **Generate code**
2. **Copy** the code, or **Copy + message** to get a ready-to-paste Telegram text
3. the generated list keeps the last 60 codes

Codes look like `DA-M3-8QKRU-41D96`: plan + random block + signature. They are
checked offline, so no server is needed — but that also means a determined user
who reads `credits.js` could forge one, and a code can be redeemed on more than
one device. Treat this as a shop counter, not a payment vault. Real enforcement
is a backend (see `Limits`).

## Tokens (honest version)

The ledger lives in `localStorage`, so it is a **UX meter, not a paywall** —
anyone with devtools can edit it. Real enforcement needs a server and Play
Billing. Costs: 1 token per message, 3 per web-search round. Rewards: 1000 on
first run, 300 daily, 50 per ad (1 h cooldown). Premium codes:
`TEAMDARK-30` (30 days), `DARKFRIEND-7`, `WELCOME-3` — premium = no token spend.

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
- The APK **cannot build other APKs** on the phone: Android has no JDK/SDK toolchain.
  What is possible is having the app push a repo to GitHub and letting Actions build.
- The token ledger, the redeem codes and the ad screen are local/simulated — see above.

## License

MIT — see [LICENSE](LICENSE).

---

**MADE BY - @TEAMDARK_OWNER**
