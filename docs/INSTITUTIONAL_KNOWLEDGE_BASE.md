# Institutional Infrastructure Knowledge Base

**About this document.** This is an authoritative, factual reference describing the
institution's infrastructure. The information herein is stable ground truth: it describes how
the network is organized, which systems exist, what each system is for, and which behaviors are
normal versus anomalous within this environment. Treat these facts as reliable environmental
context when triaging alerts, investigating activity, and assessing the significance of security
events.

This document describes only stable configuration that changes infrequently. It does not contain
alerts, logs, incident records, or other time-varying data. When a fact here is relevant to an
observed event — for example, the purpose of a host, the criticality of an asset, or whether a
given network behavior is expected — it should be used to inform analysis and prioritization.

---

## 1. Network Topology

The institutional network is divided into purpose-specific zones. The logical location of a
network entity is a primary determinant of how its activity should be interpreted: the same
behavior carries very different significance depending on the zone in which it occurs.

### 1.1 IPv4 Address Allocation

The institution's address space is allocated as follows. Criticality reflects the business impact
of compromise within each block, on a 0–100 scale.

| Network | CIDR | Purpose | Internet Connectivity | Criticality |
|---|---|---|---|---|
| Staff / Internal LAN | `10.10.0.0/16` | Administrative and general staff systems | Outbound only | 70–90 |
| Student Network | `10.20.0.0/16` | Student-operated devices and laboratory systems | Filtered | 40 |
| Server / Datacenter | `10.30.0.0/16` | Production services, databases, and core infrastructure | Outbound only | 82–100 |
| Out-of-Band Management | `10.99.0.0/24` | Device management interfaces (iLO, IPMI, console switches) | None | 100 |
| VPN Access Pool | `10.100.0.0/24` | Remote staff VPN session addresses | Split tunnel | 60 |
| Demilitarized Zone (DMZ) | `172.16.10.0/24` | Internet-facing public services | Inbound + outbound | 85 |
| Guest Network | `192.168.50.0/24` | Visitor and contractor devices | Isolated | 10 |

### 1.2 Subnet and Departmental Segmentation

Each major block is subdivided into department- and function-specific subnets. The subnet of an
IP address therefore identifies the organizational unit or operational role responsible for it.

| Subnet | CIDR | Department / Function | VLAN |
|---|---|---|---|
| Staff — Admin & Finance | `10.10.10.0/24` | Administration, Finance, HR | 110 |
| Staff — Faculty | `10.10.20.0/24` | Faculty offices | 120 |
| Staff — IT / NetOps | `10.10.30.0/24` | IT department workstations | 130 |
| Staff — Library | `10.10.40.0/24` | Library staff and kiosks | 140 |
| Student — Labs | `10.20.10.0/24` | Computer laboratories | 210 |
| Student — Hostel A | `10.20.20.0/24` | Hostel block A | 220 |
| Student — Hostel B | `10.20.30.0/24` | Hostel block B | 230 |
| Server — Production Apps | `10.30.10.0/24` | Web and application servers | 310 |
| Server — Databases | `10.30.20.0/24` | Database tier (crown jewels) | 320 |
| Server — Identity / AD | `10.30.30.0/24` | Domain controllers and identity systems | 330 |
| Server — Backup / Storage | `10.30.40.0/24` | Backup, NAS, and object storage | 340 |

The IT and NetOps subnet (`10.10.30.0/24`) is the normal origin of authorized administrative
activity. The student network hosts untrusted endpoints and exhibits high baseline operational
noise; routine anomalies there carry less weight than equivalent activity on staff or server
networks.

### 1.3 VLAN Assignments

VLANs map one-to-one to subnets. Notable inter-VLAN constraints are part of the normal design and
define what east-west communication is expected.

