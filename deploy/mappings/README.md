# Index templates (cases / audit / usage)

These are the Elasticsearch **composable index templates** for the three contract
indices the backend owns (Section 7 of the spec):

| File | Index pattern | Time field | Purpose |
|---|---|---|---|
| `tlsoc-agent-cases.template.json` | `tlsoc-agent-cases-*` | `created_at` | one document per investigation/case |
| `tlsoc-agent-audit.template.json` | `tlsoc-agent-audit-*` | `ts` | append-only audit of every agent action |
| `tlsoc-agent-usage.template.json` | `tlsoc-agent-usage-*` | `ts` | token & cost ledger (one doc per LLM call) |

> **Only relevant when `STATE_BACKEND=elasticsearch`.** These templates describe
> the suite's own bookkeeping indices on the Elasticsearch state backend. The
> agnostic stack (`deploy/docker-compose.agnostic.yml`) defaults to
> `STATE_BACKEND=postgres`, and a SQLite deployment needs no Elasticsearch at
> all — in either case, this whole directory is irrelevant and can be ignored.

## You normally do NOT need these

The backend **creates these templates and the backing write indices/aliases
automatically on first boot** (`app/es/indices.py :: bootstrap_indices`, using the
management API key). These files are provided for transparency and for operators
who prefer to pre-create the templates, e.g.:

```bash
curl -k -u elastic:$ELASTIC_PASSWORD -X PUT \
  https://localhost:9200/_index_template/tlsoc-agent-cases-template \
  -H 'Content-Type: application/json' \
  --data-binary @tlsoc-agent-cases.template.json
```

These JSON files are generated directly from the backend's source of truth
(`app/es/indices.py`), so they always match what the backend creates. The
single-doc bookkeeping indices `tlsoc-agent-config` and `tlsoc-agent-cursor` are
created with a dynamic mapping and need no template.
