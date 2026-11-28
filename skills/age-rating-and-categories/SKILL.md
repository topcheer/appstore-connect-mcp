---
name: age-rating-and-categories
description: "Use when the user wants to set or change the age rating declaration, age rating override, primary/secondary categories, or app info localizations (subtitle, privacy policy URL, categories)."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Set age rating, app categories, and app info

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `app_id` (required): App resource id.

## Steps

1. App info: `apps_appInfos_getToManyRelated` with path id=<app_id>; record `appInfoId` and its appInfoLocalizations.
2. Age rating: `appInfos_ageRatingDeclaration_getToOneRelated` with path id=appInfoId, then `ageRatingDeclarations_updateInstance` with path id=<declaration id> and attributes (advertising, alcoholTobaccoOrDrugUseOrReferences, contests, gambling, gunsOrOtherWeapons, kidsAgeBand, lootBox, medicalOrTreatmentInformation, messagingAndChat, parentalControls, profanityOrCrudeHumor, sexualContentGraphicAndNudity, sexualContentOrNudity, horrorOrFearThemes, matureOrSuggestiveThemes, unrestrictedWebAccess, userGeneratedContent, violenceCartoonOrFantasy, violenceRealistic, violenceRealisticProlongedGraphicOrSadistic, ageRatingOverride, koreaAgeRatingOverride).
3. Categories: `appCategories_getCollection` to find ids, then `appInfos_updateInstance` with path id=appInfoId and relationships { primaryCategory, primarySubcategoryOne, primarySubcategoryTwo, secondaryCategory, ... } each as { data: { type: 'appCategories', id } }.
4. Subtitle / privacy policy URL / name per locale: `appInfoLocalizations_createInstance` or `appInfoLocalizations_updateInstance` (attributes name, subtitle, privacyPolicyUrl, privacyChoicesUrl).

## Pitfalls

- Categories must be leaf categories (no children) and second category must differ from the first.
- Age rating answers are required before the first submission of any version.
