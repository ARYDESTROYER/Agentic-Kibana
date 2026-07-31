---
id: impossible_travel_signin
title: Impossible travel sign-in
summary: Investigate geographically inconsistent sign-ins for one workforce identity.
persona: identity
applies_to_rules: [impossible_travel, atypical_signin]
applies_to_techniques: [T1078]
applies_to_entities: [user, ip]
keywords: [impossible travel, sign-in, identity, session]
---

SIGNAL
One identity signs in from locations that cannot be reached within the observed time interval.

EVIDENCE REQUIRED
Collect both sign-ins, source addresses, device identifiers, session details, authentication method, and user history.

INVESTIGATION STEPS
1. Validate timestamps, locations, source reputation, device identity, and authentication strength.
2. Check for shared egress, corporate proxies, mobile routing, approved travel, and concurrent sessions.
3. Compare the activity with the identity baseline and record any session or device mismatch.

TRUE POSITIVE SIGNALS
An unfamiliar device or source creates a session that performs sensitive actions without user confirmation.

FALSE POSITIVE SIGNALS
Corporate routing, verified travel, or a known device explains both sign-ins and subsequent activity is expected.

NEEDS HUMAN WHEN
Device identity, source ownership, user confirmation, or session activity is unavailable or contradictory.

RECOMMENDED NEXT ACTION
Escalate confirmed account misuse, revoke affected sessions, and preserve authentication and activity evidence.
