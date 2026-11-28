---
name: create-iap
description: "Use when the user wants to create, add, set up, localize, price, or submit an in-app purchase / consumable / non-consumable / non-renewing subscription (IAP v2)."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Create, localize, price, and submit an in-app purchase (IAP v2)

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `app_id` (required): App resource id the IAP belongs to.
- `iap_id` (optional): Existing inAppPurchases (v2) resource id when localizing/pricing/submitting an existing product; omit to create a new one.

## Steps

1. Create (skip if iap_id is known): `inAppPurchasesV2_createInstance` (POST /v2/inAppPurchases) with `_body` = { data: { type: 'inAppPurchases', attributes: { name, productId, inAppPurchaseType: 'CONSUMABLE' | 'NON_CONSUMABLE' | 'NON_RENEWING_SUBSCRIPTION', familySharable: false, reviewNote }, relationships: { app: { data: { type: 'apps', id: '<app_id>' } } } } }. Record `iapId` = data.id. productId is immutable.
2. Inspect: `inAppPurchasesV2_getInstance` (path id=<iap_id>); localizations via `inAppPurchasesV2_inAppPurchaseLocalizations_getToManyRelated`; state is in attributes.state (MISSING_METADATA until steps 3-4 are done).
3. Localization: `inAppPurchaseLocalizations_createInstance` with `_body` = { data: { type: 'inAppPurchaseLocalizations', attributes: { name, locale, description }, relationships: { inAppPurchaseV2: { data: { type: 'inAppPurchases', id: iapId } } } } }. One per locale; update with `inAppPurchaseLocalizations_updateInstance`.
4. Price point: `inAppPurchasesV2_pricePoints_getToManyRelated` with path id=<iap_id> and `filter[territory]`=USA (territory ids are ISO codes from `territories_getCollection`); pick customerPrice, record `inAppPurchasePriceId`.
5. Price: `inAppPurchasePriceSchedules_createInstance` with relationships { inAppPurchase: { data: { type: 'inAppPurchases', id: iapId } }, baseTerritory: { data: { type: 'territories', id: 'USA' } }, manualPrices: { data: [{ type: 'inAppPurchasePrices', id: inAppPurchasePriceId }] } }. Note this endpoint uses `inAppPurchase` (not `inAppPurchaseV2`).
6. Optional review image: `inAppPurchaseImages_createInstance` (attributes fileName, fileSize, relationships.inAppPurchaseV2), upload bytes, then `inAppPurchaseImages_updateInstance` with uploaded=true.
7. Submit: `inAppPurchaseSubmissions_createInstance` with relationships.inAppPurchaseV2 = iapId. Then re-read `inAppPurchasesV2_getInstance` and watch attributes.state until APPROVED (or REJECTED - inspect the submission items).

## Pitfalls

- Relationship names differ per endpoint: create/get/localize/submit use `inAppPurchases` / `inAppPurchaseV2`; the price schedule uses `inAppPurchase` and its manualPrices are `inAppPurchasePrices` (ids from pricePoints). Copy them exactly from get_tool_details.
- productId and inAppPurchaseType are immutable after creation.
- A review screenshot per localization is required before the first submission for some IAP types.
- Only one submission can be in flight at a time.
