# Static Institutional Knowledge Base

> **Purpose.** This document is the authoritative ground-truth reference for the institutional
> infrastructure. It provides the cybersecurity AI system with accurate, stable environmental
> context required for alert triage, investigation, and threat assessment. The document enables
> investigators and AI agents to distinguish normal operational activity from suspicious behavior
> by providing definitive information about network topology, asset criticality, identity systems,
> authorized security tooling, and infrastructure naming conventions.
>
> **Scope.** This knowledge base contains only stable configuration data that changes infrequently.
> It does not include operational logs, alert records, incident reports, time-series metrics, or
> transient network activity. Such information resides in the primary log surface and case
> management system.
>
> **Authority and Maintenance.** This document is the single source of truth for infrastructure
> configuration. Infrastructure changes (new subnets, servers, VPN ranges, VLAN assignments, or
> naming scheme modifications) must trigger simultaneous updates to this document and the live
> configuration store. Failure to maintain synchronization between documentation and operational
> configuration results in agent misclassification and intelligence degradation. **Owner:**
> _<SOC / Network Operations Lead>_. **Review Cadence:** _quarterly (or upon infrastructure change)_.

> **Current Status.** As of June 25, 2026, the canonical network topology described herein is
> operationally configured within the TLSOC backend system (10 asset network entries + 7 network
> baseline facts; see [§1.6](#16-how-this-feeds-the-soc-agent)). The AI system actively uses these
> parameters for threat classification and risk assessment. This is not a template; these are
> the operative network parameters. Should your physical environment differ from the topology
> described, modifications must be made simultaneously to both this document and the live
> configuration store to preserve system accuracy.

---

## Table of Contents

1. [Network Topology](#1-network-topology) — ✅ **Complete**
2. [Asset Inventory](#2-asset-inventory) — Crown-jewel infrastructure, ownership, data classification (in development)
3. [Identity and Authentication](#3-identity--authentication) — Directory systems, IdP, privileged account naming (in development)
4. [Authorized Security Infrastructure](#4-authorized-security-infrastructure) — Approved scanners, vulnerability assessment windows, SOC data sources (in development)
5. [External Perimeter](#5-external-perimeter) — Public IP allocations, authoritative domain names, cloud infrastructure (in development)
6. [Naming Standards and Asset Tags](#6-naming-standards-and-asset-tags) — Infrastructure naming conventions, asset classification tags (in development)

---

## 1. Network Topology

This section documents the organizational structure of the institutional network, including
address allocation, departmental segmentation, layer-2 infrastructure, and management ranges.
Network topology is the foundational context for threat triage: the majority of behavioral
classification decisions depend on accurately identifying the logical location and purpose of
network entities participating in observed activity.

### 1.1 IPv4 Address Plan

The following table presents the high-level allocation of IPv4 address space. Each block is
further subdivided and detailed in subsequent sections.

| Network | CIDR | Purpose | Internet Connectivity | Criticality Score | Assessment |
|---|---|---|---|---|---|
| Staff / Internal LAN | `10.10.0.0/16` | Administrative and general staff systems | Outbound only | 70–90 | Contains production systems, finance infrastructure, and administrative crown jewels. |
| Student Network | `10.20.0.0/16` | Student-operated devices and laboratory systems | Filtered inbound/outbound | 40 | Hosts untrusted endpoints with high baseline operational noise. |
| Server / Datacenter | `10.30.0.0/16` | Production services, databases, and infrastructure | Outbound only | 90–95 | Contains critical databases, identity systems, and application servers. Refer to Asset Inventory for details. |
| Management / Out-of-Band | `10.99.0.0/24` | Device management interfaces (iLO/IPMI, console switches) | None | 100 | Never originates user traffic or external connections. Any unexpected egress constitutes a high-severity event. |
| VPN Access Pool | `10.100.0.0/24` | Remote staff VPN session addresses | Via split tunnel | 60 | Dynamically allocated addresses; each session maps to an authenticated user identity. |
| Demilitarized Zone | `172.16.10.0/24` | Internet-facing public services | Inbound + outbound | 85 | Perimeter infrastructure; scan and probe activity is expected operational baseline. |
| Guest Network | `192.168.50.0/24` | Visitor and contractor devices | Filtered, isolated | 10 | NAT-segregated with no direct path to internal network resources. |

**Internal/RFC1918 supernets** (everything the agent should treat as "inside"):
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.

### 1.2 Subnet Allocation and Departmental Segmentation

This section details the allocation of /24 subnets within each major address block, along with
departmental ownership and DHCP configuration. This granular mapping enables precise attribution
of network activity to organizational units and operational contexts.

| Subnet | CIDR | Department / Function | VLAN | Gateway | DHCP |
|---|---|---|---|---|---|
| Staff — Admin & Finance | `10.10.10.0/24` | Administration, Finance, HR | 110 | `10.10.10.1` | Yes |
| Staff — Faculty | `10.10.20.0/24` | Faculty offices | 120 | `10.10.20.1` | Yes |
| Staff — IT / NetOps | `10.10.30.0/24` | IT department workstations | 130 | `10.10.30.1` | Yes |
| Staff — Library | `10.10.40.0/24` | Library staff & kiosks | 140 | `10.10.40.1` | Yes |
| Student — Labs | `10.20.10.0/24` | Computer labs | 210 | `10.20.10.1` | Yes |
| Student — Hostel A | `10.20.20.0/24` | Hostel block A | 220 | `10.20.20.1` | Yes |
| Student — Hostel B | `10.20.30.0/24` | Hostel block B | 230 | `10.20.30.1` | Yes |
| Server — Production apps | `10.30.10.0/24` | Web/app servers | 310 | `10.30.10.1` | Static |
| Server — Databases | `10.30.20.0/24` | DB tier (crown jewels) | 320 | `10.30.20.1` | Static |
| Server — Identity/AD | `10.30.30.0/24` | Domain controllers, IdP | 330 | `10.30.30.1` | Static |
| Server — Backup/Storage | `10.30.40.0/24` | Backup, NAS, object store | 340 | `10.30.40.1` | Static |

### 1.3 VLAN Configuration

The following table maps VLAN identifiers to corresponding subnets and infrastructure. 
Maintaining a 1:1 relationship between VLAN and subnet simplifies network operations and
facilitates correlating switch-generated logs to IP-level activity.

| VLAN ID | Name | Subnet | Trunked to | Notes |
|---|---|---|---|---|
| 110 | `staff-admin` | `10.10.10.0/24` | Core, Admin-bldg | Finance hosts here |
| 130 | `staff-it` | `10.10.30.0/24` | Core | Source of authorized admin activity |
| 210 | `student-labs` | `10.20.10.0/24` | Core, Lab-bldg | Re-imaged nightly |
| 310 | `srv-prod` | `10.30.10.0/24` | Core, DC | East-west to DB VLAN only |
| 320 | `srv-db` | `10.30.20.0/24` | DC | **No direct user access** — app-tier only |
| 330 | `srv-identity` | `10.30.30.0/24` | DC | DC-to-DC + auth traffic only |
| 999 | `mgmt-oob` | `10.99.0.0/24` | Mgmt switch | Isolated; jump-host access only |

### 1.4 Virtual Private Network Address Allocation

This section specifies the address pools allocated to VPN termination points. A critical 
distinction: VPN-sourced traffic originates from dynamically assigned addresses that map to 
named user identities. IP-based reputation and asset-identity logic must not treat VPN addresses 
as static infrastructure; attribution must factor the underlying authenticated user rather than 
assuming fixed-asset properties based on source IP.

| Pool | CIDR | Concentrator | Auth | Assignment | Notes |
|---|---|---|---|---|---|
| Staff remote-access | `10.100.0.0/24` | `vpn-gw-01` (`172.16.10.5`) | SSO + MFA | Dynamic | Split tunnel; internal-only routes |
| Vendor / contractor | `10.100.1.0/25` | `vpn-gw-01` | SSO + MFA + sponsor | Dynamic | Time-boxed accounts; scoped routes |
| Site-to-site (branch) | `10.101.0.0/24` | `vpn-gw-02` | PSK + cert | Static per-site | Always-on tunnel to branch campus |

### 1.5 Demilitarized Zone and Out-of-Band Management Network

Two network zones require specialized threat assessment logic due to their distinct operational
characteristics and security implications.

**Demilitarized Zone (DMZ) — `172.16.10.0/24`:**  
The DMZ hosts Internet-facing infrastructure (reverse proxy, web services, mail relay, VPN 
terminator). Inbound scanning, port enumeration, login attempts, and application-layer probe 
traffic represent expected baseline operational noise and do not independently constitute 
security incidents in this zone. However, successful compromise indicators or unauthorized 
lateral movement remain significant.

**Out-of-Band Management Network — `10.99.0.0/24`:**  
This network provides console-level access to physical and virtual infrastructure (iLO, IPMI, 
IDRAC, switch management planes, firewall consoles). This network must never originate user 
traffic or establish external connections under normal operations. Any unexpected egress, 
lateral traversal to user networks, or connection to external addresses constitutes a 
high-severity event requiring immediate escalation.

| Host | IP | Zone | Role | Public | Notes |
|---|---|---|---|---|---|
| `proxy-01` | `172.16.10.10` | DMZ | Reverse proxy / WAF | Yes | Terminates TLS for public apps |
| `web-pub-01` | `172.16.10.20` | DMZ | Public website | Yes | |
| `mail-relay-01` | `172.16.10.30` | DMZ | Inbound mail relay | Yes | |
| `vpn-gw-01` | `172.16.10.5` | DMZ | VPN concentrator | Yes | Terminates `10.100.0.0/24` |

### 1.6 Integration with the AI Investigation System

The information in this knowledge base is operationally configured within the TLSOC backend 
and directly influences threat assessment, risk weighting, and investigation guidance. The 
document serves three integration points:

**1. Asset Criticality Network Configuration (`asset_networks`)**

Network location and asset criticality directly influence risk scoring in the deterministic 
investigation pipeline. The criticality values from §1.1 are configured via `PUT /api/settings` 
with the following payload:

```json
"asset_networks": [
  { "cidr": "10.99.0.0/24",   "criticality": 100 },
  { "cidr": "10.30.20.0/24",  "criticality": 95  },
  { "cidr": "10.30.30.0/24",  "criticality": 95  },
  { "cidr": "10.30.10.0/24",  "criticality": 90  },
  { "cidr": "10.10.10.0/24",  "criticality": 90  },
  { "cidr": "172.16.10.0/24", "criticality": 85  },
  { "cidr": "10.10.0.0/16",   "criticality": 70  },
  { "cidr": "10.100.0.0/24",  "criticality": 60  },
  { "cidr": "10.20.0.0/16",   "criticality": 40  },
  { "cidr": "192.168.50.0/24","criticality": 10  }
]
```

Most-specific CIDR match determines the assigned criticality score; /24 entries override /16 
block values. This configuration is consumed by `engine/risk.py` as the `asset_criticality` 
component of risk weighting.

**2. Durable Agent Memory Facts**

Seven baseline `category:"asset"` facts have been registered in the agent memory store and 
are automatically injected as TRUSTED context into all investigations and dialogue:

1. RFC1918 address ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) designate 
   internal infrastructure; directionality analysis (inbound vs. outbound vs. east-west) 
   depends on correct classification.

2. Management network `10.99.0.0/24` must never originate user traffic or external 
   connections; unexpected egress is high-severity.

3. DMZ `172.16.10.0/24` is Internet-facing; inbound scanning and probe activity constitute 
   expected operational baseline, not independent indicators.

4. VPN pool `10.100.0.0/24` contains dynamically assigned addresses corresponding to 
   authenticated user sessions; do not apply fixed-asset assumptions to VPN-sourced traffic.

5. Datacenter block `10.30.0.0/16` encompasses production applications, crown-jewel 
   databases, identity infrastructure, and backup systems; database VLAN (`10.30.20.0/24`) 
   accepts only application-tier traffic.

6. Staff LAN (`10.10.0.0/16`) vs. student network (`10.20.0.0/16`) differ fundamentally in 
   trust assumptions and baseline operational characteristics.

7. Scanner `10.30.0.5` (Nessus) is authorized to conduct reconnaissance and vulnerability 
   assessment; activity originating from this address is sanctioned and does not constitute 
   an incident.

**3. Retrieval-Augmented Generation (RAG) Integration**

This entire document is indexed in the RAG corpus and available for retrieval during 
investigations. Investigators can query the knowledge base by IP address, CIDR block, 
department, or infrastructure function to obtain authoritative context during alert triage 
and analysis.

> **Operational Note:** Configuration state is re-applied after each backend restart. 
> Exact procedures and reproducible payloads are documented in §1.7.

### 1.7 Configuration Management and Operational Procedures

**Reproducible Configuration Payloads**

The exact configuration parameters used to populate the TLSOC system are version-controlled
and stored in [`deploy/seed/`](../deploy/seed/):

- [`asset_networks.json`](../deploy/seed/asset_networks.json) — criticality mapping for §1.1 
  and §1.2 subnets
- [`memory_facts.json`](../deploy/seed/memory_facts.json) — the 7 baseline agent memory facts 
  documented in §1.6
- [`seed_institutional_kb.sh`](../deploy/seed/seed_institutional_kb.sh) — idempotent 
  initialization script that configures the system via REST API

**Applying Configuration (New Deployments or Restarts)**

Execute the seed script to configure a TLSOC instance with the canonical institutional 
topology:

```bash
BACKEND=http://localhost:8088 ./deploy/seed/seed_institutional_kb.sh
```

The script performs the following operations:
1. Executes `PUT /api/settings` with `asset_networks.json` (replaces existing configuration)
2. Executes `POST /api/memory` for each baseline fact in `memory_facts.json` (skips existing entries)
3. Verifies configuration state via `GET /api/settings` and `GET /api/memory`

This approach is idempotent; repeated execution does not create duplicate memory entries.

**Managing Configuration Updates**

Should your institutional network topology differ from the canonical configuration documented 
herein, or when network changes occur:

1. Update this document's tables (§1.1, §1.2, §1.3, §1.4, §1.5) to reflect the new state
2. Simultaneously update the JSON payloads in `deploy/seed/`
3. Execute the seed script to apply changes to the running system
4. Verify state via the REST API endpoints

Sources for authoritative network topology information:

| Configuration Element | Authoritative Source |
|---|---|
| Subnet allocation and IP address assignment | IPAM system (NetBox, phpIPAM, Infoblox); DHCP server configuration; router `show ip route` and `show ip interface brief` |
| VLAN-to-subnet mapping | Switch management console; `show vlan brief` output; SVI definitions |
| Departmental network assignment | Network Operations documentation; firewall zone definitions; access control policies |
| VPN address pools and concentrator configuration | VPN appliance configuration; RADIUS/TACACS/SSO system logs |
| DMZ and Internet-facing hosts | Firewall NAT/published service rules; external DNS records; public asset inventory |
| Out-of-band management ranges | Switch and router out-of-band management console access; iLO/IPMI/IDRAC subnet documentation |
| Live network inventory verification | Authorized vulnerability scanner (`10.30.0.5`) read-only host discovery; cross-reference with IPAM records |

**Synchronization Requirements**

Documentation and live system configuration must be kept in synchronization. When updating
network topology due to infrastructure changes, modifications to this knowledge base and 
the `deploy/seed/` configuration payloads must be committed simultaneously. Divergence
between documented and operational configuration results in agent misclassification and 
compromises system accuracy.

---

## 2. Asset Inventory

_In development. This section will document:_

- Crown-jewel infrastructure (production databases, identity systems, financial systems)
- Server hostname, IP address, operational function, owning team
- Data classification and sensitivity levels
- Patching cadence and maintenance windows
- Business continuity and disaster recovery role
- Integration with risk weighting and threat prioritization

## 3. Identity & Authentication

_In development. This section will document:_

- Authoritative identity provider (IdP) and single sign-on (SSO) configuration
- Active Directory / LDAP domain(s) and their purposes
- Authoritative email domain(s)
- Naming conventions for privileged accounts (domain admins, service accounts, break-glass accounts)
- Multi-factor authentication (MFA) deployment scope and requirements
- Federated identity and cross-organizational authentication arrangements

## 4. Authorized Security Infrastructure

_In development. This section will document:_

- Vulnerability assessment and penetration testing infrastructure
- Authorized scanner IP addresses and scanning windows
- Jump hosts and administrative bastion servers
- SOC data sources and log ingestion mechanisms
- Authorized threat-hunting queries and research activities

This enables the system to distinguish security testing and authorized recon from genuine 
compromise indicators.

## 5. External Perimeter

_In development. This section will document:_

- Public IPv4 and IPv6 address allocations under institutional control
- Authoritative DNS domain(s) and public-facing hostnames
- Cloud infrastructure accounts and tenants (AWS, Azure, GCP, etc.)
- SaaS applications and third-party hosted services
- Authorized external IP addresses for partners, vendors, and legitimate external users

This enables distinction between "our perimeter" and third-party or attacker-controlled 
infrastructure.

## 6. Naming Standards and Asset Tags

_In development. This section will document:_

- Hostname and DNS naming conventions
- Asset classification tags and metadata
- Environment designations (production, staging, development, testing)
- Service type indicators embedded in naming scheme
- Location or datacenter identifiers

This enables inference of asset role, criticality, and organizational context from names alone,
improving automated analysis and threat assessment.
