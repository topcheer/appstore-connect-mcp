---
name: submit-for-review
description: "Use when the user wants to submit, send, or hand off a version to Apple App Review (submit for review, send to review, add to review, ready for review). Chains app -> appStoreVersion -> reviewSubmission -> reviewSubmissionItem -> submitted."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Submit an app version for App Review

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `app_id` (required): App resource id (numeric). Find via apps_getCollection filter[bundleId] if unknown.
- `platform` (optional): IOS | MAC_OS | TV_OS | VISION_OS (default IOS).

## Steps

1. Pick the version to submit: `apps_appStoreVersions_getToManyRelated` with path id=<app_id>, query `filter[platform]`=<platform> and `fields[appStoreVersions]=versionString,appStoreState,build`. Candidate states that can be submitted: PREORDER_READY_FOR_REVIEW, READY_FOR_REVIEW, REPLACED_WITH_NEW_DEVELOPER_REJECTED_VERSION, DEVELOPER_REJECTED, REJECTED (after fixing metadata). Record `versionId` = data[0].id.
2. Reuse an open submission if one exists: `reviewSubmissions_getCollection` with `filter[platform]`=<platform> and `filter[app]`=<app_id>. A submission with attributes.state READY_FOR_REVIEW or UNRESOLVED_ISSUES can take more items; otherwise create a new one in step 3.
3. Create the submission (if needed): `reviewSubmissions_createInstance` with `_body` = { data: { type: 'reviewSubmissions', attributes: { platform: <platform> }, relationships: { app: { data: { type: 'apps', id: '<app_id>' } } } } }. Record `submissionId` = data.id.
4. Attach the version: `reviewSubmissionItems_createInstance` with `_body` = { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } }, appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } } } }.
5. Submit: `reviewSubmissions_updateInstance` with path id=submissionId and `_body` = { data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } } }. Confirm data.attributes.state becomes WAITING_FOR_REVIEW.
6. Report: version string, submission state, and any items with state UNRESOLVED_ISSUES (these block submission until fixed).

## Pitfalls

- Only one review submission per platform can be open at a time; always check step 2 before creating.
- Items can only be added while the submission is READY_FOR_REVIEW or UNRESOLVED_ISSUES.
- The version must have a build attached and all required metadata; if appStoreState is not submittable, fix metadata first (see update-store-listing) or attach a build (see replace-build-on-version).
- Platform attribute must match the version's platform; MAC_OS vs IOS mismatch is rejected.
