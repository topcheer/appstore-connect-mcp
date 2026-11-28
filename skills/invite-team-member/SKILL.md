---
name: invite-team-member
description: "Use when the user wants to invite, add, or remove team members, change user roles, or control which apps a user can see."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Invite users and manage App Store Connect team access

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Steps

1. List: `users_getCollection` with fields[users]=username,firstName,lastName,roles,allAppsVisible; pending invites via `userInvitations_getCollection`.
2. Invite: `userInvitations_createInstance` with `_body` = { data: { type: 'userInvitations', attributes: { email, firstName, lastName, roles: ['ADMIN' | 'FINANCE' | 'ACCOUNT_HOLDER' | 'SALES' | 'MARKETING' | 'APP_MANAGER' | 'DEVELOPER' | 'ACCESS_TO_REPORTS' | 'CUSTOMER_SUPPORT' | 'CREATE_APPS'], allAppsVisible: false }, relationships: { visibleApps: { data: [{ type: 'apps', id }] } } } }.
3. Change visible apps for an existing user: `users_visibleApps_replaceToManyRelationship` with path id=userId and `_body` = { data: [{ type: 'apps', id }, ...] }. Roles: `users_updateInstance` attributes.roles.
4. Remove: `users_deleteInstance` or `userInvitations_deleteInstance`.

## Pitfalls

- ACCOUNT_HOLDER cannot be invited via API; the last ADMIN cannot be removed.
- allAppsVisible=true ignores visibleApps.
