import { Effect, Option } from "effect"
import { Account } from "@/account/account"
import { Global } from "@opencode-ai/core/global"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import path from "path"
import fs from "fs/promises"

interface RemoteModel {
  id: string
  label: string
  thinking: boolean
  minTier: string
  allowed: boolean
}

interface ModelsResponse {
  tier: string
  default: string
  models: RemoteModel[]
}

/**
 * Writes an opencode provider entry pointing at the Nolan OpenAI-compatible
 * gateway, so `opencode run` and the full TUI can drive Nolan models with
 * tools, streaming, agent loops — everything you get with the default flow.
 *
 * Config file: $XDG_CONFIG_HOME/opencode/opencode.json (merged with any
 * existing config, only the `provider.nolan` key is overwritten).
 */
const setupEffect = Effect.fn("nolan.setup")(function* () {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (Option.isNone(active)) return yield* fail("Not logged in. Run: nolan login")
  const account = active.value

  const tokenOpt = yield* service.token(account.id)
  if (Option.isNone(tokenOpt)) return yield* fail("No access token. Re-run: nolan login")
  const token = tokenOpt.value as unknown as string

  // Fetch the user's allowed models from the live server.
  const res = yield* Effect.tryPromise({
    try: () =>
      fetch(`${account.url}/api/cli/models`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      }),
    catch: (e) => new Error(`Failed to reach ${account.url}: ${String(e)}`),
  })

  if (!res.ok) {
    return yield* fail(`Could not fetch models: HTTP ${res.status}`)
  }

  const data = (yield* Effect.tryPromise({
    try: () => res.json(),
    catch: (e) => new Error(`Bad models response: ${String(e)}`),
  })) as ModelsResponse

  if (data.models.length === 0) {
    return yield* fail("Server returned no models. Check the Nolan backend.")
  }

  // Write every model the server knows about, not only the ones the current
  // tier can run. Locked models still show up in the picker; the server
  // returns 429 limit_reached if the user picks one they can't access.
  const models: Record<string, Record<string, unknown>> = {}
  for (const m of data.models) {
    const lockedSuffix = m.allowed ? "" : " (upgrade)"
    models[m.id] = {
      name: `${m.label}${lockedSuffix}`,
      tool_call: true,
      reasoning: m.thinking,
      limit: { context: 128_000, output: 8_000 },
    }
  }
  const allowed = data.models.filter((m) => m.allowed)

  const provider = {
    name: "Nolan",
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: `${account.url}/v1`,
      apiKey: token,
    },
    models,
  }

  const configPath = path.join(Global.Path.config, "opencode.json")

  let existing: Record<string, unknown> = {}
  const raw = yield* Effect.tryPromise({
    try: () => fs.readFile(configPath, "utf8"),
    catch: () => new Error("not_found"),
  }).pipe(Effect.orElseSucceed(() => ""))
  if (raw) {
    try {
      existing = JSON.parse(raw)
    } catch {
      // malformed config — overwrite from scratch
      existing = {}
    }
  }

  const providerMap = ((existing as Record<string, unknown>)["provider"] as Record<string, unknown>) ?? {}
  providerMap["nolan"] = provider
  ;(existing as Record<string, unknown>)["provider"] = providerMap

  // Strip every other provider from the picker — Nolan only.
  ;(existing as Record<string, unknown>)["enabled_providers"] = ["nolan"]

  // Pick the fastest Nolan model the user's tier can actually run, prefer
  // flash, skip preview/exp/thinking variants.
  const isPreview = (id: string) => /preview|beta|exp\b/i.test(id)
  const fast =
    allowed.find((m) => /flash/i.test(m.id) && !m.thinking && !isPreview(m.id)) ??
    allowed.find((m) => !m.thinking && !isPreview(m.id)) ??
    allowed[0]
  const reasoning =
    allowed.find((m) => m.thinking && !isPreview(m.id)) ?? fast

  if (fast) {
    const fastRef = `nolan/${fast.id}`
    const reasoningRef = reasoning ? `nolan/${reasoning.id}` : fastRef

    // Point every built-in agent at a Nolan model so opencode never falls
    // back to anthropic/openai catalog models for plan/build/small.
    const agent = ((existing as Record<string, unknown>)["agent"] as Record<string, unknown>) ?? {}
    for (const name of ["build", "plan", "small", "general"]) {
      const current = (agent[name] as Record<string, unknown> | undefined) ?? {}
      agent[name] = { ...current, model: name === "plan" ? reasoningRef : fastRef }
    }
    ;(existing as Record<string, unknown>)["agent"] = agent
  }

  if (fast && !existing["model"]) {
    existing["model"] = `nolan/${fast.id}`
  }

  yield* Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 })
    },
    catch: (e) => new Error(`Failed to write ${configPath}: ${String(e)}`),
  })

  yield* Effect.sync(() => {
    UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} Configured Nolan provider`)
    UI.println(`${UI.Style.TEXT_DIM}  ${configPath}${UI.Style.TEXT_NORMAL}`)
    UI.println(`${UI.Style.TEXT_DIM}  ${allowed.length} models on tier '${data.tier}'${UI.Style.TEXT_NORMAL}`)
    if (existing["model"]) {
      UI.println(`${UI.Style.TEXT_DIM}  Default model: ${existing["model"]}${UI.Style.TEXT_NORMAL}`)
    }
    UI.empty()
    UI.println("Try it:")
    UI.println(`  ${UI.Style.TEXT_HIGHLIGHT}opencode run "hello"${UI.Style.TEXT_NORMAL}`)
    UI.println(`  ${UI.Style.TEXT_HIGHLIGHT}opencode${UI.Style.TEXT_NORMAL}        ${UI.Style.TEXT_DIM}# full TUI${UI.Style.TEXT_NORMAL}`)
  })
})

export const SetupCommand = effectCmd({
  command: "setup",
  describe: "configure opencode to use your Nolan account & models",
  instance: false,
  handler: Effect.fn("Cli.nolan.setup")(function* () {
    UI.empty()
    yield* Prompt.intro("Set up Nolan provider")
    yield* Effect.orDie(setupEffect())
  }),
})