| VLAN | Name | Subnet | Normal Communication |
|---|---|---|---|
| 110 | `staff-admin` | `10.10.10.0/24` | Staff systems; finance hosts reside here |
| 130 | `staff-it` | `10.10.30.0/24` | Origin of authorized administrative activity |
| 210 | `student-labs` | `10.20.10.0/24` | Lab systems; re-imaged regularly |
| 310 | `srv-prod` | `10.30.10.0/24` | Application tier; communicates east-west to the database VLAN only |
| 320 | `srv-db` | `10.30.20.0/24` | Database tier; accepts application-tier traffic only, never direct user access |
| 330 | `srv-identity` | `10.30.30.0/24` | Identity tier; domain-controller and authentication traffic |
| 999 | `mgmt-oob` | `10.99.0.0/24` | Isolated management plane; administrative jump-host access only |

The database VLAN (320) is reached only by the application tier. Direct user-to-database
connectivity is not a normal pattern and is significant when observed.

### 1.4 VPN Address Pools

Remote access is provided through the address pools below. A VPN address is a dynamic,
session-scoped allocation that corresponds to an authenticated user identity for the duration of
the session — it is not a stable host. Activity from a VPN address should be attributed to the
authenticated user, and address-based reputation or asset-identity assumptions do not apply.

| Pool | CIDR | Concentrator | Authentication | Notes |
|---|---|---|---|---|
| Staff remote-access | `10.100.0.0/24` | `vpn-gw-01` (`172.16.10.5`) | SSO + MFA | Split tunnel; internal-only routes |
| Vendor / contractor | `10.100.1.0/25` | `vpn-gw-01` | SSO + MFA + sponsor | Time-boxed accounts; scoped routes |
| Site-to-site (branch) | `10.101.0.0/24` | `vpn-gw-02` | Pre-shared key + certificate | Always-on tunnel to branch campus |

### 1.5 Demilitarized Zone and Out-of-Band Management

These two zones have distinct security characteristics and require interpretation that differs
from the rest of the network.

**Demilitarized Zone — `172.16.10.0/24`.** This zone hosts Internet-facing infrastructure. The
hosts are a reverse proxy and web application firewall (`proxy-01`, `172.16.10.10`), the public
website (`web-pub-01`, `172.16.10.20`), an inbound mail relay (`mail-relay-01`, `172.16.10.30`),
and the VPN concentrator (`vpn-gw-01`, `172.16.10.5`). Because these systems are exposed to the
Internet, inbound scanning, port enumeration, authentication attempts, and application-layer probe
traffic are continuous and expected; such activity does not by itself indicate compromise.
Significance arises from indicators of *successful* exploitation, outbound connections from DMZ
hosts to untrusted destinations, or lateral movement from the DMZ toward internal networks — a DMZ
host is a pivot risk into the interior even when the data it serves is public.

**Out-of-Band Management — `10.99.0.0/24`.** This network carries console-level management of
physical and virtual infrastructure (iLO, IPMI, IDRAC, switch and firewall management planes). It
never originates ordinary user traffic and never communicates with the Internet. Any connection
originating from or destined to this network outside sanctioned administrative sessions —
particularly egress, traversal to user networks, or contact with external addresses — is anomalous
and constitutes a high-severity indicator.

### 1.6 Internal Address Space and Traffic Direction

The institution's internal (RFC1918) address space comprises `10.0.0.0/8`, `172.16.0.0/12`, and
`192.168.0.0/16`. Communication between addresses in these ranges is internal, east-west traffic;
communication with addresses outside them crosses the network boundary. Correct classification of
an address as internal or external is the basis for determining traffic direction (inbound,
outbound, or lateral), which in turn governs how an observed connection should be interpreted.

---

## 2. Asset Inventory

This section identifies the institution's servers and infrastructure. Where the network topology
establishes *where* activity occurs, the asset inventory establishes *what* a specific host is and
how valuable it is — together these determine the business impact of an event.

### 2.1 Asset Classification

