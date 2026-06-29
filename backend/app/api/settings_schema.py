"""Best-effort settings-schema introspection (Wave 7 / F12).

Produces a JSON-serialisable description of the :class:`~app.config.Preferences`
sections + field types so the webui can render/group the settings forms generically
(instead of hard-coding every field). It is purely descriptive metadata derived from
the Pydantic models — it carries NO values, NO secrets, and NEVER affects behaviour.

The shape is intentionally simple + stable:

    {
      "sections": [
        {
          "key": "rag",                 # the Preferences attribute name
          "title": "RAG",               # humanised label
          "kind": "object",             # "object" (a nested model) | "group" (scalars)
          "model": "RagConfig",         # the pydantic model name for object sections
          "fields": [
            {"name": "enabled", "type": "boolean", "default": true,
             "required": false, "choices": null, "description": "..."},
            ...
          ]
        },
        ...
      ]
    }

``kind == "group"`` is the synthetic ``general`` bucket that collects the top-level
SCALAR / list / dict preferences that are not themselves nested models, so the UI
still has a home for ``data_view_pattern`` etc.
"""

from __future__ import annotations

import enum
import typing
from typing import Any, get_args, get_origin

from pydantic import BaseModel
from pydantic.fields import FieldInfo

from ..config import Preferences

# Humanised titles for the known sections (falls back to a Title-Cased key).
_SECTION_TITLES: dict[str, str] = {
    "general": "General",
    "rag": "RAG",
    "rbac": "RBAC",
    "mfa": "Multi-Factor Auth",
    "sso": "Single Sign-On",
    "notifications": "Notifications",
    "branding": "Branding",
    "case_id_format": "Case ID Format",
    "cross_source_correlation": "Cross-Source Correlation",
    "threat_context": "Threat Context",
    "threshold_automation": "Threshold Automation",
    "auto_close": "Auto-Close Policy",
    "fp_auto_close": "Auto-Close (legacy)",
    "enrichment": "Enrichment",
    "personas": "Personas",
    "runbooks": "Runbooks",
    "playbooks": "Playbooks",
    "caps": "Caps / Kill Switch",
    "standup": "Standup",
    "trace": "Trace",
    "risk_weights": "Risk Weights",
    "default_correlation": "Default Correlation",
}


def _humanise(key: str) -> str:
    return _SECTION_TITLES.get(key, key.replace("_", " ").title())


def _type_name(annotation: Any) -> str:
    """A coarse, UI-friendly type tag for one field annotation."""
    origin = get_origin(annotation)
    # Optional[X] / X | None — describe the non-None member.
    if origin is typing.Union:  # includes ``X | None``
        members = [a for a in get_args(annotation) if a is not type(None)]
        if len(members) == 1:
            return _type_name(members[0])
        return "union"
    if origin in (list, tuple, set, frozenset):
        return "array"
    if origin is dict:
        return "object"
    if annotation is bool:
        return "boolean"
    if annotation is int:
        return "integer"
    if annotation is float:
        return "number"
    if annotation is str:
        return "string"
    if isinstance(annotation, type):
        if issubclass(annotation, enum.Enum):
            return "enum"
        if issubclass(annotation, BaseModel):
            return "object"
    # Literal[...] surfaces as a typing special form.
    if get_origin(annotation) is typing.Literal:
        return "enum"
    return "string"


def _choices(annotation: Any) -> list[str] | None:
    """Enumerated choices for an enum / Literal field (else None)."""
    origin = get_origin(annotation)
    if origin is typing.Union:
        for a in get_args(annotation):
            if a is type(None):
                continue
            got = _choices(a)
            if got is not None:
                return got
        return None
    if get_origin(annotation) is typing.Literal:
        return [str(v) for v in get_args(annotation)]
    if isinstance(annotation, type) and issubclass(annotation, enum.Enum):
        return [str(getattr(m, "value", m)) for m in annotation]
    return None


def _default_for(field: FieldInfo, value: Any) -> Any:
    """A JSON-safe default for a field (prefers the live default value)."""
    try:
        if isinstance(value, BaseModel):
            return value.model_dump(mode="json")
        if isinstance(value, enum.Enum):
            return getattr(value, "value", str(value))
        # Round-trip through Pydantic's JSON-safe path for dates etc.
        import json

        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return None


def _describe_field(name: str, field: FieldInfo, live_value: Any) -> dict[str, Any]:
    ann = field.annotation
    return {
        "name": name,
        "type": _type_name(ann),
        "default": _default_for(field, live_value),
        "required": field.is_required(),
        "choices": _choices(ann),
        "description": (field.description or "").strip() or None,
    }


def _is_object_section(annotation: Any) -> bool:
    """True when a top-level field is itself a nested Pydantic model (its own section)."""
    return isinstance(annotation, type) and issubclass(annotation, BaseModel)


def settings_schema() -> dict[str, Any]:
    """Build the best-effort settings schema from :class:`Preferences`.

    Every top-level field that is a nested model becomes its own ``object`` section
    (with its sub-fields described); all remaining scalar/list/dict top-level fields
    are collected into a single synthetic ``general`` group section. Purely
    descriptive — no values beyond defaults, no secrets."""
    live = Preferences()
    object_sections: list[dict[str, Any]] = []
    general_fields: list[dict[str, Any]] = []

    for name, field in Preferences.model_fields.items():
        ann = field.annotation
        live_value = getattr(live, name, None)
        if _is_object_section(ann):
            sub_model: type[BaseModel] = ann  # type: ignore[assignment]
            sub_live = live_value if isinstance(live_value, BaseModel) else sub_model()
            fields = [
                _describe_field(fn, ff, getattr(sub_live, fn, None))
                for fn, ff in sub_model.model_fields.items()
            ]
            object_sections.append(
                {
                    "key": name,
                    "title": _humanise(name),
                    "kind": "object",
                    "model": sub_model.__name__,
                    "fields": fields,
                }
            )
        else:
            general_fields.append(_describe_field(name, field, live_value))

    sections: list[dict[str, Any]] = []
    if general_fields:
        sections.append(
            {
                "key": "general",
                "title": _humanise("general"),
                "kind": "group",
                "model": None,
                "fields": general_fields,
            }
        )
    sections.extend(object_sections)
    return {"sections": sections}


def section_keys() -> set[str]:
    """The set of valid single-subtree keys for ``GET /api/settings/{section}``
    (every top-level Preferences attribute name)."""
    return set(Preferences.model_fields.keys())
