---
name: create-offer-codes
description: "Use when the user wants to create promo codes, offer codes, custom codes, or win-back offers for a subscription or in-app purchase."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Create offer codes for subscriptions or in-app purchases

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `product_id` (required): subscription or inAppPurchase resource id.
- `kind` (required): subscription | iap

## Steps

1. Subscription: `subscriptionOfferCodes_createInstance` with `_body` = { data: { type: 'subscriptionOfferCodes', attributes: { name, offerEligibility: 'ACTIVE' | 'ALL', customerEligibilities: ['NEW', 'EXISTING', 'WIN_BACK'], offerMode: 'FREE_TRIAL' | 'PAY_AS_YOU_GO' | 'PAY_UP_FRONT', duration: 'ONE_MONTH' | ..., numberOfPeriods, targetSubscriptionPlanType: 'AUTO_RENEWABLE' }, relationships: { subscription: { data: { type: 'subscriptions', id: '<product_id>' } }, prices: { data: [{ type: 'subscriptionPrices', id }] } } } }.
2. IAP: `inAppPurchaseOfferCodes_createInstance` with attributes { name, customerEligibilities } and relationships { inAppPurchase, prices }.
3. Custom (one-time) codes: `subscriptionOfferCodeCustomCodes_createInstance` (relationships offerCode, attributes customCode, numberOfPeriods, expirationDate) or `inAppPurchaseOfferCodeCustomCodes_createInstance`.
4. Win-back offers for subscriptions: `winBackOffers_createInstance` (attributes referenceName, offerId, duration, offerMode, periodCount, customerEligibility..., relationships subscription + prices).
5. Verify: `subscriptions_offerCodes_getToManyRelated` (path id=subscription) or `inAppPurchases_offerCodes...`.

## Pitfalls

- Offer code `prices` must reference subscriptionPrices / inAppPurchasePrices already created for the product; create pricing first (see create-subscription / iap-localize-price-submit).
- offerId and productId are immutable identifiers.
