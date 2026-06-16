"""Elasticsearch access layer.

Two physically separate credentials enforce the security boundary:

* the read-only client (``search_logs``) is the ONLY path to the log surface and
  uses the scoped read-only API key;
* the management client (everything else) owns the ``tlsoc-agent-*`` indices and
  uses a key scoped to those indices only.
"""
