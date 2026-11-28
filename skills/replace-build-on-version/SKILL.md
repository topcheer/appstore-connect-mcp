---
name: replace-build-on-version
description: "Use when the user wants to swap, replace, attach, or change the build of an app store version (e.g. after rejection, or to attach a newer build before submission)."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Replace the build attached to a version

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `version_id` (required): appStoreVersion resource id.
- `build_id` (optional): Processed build id (optional; if omitted, list the latest valid builds so the user can choose).

## Steps

1. Find candidate builds: `builds_getCollection` with query `filter[app]` (app id from the version), `filter[preReleaseVersion.version]`=<versionString> (must equal the version's versionString), `filter[processingState]`=VALID, `sort`=-uploadedDate, `limit`=10, `fields[builds]=version,uploadedDate,expired,processingState`. Pick `buildId`.
2. Attach: `appStoreVersions_updateInstance` with path id=<version_id> and `_body` = { data: { type: 'appStoreVersions', id: '<version_id>', relationships: { build: { data: { type: 'builds', id: buildId } } } } }.
3. Verify with `builds_appStoreVersion_getToOneRelated` (path id=buildId) or `appStoreVersions_getInstance` with include=build.

## Pitfalls

- Only allowed while the version is in PREORDER_READY_FOR_REVIEW, READY_FOR_REVIEW, DEVELOPER_REJECTED, REPLACED_WITH_NEW_DEVELOPER_REJECTED_VERSION, REJECTED, or INVALID_BINARY; also triggered automatically when a build expires.
- The build's preReleaseVersion.version must match the versionString; a build uploaded with a different CFBundleShortVersionString is invisible to this filter.
- If the version is WAITING_FOR_REVIEW it cannot be changed - it must be withdrawn first.
