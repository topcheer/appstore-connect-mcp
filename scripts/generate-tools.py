#!/usr/bin/env python3
"""
generate-tools.py - App Store Connect OpenAPI → MCP tools.json

Reads the official App Store Connect OpenAPI specification and produces
a compact tools.json consumed by the MCP server at runtime.

Usage:
  python3 scripts/generate-tools.py [path/to/openapi.oas.json] [output/tools.json]
"""

import json
import re
import sys
from pathlib import Path
from collections import OrderedDict


def slugify(text: str) -> str:
    text = text.replace(".", "_").replace("-", "_")
    return re.sub(r"[^a-zA-Z0-9_]", "_", text)


def humanize(resource: str) -> str:
    """Turn a camelCase resource name into a readable label."""
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", resource)
    s = re.sub(r"([a-z\d])([A-Z])", r"\1 \2", s)
    return s


def derive_summary(operation_id: str, method: str, path: str) -> str:
    """Produce a human-readable summary from the operationId pattern."""
    m = re.match(
        r"^(.+?)_(getCollection|getInstance|createInstance|updateInstance|"
        r"deleteInstance|getRelatedCollection|getRelatedInstance|"
        r"getToManyRelationship|getToOneRelationship|"
        r"addToRelationship|replaceRelationship|removeFromRelationship|"
        r"create$_|customAction|delete$_)(.*)$",
        operation_id,
    )
    resource = operation_id.split("_")[0]
    resource_label = humanize(resource)
    suffix = operation_id.split("_", 1)[1] if "_" in operation_id else ""

    singular = resource_label
    if singular.endswith("ies"):
        singular = singular[:-3] + "y"
    elif singular.endswith("s") and not singular.endswith("ss"):
        singular = singular[:-1]
    plural = resource_label if resource_label.endswith("s") else resource_label + "s"

    action_map = {
        "getCollection": f"List {plural}",
        "getInstance": f"Get {singular} by ID",
        "createInstance": f"Create {singular}",
        "updateInstance": f"Update {singular}",
        "deleteInstance": f"Delete {singular}",
        "getRelatedCollection": f"List related {plural}",
        "getRelatedInstance": f"Get related {singular}",
        "getToManyRelationship": f"Get {singular} to-many relationship",
        "getToOneRelationship": f"Get {singular} to-one relationship",
        "addToRelationship": f"Add to {singular} relationship",
        "replaceRelationship": f"Replace {singular} relationship",
        "removeFromRelationship": f"Remove from {singular} relationship",
    }
    for key, label in action_map.items():
        if suffix == key:
            return label

    # Custom actions or download endpoints
    if "download" in operation_id.lower():
        return f"Download {resource_label}"
    return operation_id.replace("_", " ").title()


def simplify_schema(schema: dict) -> dict:
    if not schema:
        return {"type": "string"}
    if "$ref" in schema:
        return {"type": "string"}
    t = schema.get("type", "string")
    if t == "array":
        return {
            "type": "array",
            "items": simplify_schema(schema.get("items", {})),
        }
    if t == "object":
        return {"type": "object"}
    if "enum" in schema:
        return {"type": "string", "enum": schema["enum"]}
    return {"type": t}


REF_PREFIX = "#/components/schemas/"
MAX_PROPS = 40
MAX_ENUM = 40


def _ref_name(ref):
    if isinstance(ref, str) and ref.startswith(REF_PREFIX):
        return ref.split("/")[-1]
    return None


def _deref(schema, schemas):
    """Resolve one $ref level. Returns (schema_name_or_None, resolved_schema)."""
    if isinstance(schema, dict) and "$ref" in schema:
        name = _ref_name(schema["$ref"])
        if name:
            return name, schemas.get(name, {})
    if isinstance(schema, dict):
        return None, schema
    return None, {}


def compact_type(schema, schemas, depth=2):
    """Compact a property schema: type + nullable + enum (+ items / nested properties).

    $refs are resolved; enums survive; nested objects recurse up to `depth` levels.
    """
    if not isinstance(schema, dict):
        return {"type": "string"}
    if "$ref" in schema:
        _, resolved = _deref(schema, schemas)
        return compact_type(resolved, schemas, depth)
    t = schema.get("type", "string")
    out = {"type": t}
    if schema.get("nullable"):
        out["nullable"] = True
    if "enum" in schema:
        vals = schema["enum"]
        if len(vals) > MAX_ENUM:
            out["enum"] = vals[:MAX_ENUM] + ["..."]
        else:
            out["enum"] = vals
    if t == "array" and isinstance(schema.get("items"), dict):
        out["items"] = compact_type(schema["items"], schemas, max(depth - 1, 0))
    if t == "object" and depth > 0 and isinstance(schema.get("properties"), dict):
        props = schema["properties"]
        names = list(props.keys())
        if len(names) > MAX_PROPS:
            out["note"] = "properties truncated at %d" % MAX_PROPS
            names = names[:MAX_PROPS]
        out["properties"] = {
            k: compact_type(props[k], schemas, depth - 1) for k in names
        }
        if schema.get("required"):
            out["required"] = schema["required"]
    return out


