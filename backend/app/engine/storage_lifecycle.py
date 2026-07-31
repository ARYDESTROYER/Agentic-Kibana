"""Capability-aware lifecycle for Agentic SOC's OWN state.

This module deliberately does not touch connected SIEM/log indices.  It also does
not move mutable cases: :class:`CaseStore` updates a stable case id through the
current write alias, so naïve rollover could create a second copy in a newer backing
index.  The first safely managed targets are the append-only audit and usage ledgers.

Elasticsearch ILM provides the native Hot -> Warm transition.  AWS Glacier remains
an advisory archive target until the product has an independent, checksummed export
and restore pipeline.  Elasticsearch snapshot-repository objects must never be
transitioned to Glacier.  SQL/SQLite report their honest provider limitations rather
than pretending a saved policy has moved data.
"""

from __future__ import annotations

from typing import Any

from ..config import StorageLifecycleConfig
from ..constants import AUDIT_INDEX, USAGE_INDEX
from ..es.base import BaseESClient
from ..es.indices import CONTRACT_INDICES, index_template_body

POLICY_NAME = "tlsoc-agent-ledgers-hot-warm"
ROLLOVER_MAX_AGE_DAYS = 30
ROLLOVER_MAX_PRIMARY_SHARD_GB = 50
MANAGED_BASES = (AUDIT_INDEX, USAGE_INDEX)


def elastic_ilm_policy(config: StorageLifecycleConfig) -> dict[str, Any]:
    """Return the deterministic ILM policy for append-only owned ledgers."""
    return {
        "policy": {
            "_meta": {
                "owner": "tlsoc-agentic-triage",
                "scope": "append-only-owned-state",
                "hot_days": int(config.hot_days),
                "warm_days": int(config.warm_days),
                "archive_from_days": int(config.archive_from_days),
            },
            "phases": {
                "hot": {
                    "min_age": "0ms",
                    "actions": {
                        "rollover": {
                            "max_age": f"{ROLLOVER_MAX_AGE_DAYS}d",
                            "max_primary_shard_size": f"{ROLLOVER_MAX_PRIMARY_SHARD_GB}gb",
                        },
                        "set_priority": {"priority": 100},
                    },
                },
                "warm": {
                    "min_age": f"{int(config.hot_days)}d",
                    "actions": {"set_priority": {"priority": 50}},
                },
            },
        }
    }


def elastic_index_lifecycle_settings(base: str) -> dict[str, Any]:
    """Settings attached only to one rollover-safe, append-only write alias."""
    return {
        "index.lifecycle.name": POLICY_NAME,
        "index.lifecycle.rollover_alias": base,
    }


async def apply_elasticsearch_lifecycle(
    es: BaseESClient, config: StorageLifecycleConfig
) -> dict[str, Any]:
    """Apply/remove owned-ledger ILM and return a non-secret execution report.

    Any provider/privilege failure is allowed to propagate to the explicit API caller;
    startup wraps this function best-effort so retention can never prevent the service
    from booting.  Only audit/usage templates and backing indices are touched.
    """
    capabilities = await es.index_lifecycle_capabilities()
    can_apply = bool(
        capabilities.get("supported")
        if config.enabled
        else capabilities.get("can_manage")
    )
    if not can_apply:
        return {
            "applied": False,
            "state": "blocked",
            "policy_name": POLICY_NAME,
            "managed_targets": [],
            "reason": str(capabilities.get("reason") or "ILM prerequisites are unavailable."),
            "capabilities": capabilities,
        }

    if not config.enabled:
        for base in MANAGED_BASES:
            mapping = CONTRACT_INDICES[base]
            await es.put_index_template(
                f"{base}-template", index_template_body(base, mapping)
            )
            await es.remove_index_lifecycle(f"{base}-*")
        await es.delete_index_lifecycle_policy(POLICY_NAME)
        return {
            "applied": True,
            "state": "disabled",
            "policy_name": POLICY_NAME,
            "managed_targets": [],
            "reason": "Automatic lifecycle is disabled; owned ledgers remain hot.",
            "capabilities": capabilities,
        }

    await es.put_index_lifecycle_policy(POLICY_NAME, elastic_ilm_policy(config))
    for base in MANAGED_BASES:
        mapping = CONTRACT_INDICES[base]
        settings = elastic_index_lifecycle_settings(base)
        await es.put_index_template(
            f"{base}-template",
            index_template_body(base, mapping, extra_settings=settings),
        )
        await es.put_index_settings(f"{base}-*", settings)
    return {
        "applied": True,
        "state": "active",
        "policy_name": POLICY_NAME,
        "managed_targets": list(MANAGED_BASES),
        "reason": "Elasticsearch ILM manages append-only audit and usage ledgers.",
        "capabilities": capabilities,
    }


