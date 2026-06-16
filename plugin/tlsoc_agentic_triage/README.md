# tlsocAgenticTriage

A Kibana 8.12.2 plugin that is a **thin viewer** over the TLSOC Agentic Triage backend.

It registers a single Kibana app (`TLSOC Agentic Triage`) with six surfaces:

1. **Agent Chat** — chat with the agent; renders answers, tables, and "Open in Discover".
2. **Alerts / Investigate** — case list, on-demand investigation, verdict card, per-case
   follow-up chat, and manual investigate-by-IP/user/host.
3. **Automated Scans** — scan queue with verdict/risk/reproduce; polls notifications and
   shows a new-case badge on the tab.
4. **Daily Standup** — prose summary + aggregate view (top rules / IPs / totals).
5. **Cost** — today's spend, tokens, call count, cost by model/role/surface, cost over time.
6. **Settings / Wizard** — first-boot 4-step wizard, then ongoing settings.

The browser only ever talks to the backend **through Kibana**: every call goes to
`/api/tlsoc/{path*}`, a server-side proxy that forwards to `${backendUrl}/api/<path>`
(so the Kibana session, CSRF token and TLS carry).

## Config

```yaml
# kibana.yml
tlsocAgenticTriage.backendUrl: "http://tlsoc-backend:8088"   # default
```

## Build

See [`../BUILD.md`](../BUILD.md) for the exact, reproducible build recipe and env vars.
The built artifact is `../dist/tlsocAgenticTriage-8.12.2.zip`.
