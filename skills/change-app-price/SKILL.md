---
name: change-app-price
description: "Use when the user wants to change, set, schedule, or inspect the app's price (tier, price point, base territory, manual/automatic prices)."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Change the app price or price schedule

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `app_id` (required): App resource id.

## Steps

1. Current schedule: `apps_appPriceSchedule_getToOneRelated` with path id=<app_id> and include=manualPrices,baseTerritory.
2. Choose base territory (e.g. USA) via `territories_getCollection`; territory ids are ISO codes.
3. Choose the price point: `apps_appPricePoints_getToManyRelated` with path id=<app_id> and `filter[territory]`=USA; pick customerPrice, record `pricePointId`.
4. Create a new schedule (this is how price changes are applied): `appPriceSchedules_createInstance` with `_body` = { data: { type: 'appPriceSchedules', relationships: { app: { data: { type: 'apps', id: '<app_id>' } }, baseTerritory: { data: { type: 'territories', id: 'USA' } }, manualPrices: { data: [{ type: 'appPrices', id: pricePointId }] } } } }. Optional attributes.startDate schedules the change. (The spec names the relationship type `appPrices` while the ids come from appPricePoints; if Apple rejects the type, retry with `appPricePoints`.)
5. Verify: `appPriceSchedules_manualPrices_getToManyRelated` and `appPriceSchedules_automaticPrices_getToManyRelated` (other territories follow automatically).

## Pitfalls

- There is no PATCH for manual prices; every change is a new appPriceSchedule.
- A schedule with a future startDate stays pending until that date; confirm with `apps_appPriceSchedule_getToOneRelated`.
