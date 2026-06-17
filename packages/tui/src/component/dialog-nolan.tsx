import { createResource, createSignal, Show, For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import path from "path"
import fs from "fs/promises"
import os from "os"

interface NolanMe {
  user: { id: string; email: string; org_id: string }
  device: { id: string; name: string | null; created_at: string; last_used_at: string | null; expires_at: string }
  subscription: { active: boolean; plan: string; tier: string }
  credits: { balance: number; monthly_grant: number; period_start: string }
}

interface CreditPack {
  id: string
  credits: number
  price_usd: number
}

interface NolanCredits {
  balance: number
  monthly_grant: number
  period_start: string
  tier: string
  packs: CreditPack[]
  recent_transactions: Array<{
    id: string
    delta: number
    reason: string
    model_id: string | null
    chat_id: string | null
    created_at: string
  }>
}

async function readNolanCreds(): Promise<{ baseURL: string; apiKey: string } | null> {
  const candidates = [
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "opencode") : null,
    path.join(os.homedir(), ".config", "opencode"),
  ].filter((p): p is string => Boolean(p))

  for (const dir of candidates) {
    for (const file of ["opencode.json", "opencode.jsonc"]) {
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8")
        const data = JSON.parse(raw) as {
          provider?: Record<string, { options?: { apiKey?: string; baseURL?: string } }>
        }
        const opts = data.provider?.["nolan"]?.options
        if (opts?.apiKey && opts.baseURL) return { baseURL: opts.baseURL, apiKey: opts.apiKey }
      } catch {
        // try next
      }
    }
  }
  return null
}

