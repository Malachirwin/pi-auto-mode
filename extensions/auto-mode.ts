/**
 * pi-auto-mode
 *
 * /auto [on|off] or shift+tab toggles auto mode. While on, an `ask` that reaches the
 * permission system's authorizer chain is resolved here instead of by the human:
 *   1. ask matched by an explicit rule in the user's policy -> deny, classifier never runs
 *   2. ask from the default fallthrough                     -> local OpenAI-compatible classifier
 *   3. classifier unsure / error / timeout                  -> defer (human dialog)
 * `deny` rules are enforced by the permission system before the chain and never reach here.
 *
 * Reaches the permission system through its session-services global (no public hook for this);
 * if that changes, auto mode warns on toggle instead of failing silently.
 * Requires @gotgenes/pi-permission-system >= 40 and `"authorizerChain": ["auto-mode"]`
 * in its config (bin/setup.sh does both).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { classify, type ClassifierConfig, type ComfortLevel, type Verdict as ClassifierVerdict } from "./classifier.js"

const SERVICES_KEY = Symbol.for("@gotgenes/pi-permission-system:session-services")
const LINK_NAME = "auto-mode"

type Verdict = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" }

interface AskDetails {
  toolName?: string
  command?: string
  path?: string
  target?: string
  toolInputPreview?: string
}

interface Query {
  checkPermission(surface: string, value?: string): { state: string; matchedPattern?: string }
}

interface Log {
  review(event: string, details?: Record<string, unknown>): void
}

interface Config {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  rubricExtra: string
  maxConsecutiveDenials: number
  maxUserMessages: number
  classifier: "gemma" | "clef"
  /** Comfort level for the safety rubric. Defaults to "cautious". */
  comfortLevel: ComfortLevel
  /** Used when classifier is "clef"; baseUrl/apiKey default to the top-level ones. */
  clef: { model: string; baseUrl?: string; apiKey?: string }
  /** Start auto mode ON for new sessions. (session-scoped) */
  alwaysOn: boolean
}

const DEFAULTS: Config = {
  baseUrl: "http://127.0.0.1:8001/v1",
  apiKey: "1234",
  model: "gemma-4-26B-A4B-it-qat-nvfp4",
  classifier: "clef",
  comfortLevel: "cautious",
  clef: { model: "clef-flash-oQ4e" },
  timeoutMs: 20000,
  rubricExtra: "",
  maxConsecutiveDenials: 3,
  maxUserMessages: 5,
  alwaysOn: false,
}

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1
const VALIDATORS: { [K in keyof Config]: (v: unknown) => boolean } = {
  baseUrl: (v) => typeof v === "string" && /^https?:\/\//.test(v),
  apiKey: (v) => typeof v === "string",
  model: (v) => typeof v === "string" && v.length > 0,
  timeoutMs: isPosInt,
  rubricExtra: (v) => typeof v === "string",
  maxConsecutiveDenials: isPosInt,
  maxUserMessages: isPosInt,
  classifier: (v) => v === "gemma" || v === "clef",
  comfortLevel: (v) => v === "liberal" || v === "balanced" || v === "cautious",
  alwaysOn: (v) => typeof v === "boolean",
  clef: (v: any) =>
    !!v &&
    typeof v.model === "string" &&
    v.model.length > 0 &&
    (v.baseUrl === undefined || /^https?:\/\//.test(v.baseUrl)) &&
    (v.apiKey === undefined || typeof v.apiKey === "string"),
}

// A repo-local file is untrusted: it must not redirect the classifier endpoint or rewrite its rubric.
const PROJECT_KEYS: (keyof Config)[] = ["timeoutMs", "maxUserMessages"]

function readConfigFile(path: string, allowed: (keyof Config)[], onWarn?: (msg: string) => void): Partial<Config> {
  if (!existsSync(path)) return {}
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"))
  } catch (e: any) {
    onWarn?.(`auto mode: ignoring ${path}: ${e?.message ?? e}`)
    return {}
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!(k in VALIDATORS)) continue
    if (!allowed.includes(k as keyof Config)) {
      onWarn?.(`auto mode: ${path}: '${k}' is only honored in the global config`)
      continue
    }
    if (VALIDATORS[k as keyof Config](v)) out[k] = v
    else onWarn?.(`auto mode: ${path}: invalid value for '${k}'`)
  }
  return out as Partial<Config>
}

