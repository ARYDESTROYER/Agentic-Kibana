"""Deterministic, seeded synthetic data generator for Demo Mode (Wave 5).

This module fabricates a believable SOC dataset for the demo tenant: a fixed
fictional org (employees, hosts, a domain controller, a VIP laptop, servers, a
corporate /16), a benign baseline (diurnal Poisson volume + Zipf entity
popularity + a 70/22/7/1 severity pyramid) and a roster of named MITRE ATT&CK
STORYLINES, plus a historical spread of finished Cases for the "old data" view.

Everything is DETERMINISTIC for a given seed: a module-level seeded
``random.Random`` is the ONLY randomness source (no ``Math.random`` / wall-clock
in the seeded paths), so the same seed yields byte-identical events and the same
historical case spread. Synthetic log/case text is DATA (#9) — it is plain text,
never trusted as instructions.

The generator emits ECS-shaped ``_source`` documents (matching the suite's default
field mapping) wrapped as ES "hits" (``{_id,_index,_source}``); callers project
them to :class:`RawEvent` (the connector path) or :class:`OCSFEvent`
(``ecs_to_ocsf``) exactly as a real Elasticsearch source would. It writes NOTHING
and touches NO real store — it is a pure value producer.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from ..config import Preferences
from ..constants import CaseStatus, DecisionBy, Disposition, EntityType, SourceSurface, Verdict
from ..models import (
    Case,
    CaseComment,
    Entity,
    EvidenceItem,
    RawEvent,
    RiskBreakdown,
    StatusHistoryEntry,
)
from ..ocsf import OCSFEvent, ecs_to_ocsf

DEMO_SOURCE_ID = "demo"
DEMO_SOURCE_NAME = "Demo Telemetry"
DEMO_INDEX = "tlsoc-demo-logs"

_MS_PER_HOUR = 3_600_000
_MS_PER_DAY = 86_400_000


# --------------------------------------------------------------------------- #
# Fixed fictional org fixture
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Employee:
    user: str
    display: str
    dept: str
    vip: bool = False


@dataclass(frozen=True)
class Host:
    name: str
    ip: str
    kind: str            # workstation | server | dc | vip_laptop
    criticality: float


@dataclass(frozen=True)
class Org:
    name: str
    domain: str
    cidr: str            # corporate /16
    employees: list[Employee]
    hosts: list[Host]

    def host_by_kind(self, kind: str) -> Host | None:
        return next((h for h in self.hosts if h.kind == kind), None)


_EMPLOYEE_SEED: tuple[tuple[str, str, str, bool], ...] = (
    ("a.silva", "Ana Silva", "Finance", True),          # VIP (CFO)
    ("j.okafor", "James Okafor", "Engineering", False),
    ("m.tan", "Mei Tan", "Engineering", False),
    ("r.kohl", "Rita Kohl", "IT", False),
    ("d.park", "David Park", "IT", False),
    ("s.haddad", "Sara Haddad", "Sales", False),
    ("l.novak", "Lukas Novak", "Sales", False),
    ("p.mensah", "Pat Mensah", "Support", False),
    ("c.rossi", "Carlo Rossi", "Marketing", False),
    ("n.iyer", "Nisha Iyer", "HR", False),
    ("t.bauer", "Tom Bauer", "Legal", False),
    ("e.flores", "Eva Flores", "Operations", False),
)


def build_org(seed: int = 1337) -> Org:
    """Construct the fixed fictional org deterministically from ``seed``.

    ~12 employees, ~40 hosts incl. a domain controller, a VIP laptop, and several
    servers, all inside a corporate /16. Two seeds with the same value yield the
    SAME org (host names/IPs/criticalities are derived, not randomly re-drawn each
    run beyond the seeded RNG)."""
    rng = random.Random(seed ^ 0x0C0FFEE)
    employees = [Employee(u, d, dept, vip) for (u, d, dept, vip) in _EMPLOYEE_SEED]

    hosts: list[Host] = []
    # Domain controller + core servers (criticality high).
    hosts.append(Host("dc01", "10.10.0.10", "dc", 95.0))
    hosts.append(Host("dc02", "10.10.0.11", "dc", 90.0))
    server_roles = [
        ("fileserver01", 80.0), ("fileserver02", 75.0), ("sql01", 90.0),
        ("sql02", 80.0), ("web01", 70.0), ("web02", 70.0), ("vpn01", 85.0),
        ("mail01", 80.0), ("backup01", 88.0), ("jumpbox01", 85.0),
    ]
    for i, (name, crit) in enumerate(server_roles):
        hosts.append(Host(name, f"10.10.1.{20 + i}", "server", crit))
    # VIP laptop (Ana Silva, CFO).
    hosts.append(Host("vip-laptop-cfo", "10.10.5.5", "vip_laptop", 92.0))
    # 27 workstations to round out ~40 hosts (2 DC + 10 servers + 1 VIP + 27 = 40).
    for i in range(27):
        octet3 = 20 + (i // 200)
        octet4 = 30 + i
        crit = round(10.0 + rng.random() * 25.0, 1)
        hosts.append(Host(f"ws-{i + 1:03d}", f"10.10.{octet3}.{octet4}", "workstation", crit))

    return Org(
        name="Northwind Logistics",
        domain="northwind.example",
        cidr="10.10.0.0/16",
        employees=employees,
        hosts=hosts,
    )


# --------------------------------------------------------------------------- #
# Low-level event construction (ECS-shaped, matching default field mapping)
# --------------------------------------------------------------------------- #
def _iso(ts_millis: int) -> str:
    return datetime.fromtimestamp(ts_millis / 1000.0, tz=timezone.utc).isoformat()


# OCSF severity_id (0..6) we stamp per pyramid tier. Layer-1 of the cost gate reads
# the numeric severity; the demo uses the 0..100 score so risk scoring is plausible.
def _hit(
    *,
    eid: str,
    ts_millis: int,
    rule: str,
    rule_name: str,
    severity: float,
    ip: str | None = None,
    user: str | None = None,
    host: str | None = None,
    action: str = "event",
    outcome: str = "success",
    message: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One ECS-shaped ES hit (``{_id,_index,_source}``). All values are synthetic
    DATA (#9). ``extra`` merges additional dotted-ish ECS sub-objects."""
    src: dict[str, Any] = {
        "@timestamp": _iso(ts_millis),
        "event": {"module": rule, "action": action, "outcome": outcome, "severity": severity},
        "rule": {"name": rule_name},
        "message": message or f"{rule_name}: {action} {outcome}",
    }
    if ip is not None:
        src["source"] = {"ip": ip}
    if user is not None:
        src["user"] = {"name": user}
    if host is not None:
        src.setdefault("host", {})["name"] = host
    if extra:
        for k, v in extra.items():
            if isinstance(v, dict) and isinstance(src.get(k), dict):
                src[k].update(v)
            else:
                src[k] = v
    return {"_id": eid, "_index": DEMO_INDEX, "_source": src}


