import { Effect, Option } from "effect"
import { Account } from "@/account/account"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"

interface ServerEvent {
  type: "text" | "reasoning" | "error"
  text?: string
  message?: string
}

/**
 * Minimal one-shot chat against `${server}/api/chat` using the stored
 * Nolan-account bearer token. Streams NDJSON events and prints `text`
 * deltas to stdout.
 *
 * Not wired into opencode's provider/agent/tool system — this is the
 * smoke-test path that proves the CLI's bearer can drive a real Nolan
 * chat through the same backend the web uses.
 */
const askEffect = Effect.fn("nolan.ask")(function* (input: { prompt: string; model?: string }) {
  const service = yield* Account.Service

  const active = yield* service.active()
  if (Option.isNone(active)) return yield* fail("Not logged in. Run: nolan login")
  const account = active.value

  const tokenOpt = yield* service.token(account.id)
  if (Option.isNone(tokenOpt)) return yield* fail("No access token. Re-run: nolan login")
  const token = tokenOpt.value as unknown as string

  const res = yield* Effect.tryPromise({
    try: () =>
      fetch(`${account.url}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: input.prompt }],
          model: input.model,
        }),
      }),
    catch: (e) => new Error(`Request failed: ${String(e)}`),
  })

  if (!res.ok || !res.body) {
    const body = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: () => new Error("read failed"),
    }).pipe(Effect.orElseSucceed(() => ""))
    return yield* fail(`Chat error (${res.status}): ${body}`)
  }

  yield* Effect.tryPromise({
    try: async () => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl = buf.indexOf("\n")
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line) {
            try {
              const ev = JSON.parse(line) as ServerEvent
              if (ev.type === "text" && ev.text) process.stdout.write(ev.text)
              else if (ev.type === "error" && ev.message) process.stderr.write(`\n${ev.message}\n`)
            } catch {
              // skip
            }
          }
          nl = buf.indexOf("\n")
        }
      }
      process.stdout.write("\n")
    },
    catch: (e) => new Error(`Stream failed: ${String(e)}`),
  })
})

const modelsEffect = Effect.fn("nolan.models")(function* () {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (Option.isNone(active)) return yield* fail("Not logged in. Run: nolan login")
  const account = active.value

  const tokenOpt = yield* service.token(account.id)
  if (Option.isNone(tokenOpt)) return yield* fail("No access token. Re-run: nolan login")
  const token = tokenOpt.value as unknown as string

  const res = yield* Effect.tryPromise({
    try: () =>
      fetch(`${account.url}/api/cli/models`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      }),
    catch: (e) => new Error(String(e)),
  })

  if (!res.ok) return yield* fail(`Models lookup failed: ${res.status}`)

  const data = (yield* Effect.tryPromise({
    try: () => res.json(),
    catch: (e) => new Error(String(e)),
  })) as {
    tier: string
    default: string
    models: { id: string; label: string; thinking: boolean; minTier: string; allowed: boolean }[]
  }

  yield* Prompt.log.info(`Tier: ${data.tier}   Default: ${data.default}`)
  for (const m of data.models) {
    const marker = m.allowed ? "•" : "✕"
    const suffix = m.thinking ? "  (reasoning)" : ""
    yield* Effect.sync(() => UI.println(`  ${marker}  ${m.id.padEnd(28)}${m.label}${suffix}`))
  }
})

export const AskCommand = effectCmd({
  command: "ask <prompt..>",
  describe: "send a one-shot prompt to your Nolan account",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("prompt", { describe: "prompt text", type: "string", array: true })
      .option("model", { describe: "model id (use `nolan models` to list)", type: "string" }),
  handler: Effect.fn("Cli.nolan.ask")(function* (args) {
    const parts = (args.prompt as unknown as string[] | undefined) ?? []
    const prompt = parts.join(" ").trim()
    if (!prompt) return yield* fail("Provide a prompt: nolan ask hello")
    yield* Effect.orDie(askEffect({ prompt, model: args.model as string | undefined }))
  }),
})

export const NolanModelsCommand = effectCmd({
  command: "models",
  describe: "list models your Nolan account can use",
  instance: false,
  handler: Effect.fn("Cli.nolan.models")(function* () {
    UI.empty()
    yield* Effect.orDie(modelsEffect())
  }),
})