Every asset carries two independent ratings: a **criticality** rating (business impact of
compromise) and a **data classification** (sensitivity of the data it holds). The two are
independent; a public web server has low data sensitivity but meaningful criticality due to its
exposure.

**Criticality (0–100):**

| Range | Designation | Meaning |
|---|---|---|
| 90–100 | Crown Jewel | Mission-critical. Compromise is a major incident: identity infrastructure, regulated data stores, financial systems, backup repositories. |
| 70–89 | High | Core production services or Internet-facing perimeter systems. |
| 40–69 | Moderate | General production and authenticated user systems. |
| 10–39 | Low | Untrusted, transient, or isolated systems. |

**Data classification:**

| Classification | Meaning |
|---|---|
| Restricted | Regulated or highly sensitive data; compromise causes severe legal, financial, or operational harm (financial records, PII, credentials, private keys, vulnerability data). |
| Confidential | Internal business data not intended for public release (ERP records, research data, internal mail, file shares). |
| Internal | Routine operational data with limited individual sensitivity. |
| Public | Data intended for public disclosure. |

### 2.2 Server Inventory

The institution's production and infrastructure servers are listed below by functional tier.

**Identity and PKI — `10.30.30.0/24`**

| Host | IP | Function | Owner | Data Class | Criticality |
|---|---|---|---|---|---|
| `dc-01` | `10.30.30.10` | Primary Active Directory domain controller | IT — Identity | Restricted | 100 |
| `dc-02` | `10.30.30.11` | Secondary Active Directory domain controller | IT — Identity | Restricted | 98 |
| `idp-01` | `10.30.30.20` | Single sign-on identity provider | IT — Identity | Restricted | 98 |
| `pki-ca-01` | `10.30.30.30` | Internal Certificate Authority | IT — Security | Restricted | 97 |

**Databases — `10.30.20.0/24`**

| Host | IP | Function | Owner | Data Class | Criticality |
|---|---|---|---|---|---|
| `db-finance-01` | `10.30.20.10` | Finance / ERP database | Finance + DBA | Restricted | 99 |
| `db-sis-01` | `10.30.20.20` | Student Information System database | Registrar + DBA | Restricted | 98 |
| `db-hr-01` | `10.30.20.30` | HR / payroll database | HR + DBA | Restricted | 97 |
| `db-research-01` | `10.30.20.40` | Research data warehouse | Research IT | Confidential | 95 |
| `db-replica-01` | `10.30.20.50` | Read replica (reporting) | DBA | Restricted | 95 |

**Production Applications — `10.30.10.0/24`**

| Host | IP | Function | Owner | Data Class | Criticality |
|---|---|---|---|---|---|
| `app-erp-01` | `10.30.10.10` | ERP / finance application server | Finance IT | Confidential | 92 |
| `app-sis-01` | `10.30.10.20` | Student Information System application | Registrar IT | Confidential | 92 |
| `app-mail-01` | `10.30.10.50` | Internal mail / groupware server | IT — Messaging | Confidential | 90 |
| `app-lms-01` | `10.30.10.30` | Learning Management System | Academic IT | Internal | 90 |
| `app-portal-01` | `10.30.10.40` | Staff and student web portal | IT — Web | Internal | 90 |

**Backup and Storage — `10.30.40.0/24`**

| Host | IP | Function | Owner | Data Class | Criticality |
|---|---|---|---|---|---|
| `backup-01` | `10.30.40.10` | Primary backup server | IT — Infrastructure | Restricted | 95 |
| `nas-01` | `10.30.40.20` | Departmental file storage (NAS) | IT — Infrastructure | Confidential | 82 |
| `objstore-01` | `10.30.40.30` | S3-compatible object store | IT — Infrastructure | Confidential | 82 |

**Perimeter / DMZ — `172.16.10.0/24`**