async def lifecycle_status(
    *, state_backend: str, config: StorageLifecycleConfig, es: BaseESClient | None
) -> dict[str, Any]:
    """Project desired policy, effective capability, blockers, and safe scope."""
    backend = (state_backend or "elasticsearch").strip().lower()
    policy_exists = False
    policy_matches = False
    ilm_supported = False
    inspection_ok = False
    attachment_detail: dict[str, dict[str, Any]] = {
        base: {
            "verified": False,
            "template_attached": False,
            "indices_total": 0,
            "indices_attached": 0,
            "all_existing_indices_attached": False,
            "attached": False,
            "reason": "Lifecycle attachment state has not been inspected.",
        }
        for base in MANAGED_BASES
    }
    inspection_error: str | None = None
    capability_detail: dict[str, Any] = {
        "supported": False,
        "can_manage": False,
        "privileged": False,
        "index_privileged": False,
        "hot_ready": False,
        "warm_ready": False,
        "roles": [],
        "reason": "Native lifecycle is unavailable for this state backend.",
    }
    if backend == "elasticsearch" and es is not None:
        try:
            capability_detail = await es.index_lifecycle_capabilities()
        except Exception as exc:  # capability/status reads are fail-soft
            inspection_error = f"capability probe failed: {type(exc).__name__}"
        ilm_supported = bool(capability_detail.get("supported"))
        if ilm_supported or capability_detail.get("can_manage"):
            try:
                actual_policy = await es.get_index_lifecycle_policy(POLICY_NAME)
                policy_exists = actual_policy is not None
                policy_matches = actual_policy == elastic_ilm_policy(config)
                attachment_detail = {
                    base: await es.get_owned_index_lifecycle_attachment(base, POLICY_NAME)
                    for base in MANAGED_BASES
                }
                inspection_ok = all(
                    bool(detail.get("verified"))
                    for detail in attachment_detail.values()
                )
            except Exception as exc:  # status stays fail-soft and explicitly blocked
                inspection_error = f"attachment inspection failed: {type(exc).__name__}"
    elif backend == "memory":
        capability_detail["reason"] = (
            "The in-memory fallback is volatile; configure a persistent state backend "
            "before relying on lifecycle retention."
        )

    attachments_match = bool(
        inspection_ok
        and all(detail.get("attached") for detail in attachment_detail.values())
    )
    attachments_present = any(
        detail.get("template_attached") or int(detail.get("indices_attached") or 0) > 0
        for detail in attachment_detail.values()
    )

    if not config.enabled and backend == "elasticsearch" and not inspection_ok:
        effective_state = "blocked"
    elif not config.enabled and backend == "elasticsearch" and (
        policy_exists or attachments_present
    ):
        effective_state = "pending_disable"
    elif not config.enabled:
        effective_state = "disabled"
    elif (
        backend == "elasticsearch"
        and policy_exists
        and policy_matches
        and attachments_match
        and ilm_supported
    ):
        effective_state = "active"
    elif (
        backend == "elasticsearch"
        and inspection_ok
        and policy_exists
        and policy_matches
        and attachments_match
    ):
        effective_state = "blocked"
    elif backend == "elasticsearch" and inspection_ok and (
        policy_exists or attachments_present
    ):
        effective_state = "drifted"
    elif backend == "elasticsearch" and inspection_ok and ilm_supported:
        effective_state = "not_configured"
    elif backend == "elasticsearch":
        effective_state = "blocked"
    elif backend == "memory":
        effective_state = "unsupported"
    else:
        effective_state = "advisory"

    if backend == "elasticsearch":
        if effective_state == "active":
            ledger_enforcement = "managed"
            ledger_reason = (
                "Native ILM is active on the append-only audit and usage indices."
            )
        elif effective_state == "disabled":
            ledger_enforcement = "hot_only"
            ledger_reason = (
                "Automatic lifecycle is disabled; append-only ledgers remain Hot."
            )
        elif effective_state == "not_configured":
            ledger_enforcement = "not_configured"
            ledger_reason = (
                "Native ILM is available but has not been attached to both owned ledgers."
            )
        elif effective_state == "drifted":
            ledger_enforcement = "drifted"
            ledger_reason = (
                "The lifecycle policy, template, or existing-index attachment has drifted."
            )
        elif effective_state == "pending_disable":
            ledger_enforcement = "pending_disable"
            ledger_reason = (
                "Lifecycle remains attached; explicitly apply the saved disabled policy."
            )
        else:
            ledger_enforcement = "blocked"
            ledger_reason = str(
                inspection_error
                or capability_detail.get("reason")
                or "ILM prerequisites are unavailable."
            )
    elif backend == "postgres":
        ledger_enforcement = "advisory"
        ledger_reason = (
            "PostgreSQL needs timestamp partitioning and an operator-managed tablespace "
            "or archive scheduler before rows can move tiers."
        )
    elif backend == "sqlite":
        ledger_enforcement = "export_only"
        ledger_reason = (
            "SQLite is one database file; record-level Hot/Warm movement is unavailable."
        )
    else:
        ledger_enforcement = "unsupported"
        ledger_reason = (
            "The in-memory fallback is volatile; configure Elasticsearch, PostgreSQL, "
            "or SQLite before relying on a retention lifecycle."
        )

    return {
        "state_backend": backend,
        "effective_state": effective_state,
        "policy_name": POLICY_NAME if backend == "elasticsearch" else None,
        "capabilities": capability_detail,
        "attachments": attachment_detail,
        "inspection_error": inspection_error,
        "policy": {
            **config.model_dump(mode="json"),
            "archive_from_days": int(config.archive_from_days),
        },
        "tiers": [
            {
                "id": "hot",
                "label": "Hot",
                "from_day": 0,
                "until_day": int(config.hot_days),
                "enforcement": (
                    "managed"
                    if backend == "elasticsearch" and effective_state == "active"
                    else "volatile"
                    if backend == "memory"
                    else "native_store"
                ),
                "status": "active",
            },
            {
                "id": "warm",
                "label": "Warm",
                "from_day": int(config.hot_days),
                "until_day": int(config.archive_from_days),
                "enforcement": ledger_enforcement,
                "status": effective_state,
            },
            {
                "id": "archive",
                "label": "Glacier archive",
                "from_day": int(config.archive_from_days),
                "until_day": None,
                "enforcement": "advisory",
                "status": "not_configured",
            },
        ],
        "targets": [
            {
                "id": "audit",
                "label": "Audit ledger",
                "enforcement": ledger_enforcement,
                "reason": ledger_reason,
            },
            {
                "id": "usage",
                "label": "Usage & cost ledger",
                "enforcement": ledger_enforcement,
                "reason": ledger_reason,
            },
            {
                "id": "cases",
                "label": "Cases",
                "enforcement": "hot_only",
                "reason": (
                    "Cases remain mutable; rollover is blocked until updates are "
                    "index-aware."
                ),
            },
            {
                "id": "live_metadata",
                "label": "Configuration, cursors, users and sessions",
                "enforcement": "hot_only",
                "reason": "Live operational metadata must remain immediately available.",
            },
            {
                "id": "source_logs",
                "label": "Connected source logs",
                "enforcement": "external",
                "reason": "Read-only source retention stays under the SIEM/storage owner.",
            },
        ],
        "archive": {
            "enforcement": "advisory",
            "status": "not_configured",
            "storage_class": config.glacier_storage_class,
            "reason": (
                "Glacier requires an independent checksummed export/restore pipeline. "
                "Never transition an Elasticsearch snapshot-repository prefix to Glacier."
            ),
        },
        "delete_enabled": False,
    }