def _rel_data_summary(data_schema, schemas):
    """Summarize a relationship's data node: kind + target resource type + required keys."""
    if not isinstance(data_schema, dict):
        return {}
    if data_schema.get("type") == "array":
        _, item = _deref(data_schema.get("items", {}), schemas)
        target = (item.get("properties", {}).get("type", {}) or {}).get("enum")
        return {
            "kind": "toMany",
            "data": {
                "type": ({"enum": target} if target else {"type": "string"}),
                "id": {"type": "string"},
                "required": item.get("required", ["type", "id"]),
            },
        }
    _, data = _deref(data_schema, schemas)
    target = (data.get("properties", {}).get("type", {}) or {}).get("enum")
    return {
        "kind": "toOne",
        "data": {
            "type": ({"enum": target} if target else {"type": "string"}),
            "id": {"type": "string"},
            "required": data.get("required", ["type", "id"]),
        },
    }


def body_summary(schema, schemas):
    """Build a compact LLM-friendly body schema from a JSON:API Create/Update request ref.

    Returns (schema_name, summary) - summary mirrors the actual JSON:API payload:
    { data: { type: {enum}, attributes: {...}, relationships: {...}, required: [...] } }
    """
    name, root = _deref(schema, schemas)
    if not name or not root:
        return name, None
    _, data = _deref(root.get("properties", {}).get("data", {}), schemas)
    props = data.get("properties", {})
    data_out = OrderedDict()
    type_s = props.get("type", {})
    data_out["type"] = (
        {"enum": type_s["enum"]} if "enum" in type_s else {"type": "string"}
    )
    attrs = props.get("attributes", {})
    if isinstance(attrs.get("properties"), dict):
        node = {
            "type": "object",
            "properties": {
                k: compact_type(v, schemas, 2) for k, v in attrs["properties"].items()
            },
        }
        if attrs.get("required"):
            node["required"] = attrs["required"]
        data_out["attributes"] = node
    rels = props.get("relationships", {})
    if isinstance(rels.get("properties"), dict):
        node = {
            "type": "object",
            "properties": {
                k: _rel_data_summary(v.get("properties", {}).get("data", {}), schemas)
                for k, v in rels["properties"].items()
            },
        }
        if rels.get("required"):
            node["required"] = rels["required"]
        data_out["relationships"] = node
    if data.get("required"):
        data_out["required"] = data["required"]
    return name, {"data": data_out}


def resource_summary(res_name, schemas):
    """Summarize a JSON:API resource schema: resourceType + attributes + relationships."""
    res = schemas.get(res_name, {})
    props = res.get("properties", {})
    if not props:
        return None
    t = props.get("type", {}).get("enum")
    out = OrderedDict()
    out["resourceType"] = t[0] if t else None
    attrs = props.get("attributes", {})
    if isinstance(attrs.get("properties"), dict):
        node = {
            "type": "object",
            "properties": {
                k: compact_type(v, schemas, 2) for k, v in attrs["properties"].items()
            },
        }
        if attrs.get("required"):
            node["required"] = attrs["required"]
        out["attributes"] = node
    rels = props.get("relationships", {})
    entries = {}
    if isinstance(rels.get("properties"), dict):
        entries = {
            k: _rel_data_summary(v.get("properties", {}).get("data", {}), schemas)
            for k, v in rels["properties"].items()
        }
    out["relationships"] = {"type": "object", "properties": entries}
    return out


def response_summary(schema, schemas):
    """Compact description of a success response body (kind + where the payload lives)."""
    _, root = _deref(schema, schemas)
    if not root:
        return None
    props = root.get("properties", {})
    data_s = props.get("data", {})
    out = OrderedDict()
    if data_s.get("type") == "array":
        rname, _ = _deref(data_s.get("items", {}), schemas)
        out["kind"] = "collection"
        out["data"] = {"resourceRef": rname} if rname else {}
    elif isinstance(data_s, dict) and "$ref" in data_s:
        rname, _ = _deref(data_s, schemas)
        out["kind"] = "single"
        out["data"] = {"resourceRef": rname} if rname else {}
    elif isinstance(data_s.get("properties"), dict):
        t = data_s["properties"].get("type", {}).get("enum")
        out["kind"] = "reference"
        out["data"] = {"resourceType": t[0] if t else None}
    else:
        return None
    inc = props.get("included", {})
    inc_types = []
    if inc.get("type") == "array":
        items = inc.get("items", {})
        variants = items.get("anyOf") or ([items] if "$ref" in items else [])
        for variant in variants:
            vname, _ = _deref(variant, schemas)
            if vname:
                vt = schemas.get(vname, {}).get("properties", {}).get("type", {}).get("enum")
                if vt:
                    inc_types.append(vt[0])
    if inc_types:
        out["included"] = sorted(set(inc_types))
    return out


