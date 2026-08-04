## Summary

<!-- What changed? Keep this concise and operator-focused. -->

## Problem and outcome

<!-- What problem does this solve, and how will a user or operator observe success? -->

## Scope

- Areas changed:
- Areas intentionally unchanged:
- Related issue:

## Safety and compatibility

<!-- Explain impact on the contracts below. Write "No impact" only after checking. -->

- Deterministic close/escalate authority:
- Read-only source access and durable processing:
- Untrusted-data fencing and secrets:
- Audit and model-cost accounting:
- API, persistence, and upgrade compatibility:
- RBAC and accessibility:

## Verification

<!-- Include exact commands and results. Do not paste secrets, customer data, or raw alerts. -->

- [ ] Backend tests passed offline: `cd backend && .venv/bin/python -m pytest -q`
- [ ] Strict Console tests passed: `cd webui && npm run test:strict`
- [ ] OpenAPI and TypeScript contracts passed: `cd webui && npm run check:types`
- [ ] Console lint passed with zero warnings: `cd webui && npm run lint -- --max-warnings=0`
- [ ] Design-system gates passed: `cd webui && npm run gates`
- [ ] Production Console and Help Center built: `cd webui && npm run build`
- [ ] Documentation bundle matched the product version: `cd webui && npm run docs:check`
- [ ] Deployment and shell contracts were checked when applicable.
- [ ] Fatal Python correctness checks passed: `uvx --from ruff==0.12.5 ruff check backend/app backend/tests updater/agentic_soc_updater scripts --select E9,F63,F7,F82`
- [ ] Workflow policy passed when CI changed: `uv run --with PyYAML==6.0.2 python scripts/check_ci_contract.py`
- [ ] PostgreSQL+pgvector/Redis and shipping-image gates passed when deployment, state, packaging, or release behavior changed.

Evidence:

```text
Add concise command results here.
```

## UI evidence

<!-- For visible changes, include light and dark screenshots plus relevant responsive, keyboard, empty, loading, and error states. Use synthetic data only. Delete this section when not applicable. -->

## Documentation and release impact

- [ ] User, operator, API, deployment, or troubleshooting documentation was updated where behaviour changed.
- [ ] `CHANGELOG.md` and the release page were updated when this is release-facing.
- [ ] `Journal.md` records the session start, milestones, tests, and completion.
- [ ] Version/package/build metadata was updated together when preparing a release.
- Release impact: None / Testing candidate / Stable patch / Stable minor / Breaking

## Final checklist

- [ ] I reviewed the diff for accidental generated files, credentials, exports, and host-specific paths.
- [ ] I added or updated regression tests for changed behaviour.
- [ ] I preserved the 12 non-negotiables in `AGENTS.md`.
- [ ] I did not modify the archived Kibana plugin.
- [ ] This pull request is targeted at `Testing`, or it is a verified promotion from `Testing` to `main`.
- [ ] The fail-closed **CI passed** aggregate is green for the exact candidate; no required lane was skipped, softened, or bypassed.
