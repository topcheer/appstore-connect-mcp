---
name: testflight-distribute
description: "Use when the user wants to distribute, push, or share a build with testers, create or manage beta groups, enable public link, or submit a build for external TestFlight beta review."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Distribute a build to testers via TestFlight

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `app_id` (required): App resource id.
- `build_id` (required): Processed build id (see find-latest-build).
- `external` (optional): true for external testers (requires beta review); false/omitted for internal group (App Store Connect users only, up to 100).

## Steps

1. Find or create the group: `betaGroups_getCollection` with `filter[app]`=<app_id>, `filter[name]`=<group name>. If missing, `betaGroups_createInstance` with `_body` = { data: { type: 'betaGroups', attributes: { name, isInternalGroup: !external, hasAccessToAllBuilds: false, publicLinkEnabled: false, feedbackEnabled: true }, relationships: { app: { data: { type: 'apps', id: '<app_id>' } } } } }. Record `groupId`.
2. Attach the build: `betaGroups_builds_createToManyRelationship` with path id=groupId and `_body` = { data: [{ type: 'builds', id: '<build_id>' }] }.
3. External only - export compliance: `builds_appEncryptionDeclaration_getToOneRelated` (path id=<build_id>) to see if the build already has a declaration; otherwise `apps_appEncryptionDeclarations_getToManyRelated` (path id=<app_id>) to find a reusable one. Create with `appEncryptionDeclarations_createInstance`: attributes { containsProprietaryCryptography: true, containsThirdPartyCryptography: false, availableOnFrenchStore: true, appDescription }, relationships.app. Then attach it to the build: `builds_appEncryptionDeclaration_updateToOneRelationship` with `_body` = { data: { type: 'appEncryptionDeclarations', id } }.
4. External only - beta review: `betaAppReviewSubmissions_createInstance` with `_body` = { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: '<build_id>' } } } } }. Poll `builds_betaAppReviewSubmission_getToOneRelated` until attributes.betaReviewState is APPROVED (usually minutes to a day). Internal groups skip this.
5. Add testers: see manage-beta-testers. Enable a public link with `betaGroups_updateInstance` attributes { publicLinkEnabled: true, publicLinkLimitEnabled, publicLinkLimit }; the link itself (attributes.publicLink) is read-only and appears on the group after enabling.
6. Verify: `betaGroups_builds_getToManyRelated` and `betaGroups_getInstance`.

## Pitfalls

- Internal groups: testers must already be App Store Connect users with access to the app. External groups: testers can be any email, but the build must pass beta review once per version.
- Beta review is required for the first build of each version; later builds of the same version usually do not need another review.
- Export compliance must be resolved before external distribution; missing declarations block review.