/** The classifier endpoint settings for the active classifier (Gemma chat or Clef SystemOne). */
function activeClassifier(cfg: Config, override?: Config["classifier"]): ClassifierConfig {
  const { baseUrl, apiKey, model, timeoutMs, rubricExtra, comfortLevel } = cfg
  if ((override ?? cfg.classifier) === "clef") {
    return { baseUrl, apiKey, timeoutMs, rubricExtra, comfortLevel, ...cfg.clef, backend: "systemone" }
  }
  return { baseUrl, apiKey, model, timeoutMs, rubricExtra, comfortLevel, backend: "chat" }
}

function loadConfig(cwd: string, onWarn?: (msg: string) => void): Config {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent")
  return {
    ...DEFAULTS,
    ...readConfigFile(
      join(agentDir, "extensions/pi-auto-mode/config.json"),
      Object.keys(DEFAULTS) as (keyof Config)[],
      onWarn,
    ),
    ...readConfigFile(join(cwd, ".pi/extensions/pi-auto-mode/config.json"), PROJECT_KEYS, onWarn),
  } as Config
}

function userMessages(ctx: ExtensionContext, max: number): string[] {
  const out: string[] = []
  for (const e of ctx.sessionManager.getBranch() as any[]) {
    if (e.type !== "message" || e.message?.role !== "user") continue
    const c = e.message.content
    const text =
      typeof c === "string"
        ? c
        : (c ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
    if (text.trim()) out.push(text.trim().slice(0, 1500))
  }
  return out.slice(-max)
}

/** Extract known-script files from a bash command so the classifier can inspect them. */
function extractScriptPaths(command: string): string[] {
  // Tokenize on spaces/shell operators, keep only file-like tokens
  const tokens = command.split(/\s+/)
  const seen = new Set<string>()
  const scripts: string[] = []
  const binPath = process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin"

  for (const token of tokens) {
    // Skip paths that look like executables in system dirs
    if (/^\//.test(token)) {
      const abs = resolve(token)
      // Only consider files inside project or cwd (not system bins)
      const cwdAbs = resolve(cwdDir)
      if (abs.startsWith(cwdAbs + "/") || abs.startsWith(cwdAbs)) {
        if (!seen.has(abs)) { scripts.push(abs); seen.add(abs) }
      }
    }
    // Token might be a script with an interpreter prefix, e.g. `python3 myscript.py`
    // The second token could be a script path
  }
  return scripts
}

// Store cwd so extractScriptPaths can resolve relative paths
let cwdDir = ""

/** Read script file contents up to a reasonable size. Returns empty strings for missing/large files. */
function readScripts(paths: string[]): string[] {
  const MAX_BYTES = 16_000
  return paths
    .map((p) => {
      if (!existsSync(p)) return ""
      const raw = readFileSync(p, "utf-8")
      if (raw.length > MAX_BYTES) return raw.slice(0, MAX_BYTES) + "\n[truncated - too large to read in full]"
      return raw
    })
    .filter(Boolean)
}

/** Detects script files in a command string and returns their contents for the classifier. */
function resolveScriptContents(command: string | undefined, cwd: string): string[] {
  if (!command) return []
  cwdDir = cwd
  // Common script invocation patterns
  const scriptExtensions = [".sh", ".bash", ".py", ".js", ".ts", ".rb", ".pl", ".php"]
  const knownInterpreters = new Set(["bash", "sh", "python3", "python", "node", "python", "ruby", "perl", "php"])

  const tokens = command.split(/\s+/)
  const seen = new Set<string>()
  const scripts: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    // Skip shell operators and pipes
    if (/^[|;&$]/.test(tok) || /^\-/.test(tok)) continue

    const abs = resolve(join(cwd, tok))

    // Token itself looks like a script file
    if (scriptExtensions.some((ext) => tok.endsWith(ext))) {
      if (!seen.has(abs)) { scripts.push(abs); seen.add(abs) }
      continue
    }

    // Token is a known interpreter, next token is the script
    if (knownInterpreters.has(tok) && i + 1 < tokens.length) {
      const script = tokens[i + 1]
      if (scriptExtensions.some((ext) => script.endsWith(ext))) {
        const scriptAbs = resolve(join(cwd, script))
        if (!seen.has(scriptAbs)) { scripts.push(scriptAbs); seen.add(scriptAbs) }
      }
    }

    // Token is ./something or ../something without extension — could be a bash script
    if ((tok.startsWith("./") || tok.startsWith("../")) && !tok.includes("/")) {
      for (const ext of ["", ...scriptExtensions]) {
        const candidate = resolve(join(cwd, tok + ext))
        if (existsSync(candidate) && !seen.has(candidate)) {
          scripts.push(candidate); seen.add(candidate); break
        }
      }
    }
  }

  return readScripts(scripts)
}

