---
name: set-up-webhooks
description: "Use when the user wants to create, test, or list App Store Connect server notifications / webhooks and their deliveries."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Set up App Store Connect webhooks (notifications)

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `app_id` (optional): App resource id (or omit for all apps if the key allows).

## Steps

1. List: `apps_webhooks_getToManyRelated` with path id=<app_id> (use `webhooks_getInstance` only when you already have a webhook id).
2. Create: `webhooks_createInstance` with `_body` = { data: { type: 'webhooks', attributes: { name, url: 'https://...', enabled: true, eventTypes: ['APP_STORE_REVIEW_REQUESTED', 'TESTFLIGHT_BETA_TESTER_CONFIRMATION', ...] }, relationships: { app: { data: { type: 'apps', id: '<app_id>' } } } } }. Call get_tool_details for the full eventType enum.
3. Test: `webhookPings_createInstance` with relationships.webhook, then `webhooks_deliveries_getToManyRelated` (path id=webhookId) to inspect deliveryState SUCCEEDED | FAILED | PENDING and response.
4. Rotate secret: `webhooks_updateInstance` attributes.secret; verify signature header on your endpoint.

## Pitfalls

- Endpoint must be HTTPS with a valid certificate and respond within 20 seconds.
- A webhook can be attached to one app; create one per app for app-scoped events.
