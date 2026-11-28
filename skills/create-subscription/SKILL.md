---
name: create-subscription
description: "Use when the user wants to create, add, or set up an auto-renewable subscription, subscription group, subscription price, introductory offer, or submit a subscription for review."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Create an auto-renewable subscription with pricing and submit it

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `app_id` (required): App resource id.

## Steps

1. Group: `apps_subscriptionGroups_getToManyRelated` with path id=<app_id> (filter[name] if you know the reference name); create if missing with `subscriptionGroups_createInstance` (_body attributes { referenceName }, relationships.app). Record `groupId`.
2. Subscription: `subscriptions_createInstance` with `_body` = { data: { type: 'subscriptions', attributes: { name, productId, subscriptionPeriod: 'ONE_MONTH' | 'ONE_WEEK' | 'ONE_YEAR' | ..., familySharable: false, groupLevel: 1 }, relationships: { group: { data: { type: 'subscriptionGroups', id: groupId } } } } }. Record `subscriptionId`. productId is immutable.
3. Localization: `subscriptionLocalizations_createInstance` with attributes { name, locale, description } and relationships.subscription. One per locale.
4. Price point: `subscriptions_pricePoints_getToManyRelated` with path id=subscriptionId and `filter[territory]`=USA (territory ids are ISO codes from `territories_getCollection`). Pick customerPrice, record `pricePointId`.
5. Price: `subscriptionPrices_createInstance` with `_body` = { data: { type: 'subscriptionPrices', attributes: { startDate: null, preserveCurrentPrice: false }, relationships: { subscription: {...}, territory: { data: { type: 'territories', id: 'USA' } }, subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: pricePointId } } } } }.
6. Review screenshot (required for first submission): `subscriptionAppStoreReviewScreenshots_createInstance` with attributes { fileName, fileSize } and relationships.subscription; upload bytes, then `subscriptionAppStoreReviewScreenshots_updateInstance` with uploaded=true.
7. Submit: `subscriptionSubmissions_createInstance` with relationships.subscription. Then poll `subscriptions_getInstance` (path id=subscriptionId) and read attributes.state until APPROVED (or REJECTED - inspect the submission items).
8. Optional introductory offer: `subscriptionIntroductoryOffers_createInstance` (relationships subscription + territory + subscriptionPricePoint, attributes duration, numberOfPeriods, offerMode).

## Pitfalls

- The subscription must be in state MISSING_METADATA until localization, price and screenshot exist; only then submit.
- Only one submission can be in flight at a time; a rejected submission needs the items fixed and a new submission.
- productId and subscriptionPeriod cannot be changed after creation.
