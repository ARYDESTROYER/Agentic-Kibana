"""Bundled operator playbooks shipped as distribution data.

The runtime loads the sibling Markdown files directly from disk; this package
marker ensures wheels preserve that established ``site-packages/playbooks``
layout without turning playbook content into executable Python.
"""