async def lifecycle_preview(
    *, state_backend: str, config: StorageLifecycleConfig, es: BaseESClient | None
) -> dict[str, Any]:
    """Return the exact safe plan for a candidate policy without mutating state."""
    status = await lifecycle_status(state_backend=state_backend, config=config, es=es)
    backend = status["state_backend"]
    capabilities = status["capabilities"]
    can_apply = bool(
        backend == "elasticsearch"
        and (
            capabilities.get("supported")
            if config.enabled
            else capabilities.get("can_manage")
        )
    )
    if backend != "elasticsearch":
        actions: list[dict[str, Any]] = []
        reason = (
            "This backend exposes the desired policy as operator guidance only; "
            "no native state movement will be attempted."
        )
    elif not can_apply:
        actions = []
        reason = str(
            capabilities.get("reason") or "Elasticsearch ILM prerequisites are unavailable."
        )
    elif config.enabled:
        actions = [
            {
                "action": "upsert_ilm_policy",
                "target": POLICY_NAME,
                "scope": "append-only owned state",
            },
            *[
                {
                    "action": "attach_lifecycle",
                    "target": base,
                    "scope": f"{base}-* and its index template",
                }
                for base in MANAGED_BASES
            ],
        ]
        reason = "The supported Hot/Warm lifecycle can be applied explicitly."
    else:
        actions = [
            *[
                {
                    "action": "detach_lifecycle",
                    "target": base,
                    "scope": f"{base}-* and its index template",
                }
                for base in MANAGED_BASES
            ],
            {"action": "delete_ilm_policy", "target": POLICY_NAME, "scope": "policy only"},
        ]
        reason = "Applying this candidate disables ILM without deleting any records."

    return {
        **status,
        "preview": {
            "mutates": False,
            "can_apply": can_apply,
            "actions": actions,
            "reason": reason,
            "excluded": [
                "mutable cases",
                "configuration, cursors, users and sessions",
                "connected source logs",
                "Glacier export and deletion",
            ],
        },
    }
