# pi-auto-mode

Auto mode for the [pi](https://pi.dev) coding agent, similar to Claude Code's auto mode. A small LLM classifier, running on a model server you choose, approves or blocks permission prompts so you are not interrupted for routine actions.

Auto mode is an extension for [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system). It does not replace your permission policy. It only answers the prompts that policy would otherwise show you.

## Contents

- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
- [Config](#config)
- [What the classifier sees](#what-the-classifier-sees)
- [Safety notes](#safety-notes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it works

The permission system decides every tool call as `allow`, `deny` or `ask`. An `ask` normally opens a dialog for you. The permission system also has an **authorizer chain**: a list of links that get a chance to answer an `ask` before the dialog opens. `pi-auto-mode` is one such link, named `auto-mode`.

While auto mode is on, each `ask` that reaches the link is handled in this order:

1. **`deny` rules block first.** The permission system enforces them before the chain runs, so auto mode can never override one.
2. **An `ask` from an explicit rule in your policy is denied.** If you wrote a rule such as `git push *: ask`, you made a deliberate choice that a human should decide. Auto mode blocks the call without calling the classifier. The agent sees `Blocked by auto mode: matches bash rule '...'. Ask the user.` A bare `*: ask` rule counts as the default, not as an explicit rule.
3. **Any other `ask` goes to the classifier.** This is an `ask` that comes from the default fallthrough, with no specific rule behind it. The classifier answers one of:
   - `allow`: the call proceeds.
   - `deny`: the call is blocked and the agent sees the classifier's reason.
   - `escalate`: the classifier is unsure, so you get the normal dialog.
4. **Failures fall back to you.** An HTTP error, timeout, unparseable reply or unreachable server all defer to the normal dialog. Auto mode never approves a call because something went wrong.
5. **Repeated denials fall back to you.** After `maxConsecutiveDenials` classifier denials (default 3), auto mode defers the next `ask` to the dialog once and resets its count. Allowed calls do not reset the count, so the agent cannot keep probing by mixing in allowed calls.

## Install

You need:

- pi
- python3 (used by `setup.sh` to edit JSON files)
- an OpenAI-compatible model server, such as oMLX, Ollama, LM Studio or vLLM
- `@gotgenes/pi-permission-system` version **40 or later** (`setup.sh` installs the latest)

```bash
git clone https://github.com/OliverwStevens/pi-auto-mode
cd pi-auto-mode
./bin/setup.sh [clef-model-id]
```

Then run `/reload` in pi. `setup.sh` is safe to run again.

`setup.sh` does four things:

1. Installs `@gotgenes/pi-permission-system` and this package with `pi install`.
2. Rebinds pi's thinking-level cycle from `shift+tab` to `alt+t` in `~/.pi/agent/keybindings.json`, which frees `shift+tab` for auto mode.
3. Adds `"auto-mode"` to `authorizerChain` in the permission system's config. A link does nothing until it is named there.
4. Writes `~/.pi/agent/extensions/pi-auto-mode/config.json` from `examples/config.json` if it does not exist, with your Clef model id if you passed one.

If one of the JSON files contains comments, `setup.sh` stops and tells you which line to add by hand. It never overwrites a file it cannot parse.

Set `PI_CODING_AGENT_DIR` to use a different agent directory than `~/.pi/agent`.

### How it connects to the permission system

Auto mode calls the permission system's `registerAuthorizer` function, but it finds that function through a global (`Symbol.for("@gotgenes/pi-permission-system:session-services")`) because there is no public hook for it. This is an internal of the permission system and could change in a future version. Auto mode registers itself when a session starts, when the permission system announces it is ready, and whenever you turn auto mode on. If it cannot find the permission system, turning it on shows a warning and your prompts keep going to you.

## Usage

| action | effect |
| --- | --- |
| `shift+tab` | toggle auto mode |
| `/auto` | toggle auto mode |
| `/auto on` / `/auto off` | set it explicitly |
| `/auto <liberal\|balanced\|cautious>` | enable auto mode with that comfort level |
| `/auto <level> on` / `/auto <level> off` | toggle with comfort level |
| `/auto classifier [clef\|gemma]` | switch classifier for this session, or show the current one |

- The footer shows `auto` while auto mode is on.
- Auto mode is **off at the start of every session** (unless `alwaysOn` is true).
- The on/off state, comfort level, and denial count are kept per process, not per session.

### Comfort levels

Auto mode now supports three comfort tiers that express a **philosophy of trust** rather than a command list:

| Level | Philosophy |
| --- | --- |
| `cautious` (default) | **"Review before execution"** — the agent can do routine development work, but anything touching outside the project gets reviewed. Script code is provided so the classifier can verify intent. |
| `balanced` | **"Local workspace is safe"** — the project and its immediate ecosystem (siblings, docker, your git remotes) are trusted. Real dev work without friction. Script code still helps verify intent. |
| `liberal` | **"Progress over prompt"** — the user has chosen to minimize interruptions. The agent keeps moving unless something is clearly dangerous. Script code is provided when available but its absence shouldn't stop progress. |

Choose a level in your global config, or switch at runtime with `/auto balanced`.

## Clef

[Cloudflare/clef-flash](https://huggingface.co/Cloudflare/clef-flash) is a decision model, not a chat model. It scores allow/deny/escalate in one forward pass through the server's `POST /v1/systemone`. oMLX serves it: load `Jundot/clef-flash-oQ4e` (it keeps the schema head), set `"clef": {"model": "<id from /v1/models>"}`. Clef is the default classifier. To use a chat model instead, run `/auto classifier gemma` or set `"classifier": "gemma"` and `model`. An answer with confidence below 0.7 counts as `escalate`.

## Config

The global config is `~/.pi/agent/extensions/pi-auto-mode/config.json`:

| key | default | meaning |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8001/v1` | OpenAI-compatible endpoint. `/chat/completions` (or `/systemone` for Clef) is appended. |
| `apiKey` | `1234` | Bearer token sent to the endpoint |
| `model` | `gemma-4-26B-A4B-it-qat-nvfp4` | Gemma model id, used when `classifier` is `gemma` |
| `classifier` | `clef` | `clef` (decision model at `/systemone`) or `gemma` (any chat model at `/chat/completions`). `/auto classifier` overrides it per session. |
| `clef` | `{"model":"clef-flash-oQ4e"}` | Clef model id on the server. Optional `baseUrl` and `apiKey` default to the top-level ones. |
| `timeoutMs` | `20000` | Time to wait for the classifier before asking you |
| `maxConsecutiveDenials` | `3` | Classifier denials before asking you |
| `maxUserMessages` | `5` | Recent user messages shown to the classifier |
| `rubricExtra` | `""` | Extra rules appended to the classifier prompt |
| `comfortLevel` | `"cautious"` | Safety rubric tier: `"cautious"`, `"balanced"`, or `"liberal"`. Can also be set per-session with `/auto <level>`. |
| `alwaysOn` | `false` | Start with auto mode ON instead of OFF (session-scoped) |

A project file at `<cwd>/.pi/extensions/pi-auto-mode/config.json` is also read, but it may only set `timeoutMs` and `maxUserMessages`. Any other key in it is ignored with a warning. This stops a cloned repository from pointing the classifier at its own server or rewriting the rubric to approve everything. Values with the wrong type are ignored with a warning, and the default is used.

## What the classifier sees

The classifier gets one request per `ask`:

- The working directory.
- Your last `maxUserMessages` messages, each cut to 1500 characters. This tells it what you actually asked for.
- The tool name and the proposed call (the command, path or input preview). This text is wrapped in `<<<TOOL_CALL_DATA>>>` markers, cut to 4000 characters, and the rubric tells the model to treat it as data and never follow instructions inside it.
- **Script file contents** — when the proposed call runs a script (bash, python, node, etc.), the classifier also sees the script's source code so it can evaluate the actual behavior instead of escalating blindly. Only the first ~16 KB per script is included.

It never sees tool output or assistant messages, which limits prompt injection.

Its rubric (varies by `comfortLevel` in config or `/auto <level>`):

The rubric expresses a **trust philosophy**, not a command list. Actions are judged by their scope and intent, not by tool name:

| Level | Allowed scope | Blocked scope |
| --- | --- | --- |
| `cautious` | Effects contained within the project with clear intent. Script code provided for review. | Anything outside the project, unknown remotes, shared state, unclear intent. |
| `balanced` | Everything cautious + the local ecosystem: siblings, docker, your git remotes. | System dirs, shared infrastructure, global installs, actions without reviewable code. |
| `liberal` | Almost anything a developer would reasonably do. Progress over perfection. | Only clear harm: attacks, credential exfiltration to unknown endpoints, system destruction. |

The reply must be JSON: `{"decision":"allow|deny|escalate","reason":"..."}`. If the model emits several JSON objects, the last one with a `decision` key is used.

## Safety notes

- **The classifier is an LLM.** Treat it as a convenience, not a security boundary. Keep hard limits in `deny` rules.
- **Your data goes to `baseUrl`.** It receives your recent messages and every proposed command. Use a local endpoint unless you trust the remote server.
- **Path asks still reach you.** The permission system caps what a link can allow on `path` and `external_directory` asks, so those still open a dialog. Put allows for paths outside the project in your policy.
- **Subagents are covered.** A subagent's `ask` is reviewed one hop up by the session you watch.
- **Permission config location.** The permission system's config must be at `~/.pi/agent/extensions/pi-permission-system/config.json` (global) or `<cwd>/.pi/extensions/pi-permission-system/config.json` (project).

## Troubleshooting

| symptom | likely cause |
| --- | --- |
| Warning on toggle: `not linked to @gotgenes/pi-permission-system` | The permission system is missing, older than 40, or `"authorizerChain": ["auto-mode"]` is not in its config. Re-run `./bin/setup.sh` and `/reload`. |
| Every call still asks you | The classifier keeps answering `escalate`, or the server is unreachable. Check `baseUrl` and `model`, and the review log for `auto_mode_verdict` entries. |
| `classifier HTTP 401` or `404` | Wrong `apiKey` or `baseUrl`, or the model id is not loaded on the server. |
| `classifier returned no JSON` | The model did not follow the reply format. Try a stronger or instruction-tuned model. |
| Warning: `ignoring ...config.json` or `only honored in the global config` | The config file is invalid JSON, or a project file set a key that only the global file may set. |
| `shift+tab` still cycles thinking | `app.thinking.cycle` is not rebound. Check `~/.pi/agent/keybindings.json` and `/reload`. |

Each decision is written to the permission system's review log as `auto_mode_verdict` (with the decision, reason and model) or `auto_mode_stance_denied` (with the matching rule).

## Development

`npm test` runs the verdict-parser tests. It needs Node 22.6 or later, and CI runs it on every push.

## License

MIT