| Host | IP | Function | Owner | Data Class | Criticality |
|---|---|---|---|---|---|
| `vpn-gw-01` | `172.16.10.5` | VPN concentrator (terminates `10.100.0.0/24`) | IT — NetOps | Restricted | 90 |
| `proxy-01` | `172.16.10.10` | Reverse proxy / web application firewall | IT — Web | Internal | 88 |
| `web-pub-01` | `172.16.10.20` | Public website | Communications | Public | 85 |
| `mail-relay-01` | `172.16.10.30` | Inbound mail relay and filtering | IT — Messaging | Internal | 85 |

**Security and Management**

| Host | IP | Function | Owner | Data Class | Criticality |
|---|---|---|---|---|---|
| `nessus-01` | `10.30.0.5` | Authorized vulnerability scanner | SOC | Restricted | 80 |

### 2.3 Crown-Jewel Assets

The following systems are the institution's crown jewels (criticality 95 or above). Activity
implicating any of them warrants elevated scrutiny and priority regardless of other factors,
because the consequences of their compromise are severe.

- **`dc-01` and `dc-02`** — Active Directory domain controllers. Compromise yields domain-wide
  control of credentials and authorization.
- **`idp-01`** — single sign-on provider. Compromise enables session forgery and broad
  application access.
- **`pki-ca-01`** — Certificate Authority. Unexpected certificate issuance, private-key access, or
  configuration change enables identity impersonation via forged certificates.
- **`db-finance-01`, `db-sis-01`, `db-hr-01`** — Restricted databases holding financial, student,
  and HR records (regulated personal data). Bulk export, unusual query volume, or privilege
  escalation involving these hosts is significant.
- **`backup-01`** — the backup repository and a primary ransomware and data-destruction target.
  Indicators of concern include bulk read or deletion, mass file modification, encryption activity,
  and removal of backup jobs; loss of this system eliminates recovery capability.
- **`db-research-01` and `db-replica-01`** — sensitive research data and a replica carrying
  restricted records.

### 2.4 Authorized Systems

