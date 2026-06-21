#!/usr/bin/env python3
"""
generate-tools.py — App Store Connect OpenAPI → MCP tools.json

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

    tools = []
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