async function apiGet<T>(p: string): Promise<T | { error: string }> {
  const creds = await readNolanCreds()
  if (!creds) return { error: "Not signed in to Nolan." }
  const apiRoot = creds.baseURL.replace(/\/v1\/?$/, "")
  try {
    const res = await fetch(`${apiRoot}${p}`, {
      headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" },
    })
    if (!res.ok) return { error: `Server returned ${res.status}` }
    return (await res.json()) as T
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

async function apiPost<T>(p: string, body: unknown): Promise<T | { error: string }> {
  const creds = await readNolanCreds()
  if (!creds) return { error: "Not signed in to Nolan." }
  const apiRoot = creds.baseURL.replace(/\/v1\/?$/, "")
  try {
    const res = await fetch(`${apiRoot}${p}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { error: `Server returned ${res.status}` }
    return (await res.json()) as T
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "never"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function Row(props: { label: string; value: string; muted?: boolean }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={2}>
      <box width={16}>
        <text fg={theme.textMuted}>{props.label}</text>
      </box>
      <text fg={props.muted ? theme.textMuted : theme.text}>{props.value}</text>
    </box>
  )
}

function bar(used: number, limit: number, width = 24): string {
  if (limit <= 0) return ""
  const ratio = Math.max(0, Math.min(1, used / limit))
  const filled = Math.round(ratio * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

// ----- /account -----

export function DialogAccount() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [data] = createResource(() => apiGet<NolanMe>("/api/cli/me"))

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Account
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>

      <Show when={data.loading}>
        <text fg={theme.textMuted}>Loading…</text>
      </Show>

      <Show when={!data.loading && data() && "error" in (data() as object)}>
        <text fg={theme.textMuted}>{(data() as { error: string }).error}</text>
      </Show>

      <Show when={!data.loading && data() && !("error" in (data() as object))}>
        {(() => {
          const d = data() as NolanMe
          return (
            <box gap={0}>
              <Row label="Signed in as" value={d.user.email} />
              <Row
                label="Plan"
                value={`${d.subscription.tier.toUpperCase()}${d.subscription.active ? "" : " (inactive)"}`}
              />
              <Row label="Credits" value={`${d.credits.balance} / ${d.credits.monthly_grant} monthly`} />
              <Row label="Org" value={d.user.org_id} muted />
              <Row label="Device" value={d.device.name ?? "Nolan Code CLI"} />
              <Row label="Authorized" value={fmtDate(d.device.created_at)} muted />
              <Row label="Last used" value={fmtDate(d.device.last_used_at)} muted />
            </box>
          )
        })()}
      </Show>

      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

// ----- /usage and /credits -----

export function DialogUsage() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [data, { refetch }] = createResource(() => apiGet<NolanCredits>("/api/cli/credits"))

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close", group: "Dialog", cmd: () => dialog.clear() },
      { key: "b", desc: "Buy credits", group: "Dialog", cmd: () => dialog.replace(() => <DialogBuyCredits />) },
      { key: "r", desc: "Refresh", group: "Dialog", cmd: () => refetch() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Credits
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          [b] buy  [r] refresh  esc/enter close
        </text>
      </box>

      <Show when={data.loading}>
        <text fg={theme.textMuted}>Loading…</text>
      </Show>

      <Show when={!data.loading && data() && "error" in (data() as object)}>
        <text fg={theme.textMuted}>{(data() as { error: string }).error}</text>
      </Show>

      <Show when={!data.loading && data() && !("error" in (data() as object))}>
        {(() => {
          const d = data() as NolanCredits
          return (
            <box gap={1}>
              <Row label="Tier" value={d.tier.toUpperCase()} />
              <Row label="Balance" value={`${d.balance} credits`} />
              <Row label="Monthly grant" value={`${d.monthly_grant} on ${fmtDate(d.period_start)}`} muted />

              <box gap={0}>
                <text fg={theme.textMuted}>Usage this period</text>
                <text fg={theme.primary}>{bar(d.monthly_grant - d.balance, d.monthly_grant)}</text>
              </box>

              <Show when={d.recent_transactions.length > 0}>
                <box gap={0}>
                  <text fg={theme.textMuted}>Recent</text>
                  <For each={d.recent_transactions.slice(0, 6)}>
                    {(tx) => (
                      <box flexDirection="row" gap={2}>
                        <box width={6}>
                          <text fg={tx.delta < 0 ? theme.text : theme.primary}>
                            {tx.delta > 0 ? `+${tx.delta}` : `${tx.delta}`}
                          </text>
                        </box>
                        <box width={10}>
                          <text fg={theme.textMuted}>{tx.reason}</text>
                        </box>
                        <text fg={theme.textMuted}>{tx.model_id ?? ""}</text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          )
        })()}
      </Show>

      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

// ----- /buy -----

export function DialogBuyCredits() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [data, { refetch }] = createResource(() => apiGet<NolanCredits>("/api/cli/credits"))
  const [selected, setSelected] = createSignal(0)
  const [status, setStatus] = createSignal<"idle" | "buying" | "ok" | "err">("idle")
  const [msg, setMsg] = createSignal<string>("")

  const packs = () => (data() && !("error" in (data() as object)) ? (data() as NolanCredits).packs : [])

  const confirm = async () => {
    const list = packs()
    const pack = list[selected()]
    if (!pack) return
    setStatus("buying")
    const result = await apiPost<{ ok: boolean; balance: number; granted: number; pack: string }>(
      "/api/cli/credits/buy",
      { pack: pack.id },
    )
    if ("error" in result) {
      setStatus("err")
      setMsg(result.error)
    } else {
      setStatus("ok")
      setMsg(`+${result.granted} credits — new balance ${result.balance}`)
      refetch()
    }
  }

  useBindings(() => ({
    bindings: [
      { key: "escape", desc: "Cancel", group: "Dialog", cmd: () => dialog.replace(() => <DialogUsage />) },
      {
        key: "up",
        desc: "Prev",
        group: "Dialog",
        cmd: () => setSelected((s) => Math.max(0, s - 1)),
      },
      {
        key: "down",
        desc: "Next",
        group: "Dialog",
        cmd: () => setSelected((s) => Math.min(packs().length - 1, s + 1)),
      },
      { key: "return", desc: "Buy", group: "Dialog", cmd: confirm },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Buy credits
        </text>
        <text fg={theme.textMuted}>↑↓ select  enter buy  esc back</text>
      </box>

      <Show when={data.loading}>
        <text fg={theme.textMuted}>Loading…</text>
      </Show>

      <Show when={!data.loading && data() && "error" in (data() as object)}>
        <text fg={theme.textMuted}>{(data() as { error: string }).error}</text>
      </Show>

      <Show when={!data.loading && data() && !("error" in (data() as object))}>
        <box gap={0}>
          <For each={packs()}>
            {(pack, i) => (
              <box flexDirection="row" gap={2}>
                <box width={2}>
                  <text fg={theme.primary}>{i() === selected() ? "›" : " "}</text>
                </box>
                <box width={20}>
                  <text fg={i() === selected() ? theme.text : theme.textMuted}>{pack.credits} credits</text>
                </box>
                <text fg={theme.textMuted}>${pack.price_usd}</text>
              </box>
            )}
          </For>
        </box>
      </Show>

      <Show when={status() === "buying"}>
        <text fg={theme.textMuted}>Charging…</text>
      </Show>
      <Show when={status() === "ok"}>
        <text fg={theme.primary}>{msg()}</text>
      </Show>
      <Show when={status() === "err"}>
        <text fg={theme.textMuted}>Error: {msg()}</text>
      </Show>

      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme.primary}
          onMouseUp={() => dialog.replace(() => <DialogUsage />)}
        >
          <text fg={theme.selectedListItemText}>back</text>
        </box>
      </box>
    </box>
  )
}
