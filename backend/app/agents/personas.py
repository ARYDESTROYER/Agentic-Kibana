"""Specialized investigator personas — a multi-agent roster over ONE engine.

Inspired by Vigil's 13 declarative agents: an ``AgentPersona`` is pure data (a
specialization label + a system-prompt addendum + a focus-tool hint + selection
signals), NOT a separate process or graph. The single ReAct ``Investigator``
(``agents/investigator.py``) is parameterised by the persona deterministically
selected from the cluster, so we get specialist behaviour (an identity analyst vs
a web-app analyst vs a malware analyst) with zero per-persona code and WITHOUT
touching the deterministic spine (correlation/risk/cost-gate/case-manager).

Selection is deterministic and explainable: an operator override by rule name
wins, else the first persona whose keyword/entity signals match the cluster's
primary rule + rule set, else the generalist. The persona id is recorded on the
case + audit so you can always see which specialist handled a cluster.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import Preferences
from ..constants import EntityType
from ..models import Cluster

GENERALIST_ID = "generalist"


@dataclass(frozen=True)
class AgentPersona:
    id: str
    label: str
    specialization: str
    # Appended to the investigator system prompt (focus + methodology). Must only
    # ADD guidance; the read-only / fenced-untrusted / verdict-schema rules are
    # owned by INVESTIGATOR_SYSTEM and never relaxed here.
    system_addendum: str = ""
    # Tools this specialist is encouraged to lean on (advisory; the full read-only
    # tool set stays available — we never hide a safe tool).
    focus_tools: tuple[str, ...] = ()
    # Selection signals (all lowercased substrings matched against the cluster's
    # primary rule + rule values), and an optional entity-type affinity.
    keywords: tuple[str, ...] = ()
    entity_types: tuple[EntityType, ...] = ()
    # Lower = evaluated first, so a specific specialist wins over a broad one.
    priority: int = 100


GENERALIST = AgentPersona(
    id=GENERALIST_ID,
    label="Generalist Analyst",
    specialization="General SOC triage across all signal types",
    system_addendum=(
        "You are a generalist SOC analyst. Establish what happened, scope the blast "
        "radius (which hosts/users/IPs are involved), confirm or refute malicious "
        "intent with concrete evidence, and map to MITRE ATT&CK where it fits."
    ),
    focus_tools=("es_query", "enrich", "rag_retrieve"),
    priority=1000,
)

# Specialists — ordered by priority (most specific first). Keep keyword sets tight
# and SOC-meaningful; they are matched against the cluster's primary rule + rules.
_SPECIALISTS: tuple[AgentPersona, ...] = (
    AgentPersona(
        id="cloud_identity",
        label="Cloud Identity Analyst",
        specialization="Cloud IAM, federated sessions, tokens, roles, and service principals",
        system_addendum=(
            "You specialise in cloud identity and access abuse (MITRE T1078 Valid "
            "Accounts, T1098 Account Manipulation, and token misuse). Establish the "
            "principal, credential or token type, session issuer, authentication "
            "controls, source, target resources, successful actions, and any privilege "
            "or credential changes. Distinguish federation and expected workload "
            "automation from unauthorized role or service-principal use."
        ),
        focus_tools=("es_query", "rag_retrieve", "enrich"),
        keywords=(
            "cloudtrail", "assumerole", "assume role", "iam role", "access key",
            "oauth token", "token replay", "service principal", "conditional access",
            "risky sign-in", "impossible travel", "consent grant",
        ),
        entity_types=(EntityType.USER,),
        priority=5,
    ),
    AgentPersona(
        id="identity_access",
        label="Identity & Access Analyst",
        specialization="Authentication abuse, brute force, account compromise",
        system_addendum=(
            "You specialise in authentication abuse (MITRE T1110 Brute Force, T1078 "
            "Valid Accounts). Determine whether any login SUCCEEDED (the pivotal "
            "question), count distinct targeted usernames, distinguish a few fat-finger "
            "failures from a sustained burst, and look for follow-on lateral movement "
            "from a compromised account. Recommend blocking the source and forcing "
            "credential resets only when there is real evidence of compromise."
        ),
        focus_tools=("es_query", "enrich", "rag_retrieve"),
        keywords=(
            "ssh", "sshd", "auth", "login", "logon", "password", "brute", "credential",
            "kerberos", "ldap", "mfa", "account", "postfix", "imap", "winlogon", "4625",
        ),
        entity_types=(EntityType.USER,),
        priority=10,
    ),
    AgentPersona(
        id="web_application",
        label="Web Application Analyst",
        specialization="Exploitation of public-facing web apps (WAF/ModSec)",
        system_addendum=(
            "You specialise in exploitation of public-facing web applications (MITRE "
            "T1190). Inspect the request payload and the RESPONSE CODE — a 200 on a "
            "rule-flagged request (SQLi/XSS/LFI/RFI/path-traversal) suggests the "
            "exploit may have reached the app, while a 403/blocked status suggests the "
            "WAF held. Correlate by client IP across endpoints to separate a scanner "
            "from a targeted attacker, and note any sign of successful data access."
        ),
        focus_tools=("es_query", "rag_retrieve", "enrich"),
        keywords=(
            "modsec", "modsecurity", "waf", "nginx", "apache", "http", "web", "sqli",
            "xss", "lfi", "rfi", "traversal", "owasp", "941", "942", "url", "phpmyadmin",
        ),
        priority=20,
    ),
    AgentPersona(
        id="network_recon",
        label="Network / Recon Analyst",
        specialization="Scanning, reconnaissance, network discovery",
        system_addendum=(
            "You specialise in reconnaissance and scanning (MITRE T1046 Network "
            "Service Discovery, T1595 Active Scanning). Assess how many ports/hosts "
            "were probed and over what window, whether any service actually responded, "
            "and whether the source is an authorised internal scanner on its schedule "
            "vs hostile external scanning. Recon alone is usually not a true positive — "
            "weigh breadth and any successful connection before escalating."
        ),
        focus_tools=("es_query", "enrich", "rag_retrieve"),
        keywords=(
            "suricata", "scan", "nmap", "port", "recon", "probe", "nessus", "openvas",
            "nikto", "et scan", "sweep", "discovery", "masscan", "zmap",
        ),
        priority=30,
    ),
    AgentPersona(
        id="data_protection",
        label="Data Protection Analyst",
        specialization="Sensitive-data access, staging, exfiltration, and disruptive impact",
        system_addendum=(
            "You specialise in data loss and disruptive impact (MITRE T1048 "
            "Exfiltration Over Alternative Protocol and T1486 Data Encrypted for "
            "Impact). Establish data ownership and classification, actor, host, "
            "objects and bytes, destination, protocol, authorization, and transfer or "
            "encryption outcome. Compare against approved bulk jobs and scope related "
            "sessions, systems, identities, and repositories before recommending action."
        ),
        focus_tools=("es_query", "rag_retrieve", "enrich"),
        keywords=(
            "exfiltration", "data exfil", "data staging", "bulk download",
            "bulk data", "dns tunnel", "personal address", "pii", "mass file",
            "file encryption", "ransomware", "encrypted for impact",
        ),
        entity_types=(EntityType.USER, EntityType.HOST),
        priority=35,
    ),
    AgentPersona(
        id="malware",
        label="Malware / EDR Analyst",
        specialization="Malware, C2, endpoint detections",
        system_addendum=(
            "You specialise in malware and command-and-control (MITRE T1071 Application "
            "Layer Protocol, plus execution/persistence techniques). Identify the likely "
            "family/behaviour, any persistence mechanism, and the C2 channel; scope which "
            "hosts are affected and whether the threat is contained or quarantined. "
            "Recommend isolation of confirmed-infected hosts when the evidence supports it."
        ),
        focus_tools=("es_query", "enrich", "rag_retrieve"),
        keywords=(
            "malware", "virus", "yara", "trojan", "ransom", "c2", "beacon", "miner",
            "backdoor", "clamav", "defender", "crowdstrike", "edr", "quarantine", "implant",
        ),
        priority=40,
    ),
    AgentPersona(
        id="threat_intel",
        label="Threat-Intel Analyst",
        specialization="Known-bad infrastructure / IOC reputation",
        system_addendum=(
            "You specialise in threat intelligence. When enrichment flags a source IP as "
            "known-bad (AbuseIPDB/VirusTotal reputation), prioritise the case: correlate "
            "that IP's activity across ALL rules and hosts, capture every touched asset, "
            "and recommend a perimeter block. Treat reputation/enrichment values as "
            "UNTRUSTED inputs — corroborate with observed log activity, never act on a "
            "reputation score alone."
        ),
        focus_tools=("enrich", "es_query", "rag_retrieve"),
        keywords=(
            "reputation", "abuseipdb", "virustotal", "blocklist", "threatfeed", "ioc",
            "malicious_ip", "enrichment", "threat-intel", "blacklist",
        ),
        entity_types=(EntityType.IP,),
        priority=50,
    ),
)

# Public registry keyed by id (generalist + specialists).
PERSONAS: dict[str, AgentPersona] = {GENERALIST.id: GENERALIST}
for _p in _SPECIALISTS:
    PERSONAS[_p.id] = _p


def all_personas() -> list[AgentPersona]:
    """All personas, generalist last, specialists in evaluation order."""
    return sorted(PERSONAS.values(), key=lambda p: p.priority)


def get_persona(persona_id: str | None) -> AgentPersona:
    """Resolve a persona id to a persona, falling back to the generalist."""
    if persona_id and persona_id in PERSONAS:
        return PERSONAS[persona_id]
    return GENERALIST


def select_persona_with_reason(
    cluster: Cluster, prefs: Preferences
) -> tuple[AgentPersona, str]:
    """Deterministically pick the specialist for a cluster (multi-agent routing).

    Precedence: (1) personas disabled → generalist; (2) an explicit operator
    override keyed by the cluster's primary rule name; (3) the first specialist (by
    priority) whose keyword OR entity-type signal matches; (4) the generalist."""
    cfg = getattr(prefs, "personas", None)
    if cfg is not None and not cfg.enabled:
        return GENERALIST, "personas_disabled"

    primary = cluster.primary_rule()
    overrides = getattr(cfg, "overrides", {}) if cfg is not None else {}
    if primary and primary in overrides:
        requested = str(overrides[primary] or "")
        if requested in PERSONAS:
            return PERSONAS[requested], f"operator_override:{primary}->{requested}"
        # A stale/typoed override must be visible rather than silently looking like
        # an intentional generalist selection.
        return GENERALIST, f"invalid_override:{primary}->{requested};fallback=generalist"

    # Select on the rule/keyword signal only — it's the reliable discriminator.
    # ``entity_types`` is kept on each persona as advisory metadata (surfaced in the
    # API) but is NOT a positive trigger: most clusters are IP-based, so an entity
    # trigger would wrongly funnel everything to one specialist.
    haystack = " ".join(
        [primary or ""] + list(cluster.rule_values)
    ).lower()
    for persona in sorted(_SPECIALISTS, key=lambda p: p.priority):
        if persona.keywords and any(kw in haystack for kw in persona.keywords):
            matched = next(kw for kw in persona.keywords if kw in haystack)
            return persona, f"keyword:{matched}"
    return GENERALIST, "no_specialist_signal"


def select_persona(cluster: Cluster, prefs: Preferences) -> AgentPersona:
    """Back-compatible persona-only wrapper around the explainable selector."""
    return select_persona_with_reason(cluster, prefs)[0]