# --------------------------------------------------------------------------- #
# Benign baseline
# --------------------------------------------------------------------------- #
# Diurnal envelope (relative event volume per hour-of-day, business-hours peak).
_DIURNAL = (
    0.15, 0.10, 0.08, 0.07, 0.07, 0.10,      # 00-05
    0.20, 0.45, 0.80, 1.00, 1.00, 0.95,      # 06-11
    0.70, 0.95, 1.00, 0.95, 0.85, 0.60,      # 12-17
    0.45, 0.35, 0.30, 0.25, 0.22, 0.18,      # 18-23
)

_BENIGN_RULES: tuple[tuple[str, str, str, str], ...] = (
    ("web_auth", "Web portal sign-in", "login", "success"),
    ("web_apache_access", "Web request", "request", "success"),
    ("waf_auth", "WAF allow", "allow", "success"),
    ("mail_auth", "Mail authentication", "login", "success"),
    ("postfix", "Mail delivery", "deliver", "success"),
    ("roundcube_login", "Webmail sign-in", "login", "success"),
    ("ml_stats", "Endpoint telemetry", "heartbeat", "success"),
)


def diurnal_weight(ts_millis: int) -> float:
    """The diurnal envelope multiplier for the hour-of-day at ``ts_millis``."""
    hour = datetime.fromtimestamp(ts_millis / 1000.0, tz=timezone.utc).hour
    return _DIURNAL[hour]


