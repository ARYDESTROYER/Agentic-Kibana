---
id: moodle_application_abuse
name: Moodle application abuse
version: 1
description: Exact procedures for live Moodle abuse, session, grading, upload, and enumeration alert families.
priority: 80
match:
  rule_ids: [Moodle: AJAX Service Endpoint Abuse (DoS or Automation), Moodle: Session Key (sesskey) Reuse Across Multiple IPs ES|QL, Moodle: Dangerous File Extension Upload, Moodle: Path Enumeration, Moodle: Grading Administration Abuse, Moodle: PII Access Anomaly]
  entity_types: [ip, user, host, rule]
suggested_tools: [es_query, enrich, rag_retrieve]
rag_queries: [Moodle incident response, Moodle session abuse, Moodle administrative activity]
escalate_if: Confirmed account misuse, destructive administration, executable upload, or sustained service impact.
suggested_verdict_bias: Require corroborating authentication, application, and authorization evidence; automation alone is not compromise.
---
## Procedure

1. Confirm the exact Moodle rule, time window, affected user, source IP, course, and action count.
2. Compare the activity with the user's recent authentication and administrative baseline.
3. For sesskey reuse, verify overlapping IPs and sessions; shared NAT without overlap is not sufficient.
4. For AJAX or enumeration, measure rate, endpoints, failures, and service impact. Separate health checks and accessibility tools from hostile automation.
5. For grading, PII, or uploads, verify authorization, object scope, file type, and whether the action succeeded.
6. Escalate confirmed unauthorized changes, data access, executable content, or material denial of service. Otherwise document the benign explanation or the evidence still missing.

