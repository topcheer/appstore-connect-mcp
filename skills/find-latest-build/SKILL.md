---
name: find-latest-build
description: "Use when the user asks for the newest/latest build, build list, build status, processing state, or which builds exist for a version."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Find the latest processed build for an app

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `app_id` (required): App resource id.
- `version` (optional): Optional CFBundleShortVersionString (marketing version) filter, e.g. 2.1.0.

## Steps

1. `builds_getCollection` with query `filter[app]`=<app_id>, `sort`=-uploadedDate, `limit`=20, `fields[builds]=version,uploadedDate,processingState,expired,buildNumber,cfBundleVersion`, and include=preReleaseVersion. Add `filter[preReleaseVersion.version]`=<version> if given, and `filter[processingState]`=VALID to hide failed builds.
2. Read data[0] as the newest. Report uploadedDate, processingState (VALID | PROCESSING | FAILED | INVALID), expired flag, and the id for chaining.
3. For TestFlight state add `builds_betaAppReviewSubmission_getToOneRelated` (path id=buildId) to see betaReviewState.

## Pitfalls

- processingState=VALID means ready; PROCESSING builds cannot be attached or distributed yet.
- expired=true builds cannot be submitted; the version then needs a replacement build (see replace-build-on-version).