def _zipf_pick(rng: random.Random, items: list[Any]) -> Any:
    """Pick from ``items`` with a Zipf-ish popularity (item 0 most popular)."""
    n = len(items)
    weights = [1.0 / (i + 1) for i in range(n)]
    total = sum(weights)
    r = rng.random() * total
    acc = 0.0
    for it, w in zip(items, weights):
        acc += w
        if r <= acc:
            return it
    return items[-1]


def _severity_tier(rng: random.Random) -> float:
    """A 0..100 severity drawn from the 70/22/7/1 pyramid (info/low/med/high)."""
    r = rng.random()
    if r < 0.70:
        return round(5.0 + rng.random() * 15.0, 1)     # informational
    if r < 0.92:
        return round(25.0 + rng.random() * 20.0, 1)    # low
    if r < 0.99:
        return round(50.0 + rng.random() * 20.0, 1)    # medium
    return round(75.0 + rng.random() * 20.0, 1)        # high


def generate_benign_batch(
    rng: random.Random, org: Org, ts_millis: int, count: int
) -> list[dict[str, Any]]:
    """A batch of ``count`` benign ECS hits at ~``ts_millis`` (jittered within the
    hour). Entity popularity is Zipf (a few chatty hosts/users), severity follows
    the pyramid. Deterministic for a given ``rng`` + args."""
    out: list[dict[str, Any]] = []
    workstations = [h for h in org.hosts if h.kind in ("workstation", "vip_laptop")]
    for _ in range(max(0, count)):
        rule, rname, action, outcome = _zipf_pick(rng, list(_BENIGN_RULES))
        emp = _zipf_pick(rng, org.employees)
        host = _zipf_pick(rng, workstations)
        ip = f"10.10.{rng.randint(20, 40)}.{rng.randint(2, 250)}"
        jitter = rng.randint(0, _MS_PER_HOUR - 1)
        ts = ts_millis + jitter
        sev = _severity_tier(rng)
        eid = f"demo-evt-{ts}-{rng.randint(100000, 999999)}"
        out.append(_hit(
            eid=eid, ts_millis=ts, rule=rule, rule_name=rname, severity=sev,
            ip=ip, user=emp.user, host=host.name, action=action, outcome=outcome,
            message=f"{rname}: {emp.user} on {host.name} from {ip}",
        ))
    return out


# --------------------------------------------------------------------------- #
# MITRE ATT&CK storylines (named, seeded, multi-event)
# --------------------------------------------------------------------------- #
@dataclass
class Storyline:
    """A named ATT&CK storyline. ``generate`` returns the ECS hits for ONE ignition
    anchored at ``start_millis``. ``expected_verdict`` / ``expected_confidence``
    drive the deterministic mock LLM so the same storyline always yields the same
    verdict (NEEDS_HUMAN stories stay open for the HITL showcase)."""

    id: str
    name: str
    techniques: list[str]
    expected_verdict: Verdict
    expected_confidence: float
    generate: Callable[[random.Random, Org, int], list[dict[str, Any]]]


