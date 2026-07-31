---
id: encoded_powershell_execution
title: Encoded PowerShell execution
summary: Investigate encoded or policy-bypassing PowerShell on a managed endpoint.
persona: malware
applies_to_rules: [powershell_encoded_command, powershell_policy_bypass]
applies_to_techniques: [T1059.001]
applies_to_entities: [host, user]
keywords: [encodedcommand, powershell, process ancestry]
---

SIGNAL
PowerShell starts with encoded content, hidden execution, or a policy bypass on a managed endpoint.

EVIDENCE REQUIRED
Collect the original command, decoded content, process ancestry, script telemetry, user, host, and time.

INVESTIGATION STEPS
1. Decode the command and identify its intended behavior without executing it.
2. Confirm the parent process, initiating user, host role, and related network or file activity.
3. Compare the command with approved automation and record corroborating or conflicting evidence.

TRUE POSITIVE SIGNALS
The decoded content downloads a payload, changes defenses, steals credentials, or runs without approval.

FALSE POSITIVE SIGNALS
The exact signed script, owner, execution path, and schedule match approved administrative automation.

NEEDS HUMAN WHEN
Decoded content, process ancestry, ownership, or script telemetry is missing, stale, or contradictory.

RECOMMENDED NEXT ACTION
Escalate confirmed malicious execution and preserve the command, process tree, identity, and affected host.
