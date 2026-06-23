"""Wazuh pull connector.

Wazuh stores its alerts in the **Wazuh indexer**, which is an OpenSearch cluster
(``wazuh-alerts-4.x-*``). So the connector reuses the Elastic/OpenSearch read
path wholesale and only differs in its DEFAULT field mapping — Wazuh's alert
schema is not ECS (e.g. ``data.srcip``, ``agent.name``, ``rule.description``,
``rule.level``). Those defaults ship in the manifest's ``config_fields``; the
operator's saved source ``config`` is overlaid onto the global prefs at read time
by :meth:`ElasticConnector._effective_prefs`, so poll/search/normalisation
extract the right fields without changing any global setting.

This is the first third-party (non-Elastic) connector and proves the
abstraction: ~no new read logic, just a schema + manifest.
"""

from __future__ import annotations

from ..constants import IngestMode, SourceType
from .base import AuthField, ConnectorManifest
from .elastic import ElasticConnector


class WazuhConnector(ElasticConnector):
    """Pull connector for the Wazuh indexer (OpenSearch ``wazuh-alerts-*``)."""

    source_type = SourceType.WAZUH

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        """Wazuh self-description. Connection fields target the Wazuh indexer; the
        field-mapping ``config_fields`` default to Wazuh's alert schema (overlaid
        onto global prefs per-source at read time)."""
        return ConnectorManifest(
            source_type=cls.source_type,
            display_name="Wazuh",
            category="siem",
            description=(
                "Read Wazuh alerts from the Wazuh indexer (an OpenSearch cluster, "
                "wazuh-alerts-4.x-*) on a durable cursor. Use a read-only role "
                "scoped to the alert indices; the upstream Wazuh pipeline is never "
                "modified."
            ),
            ingest_modes=[IngestMode.PULL],
            query_language="lucene",
            capabilities=["poll", "search", "fetch_by_ids", "test", "browse"],
            auth_fields=[
                AuthField(
                    key="es_url", label="Wazuh indexer URL", type="string", required=True,
                    placeholder="https://wazuh.indexer:9200",
                    help="Base URL of the Wazuh indexer (OpenSearch) HTTP API.",
                    group="Connection",
                ),
                AuthField(
                    key="es_api_key", label="API key / token (read-only)", type="password",
                    secret=True,
                    help=("A read-only credential scoped to wazuh-alerts-*. Stored in "
                          "the secret store; shown only as configured."),
                    group="Connection",
                ),
                AuthField(
                    key="es_ca_cert", label="CA certificate (PEM)", type="textarea",
                    help="CA cert for the indexer's TLS (Wazuh ships a self-signed CA).",
                    group="Connection",
                ),
                AuthField(
                    key="es_verify_certs", label="Verify TLS certificates", type="bool",
                    default=True, group="Connection",
                ),
            ],
            config_fields=[
                AuthField(key="data_view_pattern", label="Alert index pattern", type="string",
                          default="wazuh-alerts-*", required=True,
                          help="Wazuh alert indices.", group="Field mapping"),
                AuthField(key="time_field", label="Time field", type="string",
                          default="timestamp", help="Wazuh alert timestamp field.",
                          group="Field mapping"),
                AuthField(key="source_ip_field", label="Source IP field", type="string",
                          default="data.srcip", group="Field mapping"),
                AuthField(key="user_field", label="User field", type="string",
                          default="data.srcuser", group="Field mapping"),
                AuthField(key="host_field", label="Host/agent field", type="string",
                          default="agent.name", help="Wazuh agent name.",
                          group="Field mapping"),
                AuthField(key="rule_field", label="Rule id field", type="string",
                          default="rule.id", group="Field mapping"),
                AuthField(key="rule_name_field", label="Rule description field", type="string",
                          default="rule.description", group="Field mapping"),
                AuthField(key="severity_field", label="Severity field", type="string",
                          default="rule.level", help="Wazuh rule level (0–15).",
                          group="Field mapping"),
            ],
        )
