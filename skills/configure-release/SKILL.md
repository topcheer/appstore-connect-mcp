---
name: configure-release
description: "Use when the user asks about manual release, automatic release, scheduled release, phased release, release after approval, or releasing an approved version now."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Configure release type, schedule, phased release, or release now

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `version_id` (required): appStoreVersion resource id (or resolve from app_id via apps_appStoreVersions_getToManyRelated).

## Steps

1. Read current settings: `appStoreVersions_getInstance` with path id=<version_id> and `fields[appStoreVersions]=versionString,appStoreState,releaseType,earliestReleaseDate`. Also `appStoreVersions_appStoreVersionPhasedRelease_getToOneRelated` to see if a phased release exists.
2. Set the release type: `appStoreVersions_updateInstance` with path id=<version_id> and `_body` = { data: { type: 'appStoreVersions', id: '<version_id>', attributes: { releaseType: 'MANUAL' | 'AFTER_APPROVAL' | 'SCHEDULED' } } }. For SCHEDULED also set `earliestReleaseDate` (ISO 8601 with time, in the past is rejected).
3. Phased release (optional, after approval only): if none exists, `appStoreVersionPhasedReleases_createInstance` with `_body` = { data: { type: 'appStoreVersionPhasedReleases', attributes: { phasedReleaseState: 'ACTIVE' }, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: '<version_id>' } } } } }. Later control with `appStoreVersionPhasedReleases_updateInstance`: phasedReleaseState ACTIVE | PAUSED | COMPLETE.
4. Release a MANUAL version now (only when appStoreState is PENDING_DEVELOPER_RELEASE): `appStoreVersionReleaseRequests_createInstance` with `_body` = { data: { type: 'appStoreVersionReleaseRequests', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: '<version_id>' } } } } }.
5. Verify with `appStoreVersions_getInstance` and report releaseType, earliestReleaseDate, phasedRelease state and appStoreState.

## Pitfalls

- PENDING_DEVELOPER_RELEASE means approved and waiting for the developer - that is when step 4 applies, not before.
- Phased release must be enabled before the version is approved; it cannot be started retroactively.
- Changing releaseType is a PATCH of attributes only - never send relationships unless you intend to change the build.
