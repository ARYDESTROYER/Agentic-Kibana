# TLSOC Dashboards & Data Views

Pre-built Kibana 8.12 saved objects for the TLSOC Agentic Triage suite.

> **Mode-B (legacy ELK merge) only.** These dashboards are relevant only when the
> backend joins an existing Kibana as a read-only consumer
> (`deploy/docker-compose.tlsoc.yml`, `STATE_BACKEND=elasticsearch`). They were
> captured against **Kibana 8.12.2** and rely on Kibana's own saved-object
> migration to import cleanly into the current compatibility target,
> **Elastic/Kibana 8.19.12** (see `COMPATIBILITY.md`). The primary, vendor-agnostic
> stack (`deploy/docker-compose.agnostic.yml`, Postgres+pgvector) has no Kibana at
> all and does not use this directory.

They cover the backend's own bookkeeping indices (created by the management API key):

| Data view title        | Time field   | Index pattern         |
| ---------------------- | ------------ | --------------------- |
| `tlsoc-agent-cases-*`  | `created_at` | cases                 |
| `tlsoc-agent-audit-*`  | `ts`         | audit trail           |
| `tlsoc-agent-usage-*`  | `ts`         | LLM cost / token usage |

## Files

- `tlsoc-index-patterns.ndjson` — the 3 data views only.
- `tlsoc-audit-dashboard.ndjson` — **TLSOC — Audit Trail** dashboard + the cases & audit
  data views it needs (self-contained).
- `tlsoc-cost-dashboard.ndjson` — **TLSOC — Cost & Tokens** dashboard + the usage data
  view it needs (self-contained).
- `tlsoc-dashboards.ndjson` — everything combined (3 data views + 15 Lens visualizations
  + both dashboards). **Import this one to get the whole set in a single step.**

Each `.ndjson` is one saved object per line plus a final export-result footer line, exactly
as produced by Kibana's own Saved Objects export.

## How to import

### UI (recommended)

1. Open Kibana → **Stack Management → Saved Objects**.
2. Click **Import**.
3. Select `tlsoc-dashboards.ndjson` (or an individual dashboard file).
4. Choose **"Check for existing objects" → "Automatically overwrite conflicts"** if
   re-importing, then **Import**.
5. Open **Dashboard** and look for **TLSOC — Audit Trail** and **TLSOC — Cost & Tokens**.

### API (CI / scripted)

```bash
curl -sk -u "$KBN_USER:$KBN_PASS" \
  -X POST "$KIBANA_URL/api/saved_objects/_import?overwrite=true" \
  -H "kbn-xsrf: true" \
  --form file=@tlsoc-dashboards.ndjson
```

## Dashboards

**TLSOC — Audit Trail** (over `tlsoc-agent-cases-*` + `tlsoc-agent-audit-*`)
- Total cases (metric)
- Cases by status (pie)
- Cases by verdict (pie)
- Top rules across cases (horizontal bar)
- Audit actions over time, split by `action_type` (area)
- Recent audit actions table (`action_type` / `actor` / `surface` + count)

**TLSOC — Cost & Tokens** (over `tlsoc-agent-usage-*`)
- Total cost, total tokens, LLM call count (metrics)
- Cost by model (bar), cost by role (pie), cost by surface (pie)
- Cost over time split by model (area)
- Tokens over time (area)
- Top cost drivers table (model / role / surface with cost + tokens)

## Notes

- Object IDs are stable (e.g. `tlsoc-agent-cases`, `tlsoc-dashboard-cost`) so re-imports
  upgrade in place rather than duplicating.
- Data views use `allowNoIndex: true`, so they import cleanly even before the backing
  indices exist; the field list populates automatically once data lands.
- Index/field mappings for the backing indices live in `../mappings/`.