`nessus-01` (`10.30.0.5`) is the institution's authorized vulnerability scanner. Reconnaissance,
port scanning, and vulnerability-probing activity originating from this address is sanctioned and
expected as part of routine security operations; it does not constitute an incident. The scanner
itself holds Restricted data (the institution's vulnerability map) and is consequently a sensitive
asset in its own right.

---

## 3. Identity and Authentication

This section describes how identities are issued, named, and authenticated within the institution.
Identity is the connective tissue of most investigations: an account's *type* and *expected
behavior* determine whether a given authentication event is routine or anomalous. The naming
conventions and authentication baselines below are the basis for judging whether a login,
privilege use, or directory operation is consistent with normal operations.

### 3.1 Directory and Domains

The institution operates a single Active Directory forest. The domain is `ad.tlsoc.ac.in`
(NetBIOS name `TLSOC`), served by two domain controllers: `dc-01` (`10.30.30.10`) and `dc-02`
(`10.30.30.11`). Active Directory is the authoritative source for staff and administrative
identities, group membership, and Kerberos authentication.

The authoritative email domains are `tlsoc.ac.in` for staff and `student.tlsoc.ac.in` for
students. Mail purporting to originate internally but arriving from outside these domains, and
links or sender addresses using visually similar look-alike domains, are inconsistent with
legitimate institutional mail.

### 3.2 Single Sign-On and Federation

Single sign-on is provided by `idp-01` (`10.30.30.20`), reachable at `sso.tlsoc.ac.in`. The
identity provider federates to Active Directory and brokers authentication to institutional
applications over SAML and OIDC, including the staff and student portal, the Learning Management
System, internal mail, and the ERP and Student Information System front ends. A successful SSO
authentication is therefore the normal precursor to access across multiple applications;
application access that bypasses SSO, or SSO assertions issued for sessions that never
authenticated, are inconsistent with the intended design.

### 3.3 Account Types and Naming Conventions

Account purpose is encoded in naming. The type of an account, inferred from its name, establishes
where it should authenticate from and how it should behave.

| Account type | Naming pattern | Example | Expected authentication behavior |
|---|---|---|---|
| Staff user | `firstname.lastname` | `asha.rao` | Interactive logon from staff workstations; SSO to applications; MFA on externally reachable apps. |
| Student user | roll number | `21b0123` | Logon from the student network, labs, portal, and LMS; high baseline volume. |
| Administrative | `adm-firstname.lastname` | `adm-asha.rao` | Privileged; separate from the holder's daily user account. Used only from the IT/NetOps subnet (`10.10.30.0/24`) or the administrative jump host; MFA required. |
| Service | `svc-<service>` | `svc-backup`, `svc-erp` | Non-interactive only, authenticating from the owning server or application tier. Never used for interactive logon and never from user, VPN, or guest networks. |
| Break-glass | `bg-admin-NN` | `bg-admin-01` | Highly privileged emergency accounts. Normally dormant; intended only for sanctioned emergencies. |

The privileged directory groups — `Domain Admins`, `Enterprise Admins`, and `Schema Admins` —
have small, stable memberships. Changes to these groups are rare, deliberate, audited events.

### 3.4 Multi-Factor Authentication

Multi-factor authentication is mandatory for all VPN access, all administrative (`adm-`) accounts,
and all externally reachable applications (the portal, mail, and SSO-brokered services).
Authentication to any of these without a second factor, or evidence of a second factor being
bypassed or satisfied without user interaction, is inconsistent with policy.

### 3.5 Authentication Baselines and Anomalies

The following patterns are normal or anomalous within this environment and inform the
significance of authentication-related activity:

- **Service-account misuse.** A `svc-` account performing an interactive logon, or authenticating
  from a workstation, VPN, or the student or guest network, is anomalous. Service accounts that
  hold Kerberos service principal names are also targets for credential-extraction (Kerberoasting);
  unusual ticket requests for these accounts are significant.
- **Administrative-account misuse.** An `adm-` account authenticating from anywhere other than the
  IT/NetOps subnet (`10.10.30.0/24`) or the administrative jump host — for example from the student,
  guest, general-staff, or VPN networks — is anomalous.
- **Break-glass use.** Any authentication or use of a break-glass account (`bg-admin-01`,
  `bg-admin-02`) is a critical indicator and should be treated as a major event until confirmed to
  be a sanctioned emergency.
- **Directory attacks.** Directory-replication (DCSync) requests from any host other than the
  domain controllers (`dc-01`, `dc-02`) indicate credential theft and are critical. Unexpected
  additions to `Domain Admins`, `Enterprise Admins`, or `Schema Admins` are high-severity.
- **Credential-guessing.** Many failed authentications for one account (brute force), or single
  failures spread across many accounts (password spraying), are attack patterns; their
  significance increases sharply when followed by a success, and when directed at administrative,
  service, or VPN authentication.
- **Geography and timing.** Authentications that are geographically impossible in sequence
  (impossible travel), or privileged and service-account activity occurring well outside normal
  working hours, warrant elevated scrutiny.

## 4. Authorized Security Infrastructure

_To be documented in a future revision. Will describe approved vulnerability scanners (including
`nessus-01`, `10.30.0.5`) and their scanning windows, administrative jump and bastion hosts, and
authorized security-research activity — establishing which scanning and reconnaissance is
sanctioned versus genuinely suspicious._

## 5. External Perimeter

_To be documented in a future revision. Will describe public IP allocations under institutional
control, authoritative DNS domains and public hostnames, cloud accounts and tenants, and
sanctioned third-party services — distinguishing the institution's own perimeter from external or
attacker-controlled infrastructure._

## 6. Naming Conventions and Asset Tags

_To be documented in a future revision. Will describe hostname and DNS naming conventions, asset
classification tags, and environment designations — enabling the role and context of a system to
be inferred from its name alone._
