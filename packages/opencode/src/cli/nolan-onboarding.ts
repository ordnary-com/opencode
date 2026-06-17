/**
 * Pre-TUI auth gate.
 *
 * Runs from `nolan` (the default TUI command) before the opentui worker spawns.
 * If the user's opencode.json already has a working Nolan provider, this is a
 * no-op. Otherwise it walks them through the auth picker + device-code flow,
 * writes the provider config, then returns so the normal TUI startup
 * continues.
 *
 * Intentionally standalone — no Effect runtime, no DB. Token lives inside the
 * opencode.json provider block, same place opencode reads it from anyway.
 */
import path from "path"
import fs from "fs/promises"
import open from "open"
import * as p from "@clack/prompts"
import { Global } from "@opencode-ai/core/global"
import { EOL } from "os"
import { UI } from "./ui"

const CONFIG_PATH = path.join(Global.Path.config, "opencode.json")
const SERVER_URL = (process.env.NOLAN_API_URL ?? "https://nolan.ordnary.com").replace(/\/+$/, "")
const CLIENT_ID = "nolan-cli"

interface ProviderModelEntry {
  name?: string
  tool_call?: boolean
  reasoning?: boolean
  limit?: { context: number; output: number }
}

interface ConfigShape {
  provider?: Record<string, { options?: { apiKey?: string; baseURL?: string }; models?: Record<string, ProviderModelEntry> }>
  enabled_providers?: string[]
  model?: string
  agent?: Record<string, { model?: string }>
  [key: string]: unknown
}

interface DeviceStart {
  device_code: string
  user_code: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

interface TokenSuccess {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

interface ModelsResponse {
  tier: string
  default: string
  models: Array<{ id: string; label: string; thinking: boolean; minTier: string; allowed: boolean }>
}

async function readConfig(): Promise<ConfigShape> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8")
    return JSON.parse(raw) as ConfigShape
  } catch {
    return {}
  }
}

async function writeConfig(cfg: ConfigShape): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
}

async function ping(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/api/user`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.ok
  } catch {
    return false
  }
}

async function startDevice(): Promise<DeviceStart> {
  const res = await fetch(`${SERVER_URL}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, device_name: "Nolan Code CLI" }),
  })
  if (!res.ok) throw new Error(`Could not start auth (${res.status})`)
  return (await res.json()) as DeviceStart
}

async function pollToken(deviceCode: string, intervalMs: number, deadlineMs: number): Promise<TokenSuccess> {
  while (Date.now() < deadlineMs) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const res = await fetch(`${SERVER_URL}/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLIENT_ID,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok && typeof data["access_token"] === "string") return data as unknown as TokenSuccess
    const err = String(data["error"] ?? "")
    if (err === "authorization_pending") continue
    if (err === "slow_down") {
      intervalMs += 2000
      continue
    }
    if (err === "expired_token") throw new Error("Authorization code expired. Run nolan again.")
    if (err === "access_denied") throw new Error("Authorization denied.")
    throw new Error(`Token error: ${err || res.status}`)
  }
  throw new Error("Authorization timed out.")
}

async function fetchModels(token: string): Promise<ModelsResponse> {
  const res = await fetch(`${SERVER_URL}/api/cli/models`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
  if (!res.ok) throw new Error(`Could not fetch models (${res.status})`)
  return (await res.json()) as ModelsResponse
}

function pickDefaults(models: ModelsResponse["models"]) {
  const isPreview = (id: string) => /preview|beta|exp\b/i.test(id)
  const allowed = models.filter((m) => m.allowed)
  const fast =
    allowed.find((m) => /flash/i.test(m.id) && !m.thinking && !isPreview(m.id)) ??
    allowed.find((m) => !m.thinking && !isPreview(m.id)) ??
    allowed[0]
  const reasoning = allowed.find((m) => m.thinking && !isPreview(m.id)) ?? fast
  return { fast, reasoning }
}

function applyNolanConfig(existing: ConfigShape, token: string, models: ModelsResponse["models"]): ConfigShape {
  const next = { ...existing }
  const modelEntries: Record<string, ProviderModelEntry> = {}
  for (const m of models) {
    modelEntries[m.id] = {
      name: m.allowed ? m.label : `${m.label} (upgrade)`,
      tool_call: true,
      reasoning: m.thinking,
      limit: { context: 128_000, output: 8_000 },
    }
  }

  const providers = { ...(next.provider ?? {}) }
  providers["nolan"] = {
    options: { baseURL: `${SERVER_URL}/v1`, apiKey: token },
    models: modelEntries,
  }
  next.provider = providers
  next.enabled_providers = ["nolan"]

  const { fast, reasoning } = pickDefaults(models)
  if (fast) {
    const fastRef = `nolan/${fast.id}`
    const reasoningRef = reasoning ? `nolan/${reasoning.id}` : fastRef
    next.model = next.model ?? fastRef
    const agent = { ...(next.agent ?? {}) }
    for (const name of ["build", "plan", "small", "general"]) {
      const prev = agent[name] ?? {}
      agent[name] = { ...prev, model: name === "plan" ? reasoningRef : fastRef }
    }
    next.agent = agent
  }

  return next
}

async function runSubscriptionFlow(existing: ConfigShape): Promise<void> {
  const device = await startDevice()
  const url = `${SERVER_URL}${device.verification_uri_complete}`

  p.note(
    `${url}\n\nVerification code: ${device.user_code}`,
    "Open this in your browser to approve Nolan Code",
  )
  void open(url).catch(() => undefined)

  const spinner = p.spinner()
  spinner.start("Waiting for authorization…")

  let token: TokenSuccess
  try {
    token = await pollToken(
      device.device_code,
      device.interval * 1000,
      Date.now() + device.expires_in * 1000,
    )
    spinner.stop("Authorized")
  } catch (err) {
    spinner.stop("Authorization failed", 1)
    throw err
  }

  const models = await fetchModels(token.access_token)
  if (models.models.length === 0) {
    throw new Error("Your account has no Nolan models available.")
  }

  const next = applyNolanConfig(existing, token.access_token, models.models)
  await writeConfig(next)

  p.outro(`Signed in. Tier: ${models.tier}`)
}

/**
 * Returns true when the TUI can proceed (provider configured, token valid).
 * Returns false if the user cancelled — caller should exit cleanly.
 */
export async function ensureNolanAuth(): Promise<boolean> {
  const cfg = await readConfig()
  const existingToken = cfg.provider?.["nolan"]?.options?.apiKey
  if (existingToken && (await ping(existingToken))) return true

  // Onboarding required — print the Nolan wordmark first so it feels like the
  // TUI even though clack runs in plain stdout.
  process.stdout.write(EOL + UI.logo("  ") + EOL + EOL)
  p.intro(`${UI.Style.TEXT_HIGHLIGHT_BOLD}Welcome to Nolan Code${UI.Style.TEXT_NORMAL}`)
  const choice = await p.select({
    message: "How do you want to use Nolan?",
    options: [
      {
        value: "subscription" as const,
        label: "Nolan Subscription",
        hint: "sign in with your Ordnary account",
      },
      {
        value: "api" as const,
        label: "Nolan API",
        hint: "coming soon — bring your own API key",
      },
    ],
  })

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.")
    return false
  }

  if (choice === "api") {
    p.note("Nolan API auth is not available yet. Use Nolan Subscription for now.", "Coming soon")
    return false
  }

  try {
    await runSubscriptionFlow(cfg)
    return true
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : String(err))
    return false
  }
}
