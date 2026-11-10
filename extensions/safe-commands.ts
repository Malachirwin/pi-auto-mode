import type { ComfortLevel } from "./classifier.js"

/**
 * Commands simple enough to approve without asking the classifier. Every segment of the
 * command must be on the list for the level; anything the parser is unsure of (substitutions,
 * redirects, quoting it splits wrongly) falls through to the classifier, never to allow.
 */

// Read-only inspection: no writes, no network, no running project code.
const READ_ONLY = new Set([
  "cd", "pwd", "ls", "tree", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag",
  "file", "stat", "du", "df", "diff", "cmp", "cut", "tr", "nl", "jq", "basename", "dirname",
  "realpath", "readlink", "which", "type", "echo", "printf", "date", "whoami", "uname", "true",
])
const GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show", "blame", "branch", "rev-parse", "ls-files", "describe", "shortlog", "remote",
])

// Undoable bookkeeping inside the project, trusted at every level.
const LOCAL_EDITS = new Set(["mkdir", "touch"])
const GIT_LOCAL = new Set(["add", "commit", "switch", "stash", "fetch"])

// Runs the project's own code, so cautious leaves these to the classifier.
const TASK_RUNNERS: Record<string, Set<string>> = {
  npm: new Set(["test", "run", "ls", "outdated"]),
  pnpm: new Set(["test", "run", "ls", "outdated"]),
  yarn: new Set(["test", "run"]),
  bun: new Set(["test", "run"]),
  cargo: new Set(["build", "check", "test", "clippy", "fmt"]),
  go: new Set(["build", "test", "vet"]),
}
const TEST_TOOLS = new Set(["pytest", "rspec", "tsc", "eslint", "rubocop"])

// Credential stores and secrets: reading these sends them to the model, so the classifier decides.
const SENSITIVE = /(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.env\b|id_rsa|id_ed25519|credentials|keychain|secrets?\b)/i

export function isSafeCommand(command: string, level: ComfortLevel): boolean {
  if (/[`\n]|\$\(|<\(|>\(|<</.test(command) || SENSITIVE.test(command)) return false
  // Redirects are only safe when they go nowhere.
  const stripped = command.replace(/\s*(2>&1|[12]?>\s*\/dev\/null)/g, "")
  if (/[<>]/.test(stripped)) return false

  const segments = stripped.split(/&&|\|\||[;|&]/).map((s) => s.trim())
  return segments.every((s) => s !== "" && isSafeSegment(s.split(/\s+/), level))
}

function isSafeSegment([cmd, ...args]: string[], level: ComfortLevel): boolean {
  if (cmd === "find") return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint)/.test(a))
  if (cmd === "sort") return !args.some((a) => a.startsWith("-o") || a.startsWith("--output"))
  if (READ_ONLY.has(cmd)) return true
  if (cmd === "git") return isSafeGit(args)
  if (LOCAL_EDITS.has(cmd)) return true
  if (level === "cautious") return false
  if (TEST_TOOLS.has(cmd)) return true
  if (cmd === "bundle") return args[0] === "exec" && TEST_TOOLS.has(args[1])
  return TASK_RUNNERS[cmd]?.has(args[0]) ?? false
}

function isSafeGit([sub, ...args]: string[]): boolean {
  // `--output` writes files; `--ext-diff` runs a configured program.
  if (args.some((a) => a.startsWith("--output") || a === "--ext-diff")) return false
  if (sub === "branch") return args.every((a) => /^(-a|-r|-v|-vv|--list|--all|--show-current)$/.test(a))
  if (sub === "remote") return args.every((a) => a === "-v" || a === "show")
  if (sub === "stash") return args.length === 0 || ["list", "show", "push"].includes(args[0])
  if (GIT_READ_ONLY.has(sub)) return true
  return GIT_LOCAL.has(sub)
}
