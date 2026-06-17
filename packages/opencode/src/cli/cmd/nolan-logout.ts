/**
 * Wipes the local Nolan auth state:
 *   - revoke the access token on the server (best-effort)
 *   - strip `provider.nolan` from opencode.json so the onboarding gate fires
 *     again on the next `nolan` invocation.
 *
 * Doesn't touch other providers — only Nolan-specific keys.
 */
import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { cmd } from "./cmd"
import { UI } from "../ui"

const CONFIG_PATH = path.join(Global.Path.config, "opencode.json")

interface ConfigShape {
  provider?: Record<string, { options?: { apiKey?: string; baseURL?: string } } & Record<string, unknown>>
  enabled_providers?: string[]
  model?: string
  agent?: Record<string, { model?: string } & Record<string, unknown>>
  [key: string]: unknown
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

async function revokeOnServer(baseURL: string, token: string): Promise<boolean> {
  try {
    const list = await fetch(`${baseURL.replace(/\/v1$/, "")}/api/cli/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!list.ok) return false
    const { devices } = (await list.json()) as { devices: Array<{ id: string }> }
    // We don't get the bearer back from the API, so revoke every active
    // device for this user — same effect as "log out everywhere", which is
    // what `nolan logout` should mean.
    for (const d of devices) {
      await fetch(`${baseURL.replace(/\/v1$/, "")}/api/cli/devices/${d.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined)
    }
    return true
  } catch {
    return false
  }
}

export const NolanLogoutCommand = cmd({
  command: "logout",
  describe: "log out of your Nolan account on this machine",
  handler: async () => {
    const cfg = await readConfig()
    const nolan = cfg.provider?.["nolan"]
    const token = nolan?.options?.apiKey
    const baseURL = nolan?.options?.baseURL

    if (token && baseURL) {
      const ok = await revokeOnServer(baseURL, token)
      UI.println(
        ok
          ? `${UI.Style.TEXT_DIM}Revoked on server.${UI.Style.TEXT_NORMAL}`
          : `${UI.Style.TEXT_DIM}Could not reach server — cleared locally.${UI.Style.TEXT_NORMAL}`,
      )
    }

    const next = { ...cfg }
    if (next.provider) {
      const providers = { ...next.provider }
      delete providers["nolan"]
      next.provider = providers
    }
    if (Array.isArray(next.enabled_providers)) {
      next.enabled_providers = next.enabled_providers.filter((p: string) => p !== "nolan")
      if (next.enabled_providers.length === 0) delete next.enabled_providers
    }
    if (typeof next.model === "string" && next.model.startsWith("nolan/")) delete next.model
    if (next.agent) {
      const agent: Record<string, Record<string, unknown>> = { ...next.agent }
      for (const [name, value] of Object.entries(agent)) {
        const model = (value as { model?: string } | undefined)?.model
        if (typeof model === "string" && model.startsWith("nolan/")) {
          const { model: _m, ...rest } = value as { model?: string } & Record<string, unknown>
          agent[name] = rest
        }
      }
      next.agent = agent
    }

    await writeConfig(next)
    UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} Logged out`)
  },
})
