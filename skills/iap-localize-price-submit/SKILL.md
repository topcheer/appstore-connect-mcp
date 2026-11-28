---
name: iap-localize-price-submit
description: "Use when the user wants to set up, localize, price, or submit an in-app purchase / consumable / non-consumable. Note: IAP products themselves must be created in App Store Connect (the API cannot create them); the API manages localizations, prices, and submission."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Localize, price, and submit an in-app purchase (IAP v2)

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `iap_id` (required): inAppPurchase (v2) resource id.

## Steps

1. Inspect: `inAppPurchases_getInstance` with path id=<iap_id>, include=inAppPurchaseLocalizations,inAppPurchasePriceSchedule; report name, productId, type, state.
2. Localization: `inAppPurchaseLocalizations_createInstance` with `_body` = { data: { type: 'inAppPurchaseLocalizations', attributes: { name, locale, description }, relationships: { inAppPurchaseV2: { data: { type: 'inAppPurchases', id: '<iap_id>' } } } } }. Update with `inAppPurchaseLocalizations_updateInstance`.
3. Price: `inAppPurchasePriceSchedules_createInstance` with relationships { inAppPurchase: { data: { type: 'inAppPurchases', id: '<iap_id>' } }, baseTerritory (e.g. USA), manualPrices: { data: [{ type: 'inAppPurchasePrices', id }] } }. Note this endpoint uses the relationship name `inAppPurchase` (not `inAppPurchaseV2`) and prices are `inAppPurchasePrices`; ids come from an existing schedule (`inAppPurchasePriceSchedules_manualPrices_getToManyRelated`) or its equalized prices (`inAppPurchasePricePoints_equalizations_getToManyRelated`).
4. Submit: `inAppPurchaseSubmissions_createInstance` with relationships.inAppPurchaseV2. Then re-read `inAppPurchases_getInstance` and watch attributes.state until APPROVED (or REJECTED).

## Pitfalls

- Relationship names are inconsistent on purpose by Apple: localizations and submissions use `inAppPurchaseV2`; the price schedule uses `inAppPurchase`. Copy them exactly from get_tool_details.
- IAP products are created in App Store Connect UI; the API cannot create them.
- Review screenshot per localization is required before submission for some IAP types.
