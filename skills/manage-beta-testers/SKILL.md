---
name: manage-beta-testers
description: "Use when the user wants to add, invite, remove, list, or import beta testers, or manage tester membership in a beta group."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Add or remove TestFlight beta testers

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `group_id` (required): betaGroup resource id.

## Steps

1. Check existing testers: `betaTesters_getCollection` with `filter[email]`=<email>, `filter[app]`=<app id>. Record testerId if present.
2. New tester + group in one call: `betaTesters_createInstance` with `_body` = { data: { type: 'betaTesters', attributes: { email, firstName, lastName }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: '<group_id>' }] } } } }.
3. Existing tester into the group: `betaGroups_betaTesters_createToManyRelationship` with path id=<group_id> and `_body` = { data: [{ type: 'betaTesters', id: testerId }] }.
4. Limit which builds a tester sees: `betaTesters_builds_createToManyRelationship` (path id=testerId) with builds; otherwise they get all builds the group has.
5. Remove: `betaTesters_betaGroups_deleteToManyRelationship` or `betaTesters_deleteInstance`. List: `betaGroups_betaTesters_getToManyRelated` (path id=<group_id>).

## Pitfalls

- Tester emails are Apple IDs; duplicates across groups of the same app are the same betaTester resource - link, do not recreate.
- Deleting a betaTester removes them from all groups of the app.
