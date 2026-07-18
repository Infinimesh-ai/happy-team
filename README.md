<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/.github/logotype-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="/.github/logotype-light.png">
    <img src="/.github/logotype-dark.png" width="400" alt="Happy">
  </picture>
</div>

<h1 align="center">
  Mobile and Web Client for Claude Code, Codex & more
</h1>

<h4 align="center">
Use Claude Code, Codex, Gemini and other coding agents from anywhere with end-to-end encryption.
</h4>

<div align="center">

[📱 **iOS App**](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) • [🤖 **Android App**](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) • [🌐 **Web App**](https://app.happy.engineering) • [🎥 **See a Demo**](https://youtu.be/GCS0OG9QMSE) • [📚 **Documentation**](https://happy.engineering/docs/) • [💬 **Discord**](https://discord.gg/fX9WBAhyfD)

</div>

<img width="5178" height="2364" alt="github" src="/.github/header.png" />

## 🍴 About this fork

This is [Chiiz-PI's fork](https://github.com/Chiiz-PI/happy) of [slopus/happy](https://github.com/slopus/happy). It tracks upstream `main` and adds:

- **Directory browser in the new-session flow** — a Browse section in the path picker, backed by a `machine-list-directory` daemon RPC (read-only, confined to the daemon user's home, with git-repo markers), so you no longer have to type paths by hand.
- **Resume local sessions started outside Happy** — a Conversation picker on the new-session screen lists conversations found in `~/.claude/projects` and `~/.codex/sessions`, and resumes them through the normal spawn path. Discovery is pluggable: a `list-local-sessions` RPC resolves through a provider registry (`claude`/`codex` built in, `registerLocalSessionProvider` for future agents), and agents without a provider simply hide the picker.
- **Grok support (experimental)** — the [`spport-grok-cli`](https://github.com/Chiiz-PI/happy/tree/spport-grok-cli) branch integrates the xAI **Grok Build CLI** as a first-class ACP agent (`happy grok`), including generic ACP fixes for permission handling, token telemetry, session resume, and typewriter streaming. It is kept as a separate branch while the grok CLI itself is still evolving — see that branch's README for details.

Everything else below is the upstream project.

<h3 align="center">
Step 1: Download App
</h3>

<div align="center">
<a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>
</div>

<h3 align="center">
Step 2: Install CLI on your computer
</h3>

```bash
npm install -g happy
```

> Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

<h3 align="center">
Step 3: Start using `happy` instead of your agent CLI
</h3>

```bash
# Instead of claude, use:
happy claude
# or
happy codex
happy gemini
happy agy            # Antigravity CLI
happy acp <agent>    # any ACP-speaking agent (e.g. opencode)
```

## How does it work?

On your computer, run `happy` in front of your agent command (`happy claude`, `happy codex`, …) to start the agent through our wrapper. When you want to control your coding agent from your phone, it restarts the session in remote mode. To switch back to your computer, just press any key on your keyboard.

## 🔥 Why Happy Coder?

- 📱 **Mobile access to your coding agents** - Check what your AI is building while away from your desk
- 🔔 **Push notifications** - Get alerted when your agent needs permission or encounters errors
- ⚡ **Switch devices instantly** - Take control from phone or desktop with one keypress
- 🗂️ **Start sessions remotely** - Spawn new sessions on your machine from the app, browse to the project folder, or resume a conversation you started in the terminal
- 🔐 **End-to-end encrypted** - Your code never leaves your devices unencrypted
- 🛠️ **Open source** - Audit the code yourself. No telemetry, no tracking

## 📦 Project Components

- **[Happy App](packages/happy-app)** - Web UI + mobile client (Expo)
- **[Happy CLI](packages/happy-cli)** - Command-line wrapper for Claude Code, Codex, Gemini and ACP agents
- **[Happy Agent](packages/happy-agent)** - Remote agent control CLI (create, send, monitor sessions)
- **[Happy Server](packages/happy-server)** - Backend server for encrypted sync
- **[Happy Wire](packages/happy-wire)** - Shared session protocol schemas

## 🏠 Who We Are

We're engineers scattered across Bay Area coffee shops and hacker houses, constantly checking how our AI coding agents are progressing on our pet projects during lunch breaks. Happy Coder was born from the frustration of not being able to peek at our AI coding tools building our side hustles while we're away from our keyboards. We believe the best tools come from scratching your own itch and sharing with the community.

## 📚 Documentation & Contributing

- **[Documentation Website](https://happy.engineering/docs/)** - Learn how to use Happy Coder effectively
- **[Contributing Guide](docs/CONTRIBUTING.md)** - How to contribute, PR guidelines, and development setup
- **[Edit docs at github.com/slopus/slopus.github.io](https://github.com/slopus/slopus.github.io)** - Help improve our documentation and guides

## License

MIT License - see [LICENSE](LICENSE) for details.