/** An `ask` caused by an explicit rule in the policy is a stance, not a gap. */
function explicitAsk(query: Query, d: AskDetails): string | undefined {
  const probes: [string, string | undefined][] = [[d.toolName ?? "", d.command ?? d.path ?? d.target]]
  if (d.path) probes.push(["external_directory", d.path], ["path", d.path])
  for (const [surface, value] of probes) {
    if (!surface) continue
    try {
      const r = query.checkPermission(surface, value)
      if (r.state === "ask" && r.matchedPattern && r.matchedPattern !== "*") {
        return `${surface} rule '${r.matchedPattern}'`
      }
    } catch {}
  }
  return undefined
}

export default function (pi: ExtensionAPI) {
  let enabled = false
  let override: Config["classifier"] | undefined // set by `/auto classifier`, lasts for the session
  let comfortLevel: ComfortLevel = "cautious" // set by `/auto on <level>`, lasts for the session
  let consecutiveDenials = 0
  let ctxRef: ExtensionContext | undefined
  const disposers = new Map<string, () => void>() // sessionId -> unregister

  const setStatus = (ctx: ExtensionContext) => ctx.ui?.setStatus("auto-mode", enabled ? "auto" : undefined)

  function register(sessionId: string, service: any): void {
    if (disposers.has(sessionId) || !service?.registerAuthorizer) return
    try {
      disposers.set(sessionId, service.registerAuthorizer(LINK_NAME, authorize))
    } catch (e: any) {
      ctxRef?.ui?.notify(`auto mode: registerAuthorizer failed: ${e?.message ?? e}`, "warning")
    }
  }

  /** Catches sessions whose `permissions:ready` fired before this extension loaded (e.g. after /reload). */
  function registerExisting(): void {
    const services = (globalThis as Record<symbol, unknown>)[SERVICES_KEY] as Map<string, any> | undefined
    for (const [sessionId, service] of services ?? []) register(sessionId, service)
  }

  function toggle(ctx: ExtensionContext, next?: boolean) {
    enabled = next ?? !enabled
    consecutiveDenials = 0
    setStatus(ctx)
    const cfg = loadConfig(ctx.cwd, (m) => ctx.ui?.notify(m, "warning"))
    ctx.ui?.notify(
      `auto mode ${enabled ? "ON" : "OFF"} (classifier: ${activeClassifier(cfg, override).model}, comfort: ${cfg.comfortLevel})`,
      "info",
    )
    if (enabled) {
      registerExisting()
      if (disposers.size === 0) {
        ctx.ui?.notify(
          'auto mode: not linked to @gotgenes/pi-permission-system (>= 40, "authorizerChain": ["auto-mode"]); prompts still go to you',
          "warning",
        )
      }
    }
  }

  async function authorize(d: AskDetails, query: Query, log: Log): Promise<Verdict> {
    const ctx = ctxRef
    if (!enabled || !ctx) return { kind: "defer" }

    const stance = explicitAsk(query, d)
    if (stance) {
      log.review("auto_mode_stance_denied", { rule: stance })
      return { kind: "deny", reason: `Blocked by auto mode: matches ${stance}. Ask the user.` }
    }

    const cfg = loadConfig(ctx.cwd)
    const active = activeClassifier(cfg, override)
    // Merge session-level comfortLevel override (from /auto on <level>)
    const activeWithComfort: ClassifierConfig = {
      ...active,
      comfortLevel: comfortLevel ?? cfg.comfortLevel,
    }
    const summary = d.command ?? d.path ?? d.target ?? d.toolInputPreview ?? "(no detail)"
    // Resolve script file contents for the classifier to inspect
    const scriptContents = resolveScriptContents(d.command, ctx.cwd)
    let verdict: ClassifierVerdict
    try {
      verdict = await classify(activeWithComfort, {
        userMessages: userMessages(ctx, cfg.maxUserMessages),
        toolName: d.toolName ?? "unknown",
        summary,
        cwd: ctx.cwd,
        scriptContents,
      })
    } catch (e: any) {
      verdict = { decision: "escalate", reason: `classifier error: ${e?.name ?? e}` }
    }
    log.review("auto_mode_verdict", { decision: verdict.decision, reason: verdict.reason, model: active.model })

    if (verdict.decision === "allow") return { kind: "allow" }
    if (verdict.decision === "deny") {
      // Not reset by allows: interleaving allowed calls must not let the agent probe forever.
      consecutiveDenials++
      if (consecutiveDenials >= cfg.maxConsecutiveDenials) {
        consecutiveDenials = 0
        ctx.ui?.notify(`auto mode: ${cfg.maxConsecutiveDenials} denials, asking you`, "warning")
        return { kind: "defer" }
      }
      return { kind: "deny", reason: `Blocked by auto mode: ${verdict.reason}` }
    }
    return { kind: "defer" }
  }

  // The service is published per session node; `permissions:ready` may fire more than once.
  pi.events.on("permissions:ready", (data: any) => {
    const sessionId = data?.sessionId as string | undefined
    if (!sessionId) return
    const services = (globalThis as Record<symbol, unknown>)[SERVICES_KEY] as Map<string, any> | undefined
    register(sessionId, services?.get(sessionId))
  })

  pi.registerCommand("auto", {
    description:
      'Auto mode: /auto [on|off] | /auto <level> [on|off] | /auto classifier [gemma|clef]',
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase()
      if (a === "" || a === "on" || a === "off") return toggle(ctx, a === "" ? undefined : a === "on")
      const parts = a.split(/\s+/)
      // /auto <level> — enables auto mode with that comfort level
      if (
        (parts[0] === "liberal" || parts[0] === "balanced" || parts[0] === "cautious") &&
        (parts[1] === undefined || parts[1] === "on" || parts[1] === "off")
      ) {
        const level = parts[0] as ComfortLevel
        const next = parts[1] === "off" ? false : true
        enabled = next
        comfortLevel = level
        consecutiveDenials = 0
        setStatus(ctx)
        const cfg = loadConfig(ctx.cwd, (m) => ctx.ui?.notify(m, "warning"))
        ctx.ui?.notify(
          `auto mode ${enabled ? "ON" : "OFF"} (${level}, classifier: ${activeClassifier(cfg, override).model})`,
          "info",
        )
        if (enabled) {
          registerExisting()
          if (disposers.size === 0) {
            ctx.ui?.notify(
              'auto mode: not linked to @gotgenes/pi-permission-system (>= 40, "authorizerChain": ["auto-mode"]); prompts still go to you',
              "warning",
            )
          }
        }
        return
      }
      const [word, which] = parts
      if (word === "classifier" && (which === undefined || which === "gemma" || which === "clef")) {
        if (which) override = which
        const cfg = loadConfig(ctx.cwd, (m) => ctx.ui?.notify(m, "warning"))
        const c = activeClassifier(cfg, override)
        return ctx.ui?.notify(`auto mode classifier: ${override ?? cfg.classifier} (${c.model})`, "info")
      }
      ctx.ui?.notify(
        "usage: /auto [on|off] | /auto <liberal|balanced|cautious> [on|off] | /auto classifier [gemma|clef]",
        "warning",
      )
    },
  })

  // Same key as Claude Code's mode cycle. Pi's thinking-level cycle is rebound to alt+t
  // in ~/.pi/agent/keybindings.json so this shortcut is free.
  pi.registerShortcut("shift+tab", {
    description: "Toggle auto mode",
    handler: (ctx) => toggle(ctx),
  })

  pi.on("session_start", (_e, ctx) => {
    ctxRef = ctx
    const cfg = loadConfig(ctx.cwd)
    enabled = cfg.alwaysOn ?? false
    comfortLevel = cfg.comfortLevel
    override = undefined
    consecutiveDenials = 0
    setStatus(ctx)
    registerExisting()
  })
  pi.on("session_shutdown", () => {
    for (const dispose of disposers.values()) {
      try {
        dispose()
      } catch {}
    }
    disposers.clear()
    ctxRef = undefined
    enabled = false
  })
}