def _phishing_chain(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    target = org.employees[0]  # the VIP
    attacker_ip = "198.51.100.23"
    dc = org.host_by_kind("dc")
    fs = next((h for h in org.hosts if h.name == "fileserver01"), org.hosts[0])
    hits: list[dict[str, Any]] = []
    hits.append(_hit(
        eid=f"demo-story-{start}-ph1", ts_millis=start, rule="demo_phishing_chain",
        rule_name="Phishing email with credential-harvest link", severity=72.0,
        ip=attacker_ip, user=target.user, host="mail01", action="email", outcome="delivered",
        message=f"Phishing lure delivered to {target.user}",
    ))
    hits.append(_hit(
        eid=f"demo-story-{start}-ph2", ts_millis=start + 9 * 60_000, rule="demo_phishing_chain",
        rule_name="Suspicious webmail sign-in after lure click", severity=78.0,
        ip=attacker_ip, user=target.user, host="mail01", action="login", outcome="success",
        message=f"Credential-harvest sign-in for {target.user} from {attacker_ip}",
    ))
    hits.append(_hit(
        eid=f"demo-story-{start}-ph3", ts_millis=start + 22 * 60_000, rule="demo_phishing_chain",
        rule_name="OAuth token replay (credential access)", severity=80.0,
        ip=attacker_ip, user=target.user, host=dc.name if dc else "dc01",
        action="token", outcome="success", message=f"Token replay against {dc.name if dc else 'dc01'}",
    ))
    hits.append(_hit(
        eid=f"demo-story-{start}-ph4", ts_millis=start + 41 * 60_000, rule="demo_phishing_chain",
        rule_name="Lateral movement to file server", severity=82.0,
        ip="10.10.5.5", user=target.user, host=fs.name, action="access", outcome="success",
        message=f"Lateral access to {fs.name} by {target.user}",
    ))
    hits.append(_hit(
        eid=f"demo-story-{start}-ph5", ts_millis=start + 63 * 60_000, rule="demo_phishing_chain",
        rule_name="Bulk data staged for exfiltration", severity=88.0,
        ip="10.10.5.5", user=target.user, host=fs.name, action="download", outcome="success",
        message=f"3.1 GB staged + exfiltrated from {fs.name}",
    ))
    return hits


def _rdp_bruteforce(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    attacker_ip = "203.0.113.77"
    jump = next((h for h in org.hosts if h.name == "jumpbox01"), org.hosts[0])
    hits: list[dict[str, Any]] = []
    for i in range(14):
        hits.append(_hit(
            eid=f"demo-story-{start}-rdp{i}", ts_millis=start + i * 4_000, rule="demo_rdp_bruteforce",
            rule_name="RDP brute-force attempt", severity=55.0 + i,
            ip=attacker_ip, user=f"admin{i % 3}", host=jump.name,
            action="login", outcome="failure",
            message=f"RDP failed login #{i + 1} on {jump.name} from {attacker_ip}",
        ))
    hits.append(_hit(
        eid=f"demo-story-{start}-rdpok", ts_millis=start + 60_000, rule="demo_rdp_bruteforce",
        rule_name="RDP brute-force succeeded", severity=84.0,
        ip=attacker_ip, user="admin0", host=jump.name, action="login", outcome="success",
        message=f"RDP login SUCCEEDED on {jump.name} after brute force",
    ))
    return hits


def _sqli_webshell(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    attacker_ip = "192.0.2.44"
    web = next((h for h in org.hosts if h.name == "web01"), org.hosts[0])
    hits = [
        _hit(eid=f"demo-story-{start}-sql{i}", ts_millis=start + i * 7_000, rule="demo_sqli_webshell",
             rule_name="SQL injection (OWASP CRS 942xxx)", severity=68.0 + i,
             ip=attacker_ip, host=web.name, action="request", outcome="blocked",
             message=f"SQLi probe #{i + 1} on {web.name}",
             extra={"rule": {"id": "942100", "name": "SQL injection (OWASP CRS 942xxx)"}})
        for i in range(8)
    ]
    hits.append(_hit(
        eid=f"demo-story-{start}-shell", ts_millis=start + 70_000, rule="demo_sqli_webshell",
        rule_name="Webshell uploaded after SQLi", severity=86.0,
        ip=attacker_ip, host=web.name, action="upload", outcome="success",
        message=f"Webshell dropped on {web.name}",
    ))
    return hits


def _impossible_travel(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    emp = org.employees[1]
    return [
        _hit(eid=f"demo-story-{start}-it1", ts_millis=start, rule="demo_impossible_travel",
             rule_name="Sign-in from New York", severity=40.0,
             ip="198.51.100.5", user=emp.user, host="vpn01", action="login", outcome="success",
             message=f"{emp.user} signed in from New York, US"),
        _hit(eid=f"demo-story-{start}-it2", ts_millis=start + 18 * 60_000, rule="demo_impossible_travel",
             rule_name="Impossible travel sign-in from Singapore", severity=74.0,
             ip="203.0.113.190", user=emp.user, host="vpn01", action="login", outcome="success",
             message=f"{emp.user} signed in from Singapore 18m later (impossible travel)"),
    ]


def _ransomware_beacon(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    host = next((h for h in org.hosts if h.name == "fileserver02"), org.hosts[0])
    hits = [
        _hit(eid=f"demo-story-{start}-beacon{i}", ts_millis=start + i * 30_000, rule="demo_ransomware_beacon",
             rule_name="C2 beacon (regular interval)", severity=70.0,
             ip="185.220.101.4", host=host.name, action="connect", outcome="success",
             message=f"Beacon #{i + 1} from {host.name} to 185.220.101.4",
             extra={"destination": {"domain": "update-svc.bad.example"}})
        for i in range(6)
    ]
    hits.append(_hit(
        eid=f"demo-story-{start}-encrypt", ts_millis=start + 240_000, rule="demo_ransomware_beacon",
        rule_name="Mass file modification (ransomware encryption)", severity=92.0,
        ip="185.220.101.4", host=host.name, action="modify", outcome="success",
        message=f"4,210 files modified on {host.name} (.locked extension)",
        extra={"file": {"hash": {"sha256": "a1b2c3d4e5f6" + "0" * 52}}},
    ))
    return hits


def _insider_staging(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    emp = org.employees[5]
    fs = next((h for h in org.hosts if h.name == "fileserver01"), org.hosts[0])
    return [
        _hit(eid=f"demo-story-{start}-ins1", ts_millis=start, rule="demo_insider_staging",
             rule_name="After-hours bulk file access by employee", severity=48.0,
             ip="10.10.30.40", user=emp.user, host=fs.name, action="access", outcome="success",
             message=f"{emp.user} accessed 900 files on {fs.name} at 02:14"),
        _hit(eid=f"demo-story-{start}-ins2", ts_millis=start + 25 * 60_000, rule="demo_insider_staging",
             rule_name="Large outbound attachment to personal address", severity=58.0,
             ip="10.10.30.40", user=emp.user, host="mail01", action="send", outcome="success",
             message=f"{emp.user} emailed a 240 MB archive to a personal address"),
    ]


STORYLINES: list[Storyline] = [
    Storyline("phishing_chain", "Phishing → credential access → lateral → exfil",
              ["T1566", "T1078", "T1021", "T1048"], Verdict.TRUE_POSITIVE, 0.93, _phishing_chain),
    Storyline("rdp_bruteforce", "RDP brute force",
              ["T1110", "T1021.001"], Verdict.TRUE_POSITIVE, 0.88, _rdp_bruteforce),
    Storyline("sqli_webshell", "SQL injection → webshell",
              ["T1190", "T1505.003"], Verdict.TRUE_POSITIVE, 0.90, _sqli_webshell),
    Storyline("impossible_travel", "Impossible-travel sign-in",
              ["T1078", "T1556"], Verdict.NEEDS_HUMAN, 0.55, _impossible_travel),
    Storyline("ransomware_beacon", "Ransomware C2 beacon → encryption",
              ["T1071", "T1486"], Verdict.TRUE_POSITIVE, 0.95, _ransomware_beacon),
    Storyline("insider_staging", "Insider data staging",
              ["T1530", "T1048"], Verdict.NEEDS_HUMAN, 0.50, _insider_staging),
]

_STORYLINE_BY_ID = {s.id: s for s in STORYLINES}


# --------------------------------------------------------------------------- #
# Verdict resolution for the deterministic mock LLM (scenario-keyed)
# --------------------------------------------------------------------------- #
# Each storyline stamps a DISTINCTIVE ``event.module`` UID (``demo_<story>``) on its
# events; that UID is reliably present in every prompt the pipeline builds (router /
# investigator carry the cluster's rule values), so the mock LLM resolves the story
# from the UID — no RNG, no clock. The descriptive rule names are kept as a fallback.
_RULE_TO_STORY: dict[str, str] = {f"demo_{s.id}": s.id for s in STORYLINES}
_STORY_RULE_NAMES: dict[str, tuple[str, ...]] = {
    "phishing_chain": (
        "Phishing email with credential-harvest link",
        "Suspicious webmail sign-in after lure click",
        "OAuth token replay (credential access)",
        "Lateral movement to file server",
        "Bulk data staged for exfiltration",
    ),
    "rdp_bruteforce": ("RDP brute-force attempt", "RDP brute-force succeeded"),
    "sqli_webshell": ("SQL injection (OWASP CRS 942xxx)", "Webshell uploaded after SQLi"),
    "impossible_travel": ("Sign-in from New York", "Impossible travel sign-in from Singapore"),
    "ransomware_beacon": ("C2 beacon (regular interval)",
                          "Mass file modification (ransomware encryption)"),
    "insider_staging": ("After-hours bulk file access by employee",
                        "Large outbound attachment to personal address"),
}
for _sid, _names in _STORY_RULE_NAMES.items():
    for _n in _names:
        _RULE_TO_STORY[_n] = _sid


def resolve_story_verdict(rule_values: list[str]) -> tuple[Verdict, float, list[str], str] | None:
    """Map a set of (synthetic) rule UIDs / names to a storyline's stable verdict.

    Returns ``(verdict, confidence, techniques, story_id)`` when the events belong
    to a known storyline, else None (the caller defaults to FALSE_POSITIVE for the
    benign baseline). Deterministic — no RNG, no clock. Used by the deterministic
    mock provider to key a cluster's verdict to its scenario."""
    for name in rule_values:
        sid = _RULE_TO_STORY.get(name)
        if sid:
            s = _STORYLINE_BY_ID[sid]
            return s.expected_verdict, s.expected_confidence, list(s.techniques), s.id
    return None


# --------------------------------------------------------------------------- #
# Public generator surface used by the connector + simulator
# --------------------------------------------------------------------------- #
def generate_window_hits(
    rng: random.Random, org: Org, *, from_millis: int, to_millis: int,
    benign_per_hour: int = 6,
) -> list[dict[str, Any]]:
    """All benign ECS hits in ``[from_millis, to_millis)`` for the cursor window.

    The per-hour count is the diurnal envelope scaled by ``benign_per_hour``.
    Deterministic for a given rng + args."""
    out: list[dict[str, Any]] = []
    if to_millis <= from_millis:
        return out
    h = (from_millis // _MS_PER_HOUR) * _MS_PER_HOUR
    while h < to_millis:
        n = max(0, round(benign_per_hour * diurnal_weight(h)))
        for hit in generate_benign_batch(rng, org, h, n):
            ts = hit["_source"]
            tsm = _parse_ts(ts["@timestamp"])
            if from_millis <= tsm < to_millis:
                out.append(hit)
        h += _MS_PER_HOUR
    out.sort(key=lambda hit: hit["_source"]["@timestamp"])
    return out


def _parse_ts(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


def hits_to_ocsf(hits: list[dict[str, Any]], prefs: Preferences) -> list[OCSFEvent]:
    """Map ECS hits to OCSF events (the connector-agnostic projection)."""
    from ..constants import SourceType

    return [
        ecs_to_ocsf(h, prefs, source_type=SourceType.GENERIC, connector_id=DEMO_SOURCE_ID)
        for h in hits
    ]


def hits_to_raw(hits: list[dict[str, Any]], prefs: Preferences) -> list[RawEvent]:
    """Map ECS hits to RawEvents tagged with the demo source (connector path)."""
    out: list[RawEvent] = []
    for h in hits:
        ev = RawEvent.from_hit(h, prefs)
        ev.source_id = DEMO_SOURCE_ID
        ev.source_name = DEMO_SOURCE_NAME
        out.append(ev)
    return out


# --------------------------------------------------------------------------- #
# Historical case spread (backdated finished cases for "old data" surfaces)
# --------------------------------------------------------------------------- #
_HIST_TEMPLATES: tuple[dict[str, Any], ...] = (
    {"rule": "web_auth", "rname": "RDP brute-force attempt", "et": EntityType.IP,
     "verdict": Verdict.TRUE_POSITIVE, "disp": Disposition.TRUE_POSITIVE,
     "status": CaseStatus.RESOLVED, "risk": 78.0, "mitre": ["T1110"],
     "tags": ["brute-force", "rdp"]},
    {"rule": "modsec_sqli", "rname": "SQL injection (OWASP CRS 942xxx)", "et": EntityType.IP,
     "verdict": Verdict.TRUE_POSITIVE, "disp": Disposition.TRUE_POSITIVE,
     "status": CaseStatus.CLOSED, "risk": 82.0, "mitre": ["T1190"], "tags": ["web", "sqli"]},
    {"rule": "ml_stats", "rname": "Endpoint telemetry anomaly", "et": EntityType.HOST,
     "verdict": Verdict.FALSE_POSITIVE, "disp": Disposition.FALSE_POSITIVE,
     "status": CaseStatus.CLOSED, "risk": 18.0, "mitre": [], "tags": ["noise"]},
    {"rule": "web_apache_access", "rname": "Scanner activity", "et": EntityType.IP,
     "verdict": Verdict.FALSE_POSITIVE, "disp": Disposition.BENIGN,
     "status": CaseStatus.CLOSED, "risk": 22.0, "mitre": ["T1595"], "tags": ["scanner"]},
    {"rule": "mail_auth", "rname": "Suspicious mailbox sign-in", "et": EntityType.USER,
     "verdict": Verdict.NEEDS_HUMAN, "disp": Disposition.SUSPICIOUS,
     "status": CaseStatus.ESCALATED, "risk": 64.0, "mitre": ["T1078"], "tags": ["identity"]},
    {"rule": "postfix", "rname": "Outbound data anomaly", "et": EntityType.USER,
     "verdict": Verdict.NEEDS_HUMAN, "disp": Disposition.UNDETERMINED,
     "status": CaseStatus.ON_HOLD, "risk": 55.0, "mitre": ["T1048"], "tags": ["exfil"]},
    {"rule": "waf_auth", "rname": "WAF blocked exploit", "et": EntityType.IP,
     "verdict": Verdict.TRUE_POSITIVE, "disp": Disposition.TRUE_POSITIVE,
     "status": CaseStatus.RESOLVED, "risk": 71.0, "mitre": ["T1190"], "tags": ["waf"]},
    {"rule": "roundcube_login", "rname": "Webmail anomaly", "et": EntityType.USER,
     "verdict": Verdict.FALSE_POSITIVE, "disp": Disposition.DUPLICATE,
     "status": CaseStatus.CLOSED, "risk": 12.0, "mitre": [], "tags": ["duplicate"]},
)

_ANALYSTS = ("a.silva", "d.park", "r.kohl", "auto-triage")


def generate_historical_cases(
    seed: int, org: Org, *, history_days: int, run_id: str, now_millis: int,
) -> list[Case]:
    """A believable, BACKDATED spread of finished cases over ``history_days``.

    Every status / disposition / severity / source appears at least once, with a
    couple of NEEDS_HUMAN/ESCALATED/ON_HOLD cases LEFT OPEN for the HITL showcase,
    and a few carrying comments / notifications_sent / automation_actions /
    knowledge_used so every feature surface has data. Deterministic for a given
    seed; every case is tagged ``demo`` + ``case_id='demo-...'`` and carries the
    ``run_id`` (in a tag) so disable can purge by run_id."""
    rng = random.Random(seed ^ 0x5EED ^ (hash(run_id) & 0xFFFF))
    cases: list[Case] = []
    # Roughly 3-4 cases/day, spread across the trailing window. Cap so the demo is
    # snappy but every surface is populated.
    per_day = 3
    total = max(len(_HIST_TEMPLATES) + 4, per_day * max(1, history_days))
    total = min(total, 60)
    for i in range(total):
        tmpl = _HIST_TEMPLATES[i % len(_HIST_TEMPLATES)]
        # Backdate uniformly across the window (older first), with intra-day jitter.
        day_offset = (i * max(1, history_days)) // max(1, total)
        created_ms = now_millis - day_offset * _MS_PER_DAY - rng.randint(0, _MS_PER_DAY - 1)
        created = _iso(created_ms)
        # Realistic detection latency: the first cluster event fired 0.75-30 min before
        # the case was opened, so the demo shows a believable MTTD (advisory only, #3).
        first_seen_ms = created_ms - rng.randint(45, 1800) * 1000
        et: EntityType = tmpl["et"]
        if et == EntityType.IP:
            entity_val = f"{rng.choice(['198.51.100', '203.0.113', '192.0.2'])}.{rng.randint(2, 250)}"
        elif et == EntityType.USER:
            entity_val = rng.choice(org.employees).user
        else:
            entity_val = rng.choice([h.name for h in org.hosts])
        cid = f"demo-{run_id[:8] or 'seed'}-{i:04d}"
        sig = f"demo-sig-{et.value}-{entity_val}-{i}"
        status: CaseStatus = tmpl["status"]
        # Leave two specific NEEDS_HUMAN/escalated cases visibly OPEN for HITL.
        verdict: Verdict = tmpl["verdict"]
        risk = float(tmpl["risk"])
        decision_by = (
            DecisionBy.AGENT if status in (CaseStatus.CLOSED,) and verdict == Verdict.FALSE_POSITIVE
            else DecisionBy.ANALYST if status in (CaseStatus.RESOLVED, CaseStatus.CLOSED)
            else DecisionBy.SYSTEM
        )
        analyst = rng.choice(_ANALYSTS)
        comments: list[CaseComment] = []
        if i % 3 == 0:
            comments.append(CaseComment(
                ts=created, author=analyst,
                body=f"Triaged {tmpl['rname']}; {('escalating' if status == CaseStatus.ESCALATED else 'tracking')}.",
            ))
        notifications_sent: list[dict[str, Any]] = []
        if verdict == Verdict.TRUE_POSITIVE and i % 2 == 0:
            notifications_sent.append({
                "ts": created, "trigger": "on_true_positive", "channel_id": "demo-email",
                "channel_type": "email", "ok": True, "detail": "delivered (simulated)",
            })
        automation_actions: list[dict[str, Any]] = []
        if i % 4 == 0:
            automation_actions.append({
                "ts": created, "rule_id": "demo-auto-1", "action": "tag",
                "detail": "auto-tagged 'reviewed' (simulated)",
            })
        knowledge_used: list[dict[str, Any]] = []
        if tmpl["mitre"]:
            knowledge_used.append({
                "source": "mitre", "snippet": f"Technique {tmpl['mitre'][0]} reference.", "score": 0.81,
            })
        status_history = [StatusHistoryEntry(
            from_status="new", to_status=status.value, by=decision_by.value,
            at=created, reason=f"demo: {verdict.value} {tmpl['rname']}",
        )]
        cases.append(Case(
            case_id=cid,
            cluster_signature=sig,
            created_at=created,
            updated_at=created,
            source_surface=SourceSurface.AUTOMATED_SCAN if i % 2 == 0 else SourceSurface.INVESTIGATE,
            origin_surface=SourceSurface.AUTOMATED_SCAN if i % 2 == 0 else SourceSurface.INVESTIGATE,
            rule_ids=[tmpl["rule"]],
            entity=Entity(type=et, value=entity_val),
            source_id=DEMO_SOURCE_ID,
            source_name=DEMO_SOURCE_NAME,
            member_event_ids=[f"demo-hist-{i}-{j}" for j in range(rng.randint(2, 9))],
            first_seen_millis=first_seen_ms,
            risk_score=risk,
            risk_breakdown=RiskBreakdown(
                volume=risk * 0.3, velocity=risk * 0.2, reputation=risk * 0.3,
                diversity=risk * 0.1, asset_criticality=risk * 0.1, total=risk,
            ),
            verdict=verdict,
            confidence=round(0.5 + rng.random() * 0.49, 2),
            evidence=[EvidenceItem(summary=f"{tmpl['rname']} on {entity_val}.", event_ids=[])],
            mitre=list(tmpl["mitre"]),
            recommended_action=("Escalate to Tier-3." if status == CaseStatus.ESCALATED
                                else "No action required." if verdict == Verdict.FALSE_POSITIVE
                                else "Contain and monitor."),
            reproduce_query=f'{et.value} : "{entity_val}"',
            status=status,
            disposition=tmpl["disp"],
            escalation_level=1 if status == CaseStatus.ESCALATED else 0,
            status_history=status_history,
            decision_by=decision_by,
            agent_persona=rng.choice(["identity", "web", "malware", "recon", "threat_intel", ""]),
            # The demo CaseStore stamps the ``demo`` + ``run:`` tags on save; templates
            # only carry the descriptive tags here.
            tags=list(tmpl["tags"]),
            comments=comments,
            assignee=analyst if status in (CaseStatus.ESCALATED, CaseStatus.ON_HOLD) else "",
            title=f"{et.value}:{entity_val} — {tmpl['rule']}",
            summary=f"{tmpl['rname']} ({verdict.value}).",
            token_cost=round(rng.random() * 0.04, 6),
            notifications_sent=notifications_sent,
            automation_actions=automation_actions,
            knowledge_used=knowledge_used,
        ))
    return cases
