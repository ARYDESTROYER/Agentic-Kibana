"""FastAPI routes — the contract the Kibana plugin consumes via core.http.

The plugin's Kibana server proxies ``/api/tlsoc/*`` to these ``/api/*`` routes,
so the analyst's Kibana session/CSRF/TLS context carries automatically and no
CORS is needed (Section 3.2).
"""
