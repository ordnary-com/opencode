import { Effect, Option } from "effect"
import { Account } from "@/account/account"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import readline from "node:readline"

interface ServerEvent {
  type: "text" | "reasoning" | "error"
  text?: string
  message?: string
}

interface Turn {
  role: "user" | "assistant"
  content: string
}

async function streamChat(input: {
  url: string
  token: string
  history: Turn[]
  chatId: string | null
  model?: string
}): Promise<{ assistant: string; chatId: string | null; errored: boolean }> {
  const res = await fetch(`${input.url}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({
      messages: input.history,
      chatId: input.chatId ?? undefined,
      model: input.model,
    }),
  })

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "")
    process.stderr.write(`\n${UI.Style.TEXT_DANGER}Chat error (${res.status}): ${body}${UI.Style.TEXT_NORMAL}\n`)
    return { assistant: "", chatId: input.chatId, errored: true }
  }

  const chatId = res.headers.get("X-Chat-Id") || input.chatId
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let assistant = ""
  let errored = false

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
          if (ev.type === "text" && ev.text) {
            process.stdout.write(ev.text)
            assistant += ev.text
          } else if (ev.type === "error" && ev.message) {
            process.stderr.write(`\n${UI.Style.TEXT_DANGER}${ev.message}${UI.Style.TEXT_NORMAL}\n`)
            errored = true
          }
        } catch {
          // skip
        }
      }
      nl = buf.indexOf("\n")
    }
  }

  process.stdout.write("\n")
  return { assistant, chatId, errored }
}

const replEffect = Effect.fn("nolan.repl")(function* (input: { model?: string }) {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (Option.isNone(active)) return yield* fail("Not logged in. Run: nolan login")
  const account = active.value

  const tokenOpt = yield* service.token(account.id)
  if (Option.isNone(tokenOpt)) return yield* fail("No access token. Re-run: nolan login")
  const token = tokenOpt.value as unknown as string

  yield* Effect.sync(() => {
    UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}Nolan${UI.Style.TEXT_NORMAL}  ${UI.Style.TEXT_DIM}(${account.email || account.id})${UI.Style.TEXT_NORMAL}`)
    UI.println(`${UI.Style.TEXT_DIM}Model: ${input.model ?? "default"}  •  Type /exit, /reset, /model <id>${UI.Style.TEXT_NORMAL}`)
    UI.empty()
  })

  yield* Effect.promise(async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const ask = () =>
      new Promise<string>((resolve) => {
        rl.question(`${UI.Style.TEXT_HIGHLIGHT_BOLD}> ${UI.Style.TEXT_NORMAL}`, (line) => resolve(line))
      })

    let history: Turn[] = []
    let chatId: string | null = null
    let model = input.model

    while (true) {
      const raw = (await ask()).trim()
      if (!raw) continue

      if (raw === "/exit" || raw === "/quit") break
      if (raw === "/reset") {
        history = []
        chatId = null
        process.stdout.write(`${UI.Style.TEXT_DIM}— new chat —${UI.Style.TEXT_NORMAL}\n`)
        continue
      }
      if (raw.startsWith("/model")) {
        const id = raw.slice(6).trim()
        if (!id) {
          process.stdout.write(`${UI.Style.TEXT_DIM}Current model: ${model ?? "default"}${UI.Style.TEXT_NORMAL}\n`)
        } else {
          model = id
          process.stdout.write(`${UI.Style.TEXT_DIM}Model set to ${model}${UI.Style.TEXT_NORMAL}\n`)
        }
        continue
      }
      if (raw === "/help") {
        process.stdout.write(
          `${UI.Style.TEXT_DIM}` +
            `  /exit            quit\n` +
            `  /reset           start a new chat\n` +
            `  /model <id>      switch model (use 'nolan-models' to list)\n` +
            `  /help            show this help\n` +
            `${UI.Style.TEXT_NORMAL}`,
        )
        continue
      }

      history.push({ role: "user", content: raw })
      const result = await streamChat({ url: account.url, token, history, chatId, model })
      if (result.errored) {
        history.pop()
      } else {
        history.push({ role: "assistant", content: result.assistant })
        chatId = result.chatId
      }
    }

    rl.close()
  })
})

export const ChatCommand = effectCmd({
  command: "chat",
  describe: "interactive multi-turn chat with your Nolan account",
  instance: false,
  builder: (yargs) =>
    yargs.option("model", { describe: "model id", type: "string" }),
  handler: Effect.fn("Cli.nolan.chat")(function* (args) {
    UI.empty()
    yield* Effect.orDie(replEffect({ model: args.model as string | undefined }))
  }),
})
