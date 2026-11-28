---
name: manage-screenshots
description: "Use when the user wants to upload, add, reorder, replace, or delete App Store screenshots or app previews (videos) for a version."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Manage App Store screenshots and previews

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `localization_id` (required): appStoreVersionLocalization resource id (from update-store-listing step 1).

## Steps

1. List sets: `appStoreVersionLocalizations_appScreenshotSets_getToManyRelated` with path id=<localization_id>, include=appScreenshots. Each set has a screenshotDisplayType (e.g. APP_IPHONE_67, APP_IPAD_PRO_3GEN_129).
2. Create a set if needed: `appScreenshotSets_createInstance` with `_body` = { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType }, relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: '<localization_id>' } } } } }. Record `setId`.
3. Reserve the image: `appScreenshots_createInstance` with `_body` = { data: { type: 'appScreenshots', attributes: { fileName, fileSize }, relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } } } }. The response has `uploadOperations` (method, url, length, offset, requestHeaders) - upload the bytes to those URLs (this MCP cannot transfer binary; do it with curl/HTTP from the client) and compute the checksum.
4. Commit: `appScreenshots_updateInstance` with path id=<screenshot id> and `_body` = { data: { type: 'appScreenshots', id, attributes: { uploaded: true, sourceFileChecksum } } }. Poll `appScreenshots_getInstance` until assetDeliveryState.state is COMPLETE.
5. Reorder: `appScreenshotSets_appScreenshots_replaceToManyRelationship` with path id=setId and `_body` = { data: [{ type: 'appScreenshots', id }, ...] } in the desired order. Delete with `appScreenshots_deleteInstance`.
6. Videos: same flow with appPreviewSets / appPreviews (appPreviewSets_createInstance with previewType, appPreviews_createInstance with video).

## Pitfalls

- A set needs 1-10 screenshots (some display types require at least 3) before the version can be submitted.
- Checksum format and size limits per display type are in get_tool_details(appScreenshots_updateInstance) - verify there before committing.
- Until uploaded=true the reservation expires; re-reserve if the upload did not finish.
