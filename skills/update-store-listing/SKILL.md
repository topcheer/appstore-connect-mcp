---
name: update-store-listing
description: "Use when the user wants to edit, update, or set app store description, keywords, promotional text, what's new text, support/marketing URL, screenshots ordering text, or localize the product page."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Update App Store listing metadata (description, keywords, what's new, URLs)

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `version_id` (required): appStoreVersion resource id.
- `locale` (optional): Locale tag, e.g. en-US, zh-Hans. Defaults to the app's primaryLocale.

## Steps

1. Get localizations: `appStoreVersions_appStoreVersionLocalizations_getToManyRelated` with path id=<version_id>, `filter[locale]`=<locale> (optional). Record `localizationId` and the app's primaryLocale from `apps_getInstance` if needed.
2. If the locale is missing: `appStoreVersionLocalizations_createInstance` with `_body` = { data: { type: 'appStoreVersionLocalizations', attributes: { locale }, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: '<version_id>' } } } } }.
3. Edit: `appStoreVersionLocalizations_updateInstance` with path id=localizationId and only the attributes to change: description, keywords (comma separated, <=100 characters), promotionalText (<=170), marketingUrl, supportUrl, whatsNew (required for updates), and for the primary locale the keywords are the ones that matter for search.
4. Verify with `appStoreVersionLocalizations_getInstance`.

## Pitfalls

- PATCH only the attributes you change; sending empty strings clears fields.
- whatsNew is required for every new version except the first; missing it leaves the version not submittable.
- Keywords are shared across locales? No - each locale has its own; the primary locale carries the most weight.