def response_resource_names(schema, schemas):
    """Names of all component schemas referenced by a success response body."""
    _, root = _deref(schema, schemas)
    if not root:
        return []
    props = root.get("properties", {})
    names = []
    data_s = props.get("data", {})
    if data_s.get("type") == "array":
        n, _ = _deref(data_s.get("items", {}), schemas)
        if n:
            names.append(n)
    elif isinstance(data_s, dict) and "$ref" in data_s:
        n, _ = _deref(data_s, schemas)
        if n:
            names.append(n)
    inc = props.get("included", {})
    if inc.get("type") == "array":
        items = inc.get("items", {})
        for variant in items.get("anyOf") or ([items] if "$ref" in items else []):
            n, _ = _deref(variant, schemas)
            if n:
                names.append(n)
    return names


def extract_param(param: dict) -> dict:
    return {
        "name": param["name"],
        "required": param.get("required", False),
        "description": param.get("description", ""),
        "schema": simplify_schema(param.get("schema", {})),
    }


def merge_params(path_item: dict, operation: dict, location: str) -> list:
    """Merge path-level and operation-level parameters for a given 'in' location."""
    merged = {}
    # Path-level first (lower priority)
    for p in path_item.get("parameters", []):
        if p.get("in") == location:
            merged[p["name"]] = extract_param(p)
    # Operation-level overrides
    for p in operation.get("parameters", []):
        if p.get("in") == location:
            merged[p["name"]] = extract_param(p)
    return list(merged.values())


def has_body(operation: dict) -> bool:
    rb = operation.get("requestBody", {})
    return bool(rb) and bool(rb.get("content", {}).get("application/json"))


def derive_category(operation: dict, path: str) -> str:
    tags = operation.get("tags", [])
    if tags:
        return tags[0]
    parts = path.strip("/").split("/")
    if len(parts) >= 2:
        return humanize(parts[1])
    return "General"


def generate(spec_path: str, output_path: str):
    with open(spec_path) as f:
        spec = json.load(f)

    schemas = spec.get("components", {}).get("schemas", {})
    tools = []
    body_schemas = OrderedDict()
    resource_schemas = OrderedDict()
    stats = {"total": 0, "by_method": {}}

    for path, path_item in spec.get("paths", {}).items():
        for method in ("get", "post", "patch", "put", "delete"):
            if method not in path_item:
                continue
            op = path_item[method]

            path_params = merge_params(path_item, op, "path")
            query_params = merge_params(path_item, op, "query")

            op_id = op.get("operationId")
            if not op_id:
                clean = re.sub(r"[^a-zA-Z0-9]", "_", path)
                op_id = f"{method}_{clean}"

            summary = derive_summary(op_id, method.upper(), path)

            tool = OrderedDict()
            tool["name"] = slugify(op_id)
            tool["summary"] = summary
            tool["description"] = summary
            tool["method"] = method.upper()
            tool["path"] = path
            tool["category"] = derive_category(op, path)
            tool["pathParams"] = path_params
            tool["queryParams"] = query_params
            tool["hasBody"] = has_body(op)

            # Request body schema (JSON:API Create/Update request, $refs resolved)
            rb = op.get("requestBody", {}).get("content", {}).get("application/json")
            if rb and isinstance(rb.get("schema"), dict):
                bs_name, bs = body_summary(rb["schema"], schemas)
                if bs_name and bs:
                    body_schemas[bs_name] = bs
                    tool["bodySchemaRef"] = bs_name

            # Success response shape + referenced resource schemas
            responses = op.get("responses", {})
            for code in ("200", "201"):
                rc = responses.get(code, {}).get("content", {}).get("application/json")
                if rc and isinstance(rc.get("schema"), dict):
                    rs = response_summary(rc["schema"], schemas)
                    if rs:
                        tool["responseSchema"] = rs
                        for res_name in response_resource_names(rc["schema"], schemas):
                            if res_name not in resource_schemas:
                                rsum = resource_summary(res_name, schemas)
                                if rsum:
                                    resource_schemas[res_name] = rsum
                    break

            tools.append(tool)
            stats["total"] += 1
            stats["by_method"][method.upper()] = (
                stats["by_method"].get(method.upper(), 0) + 1
            )

    tools.sort(key=lambda t: (t["category"], t["name"]))

    output = {
        "$comment": "Auto-generated from App Store Connect OpenAPI. Do not edit by hand.",
        "apiVersion": spec.get("info", {}).get("version", "unknown"),
        "baseUrl": spec.get("servers", [{}])[0].get(
            "url", "https://api.appstoreconnect.apple.com"
        ),
        "stats": stats,
        "categories": sorted(set(t["category"] for t in tools)),
        "bodySchemas": body_schemas,
        "resourceSchemas": resource_schemas,
        "tools": tools,
    }

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        json.dump(output, f, separators=(",", ":"))

    print(f"Generated {len(tools)} tools across {len(output['categories'])} categories")
    print(f"  By method: {stats['by_method']}")
    print(f"  API version: {output['apiVersion']}")
    print(f"  Output: {out}")


if __name__ == "__main__":
    spec = sys.argv[1] if len(sys.argv) > 1 else "openapi.oas.json"
    output = sys.argv[2] if len(sys.argv) > 2 else "src/tools.json"
    generate(spec, output)
