---
name: download-reports
description: "Use when the user wants sales reports, finance reports, revenue, earnings, downloads, or payment reports."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Download sales and finance reports

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Steps

1. Sales: `salesReports_getCollection` with `_accept`="application/a-gzip" (live-verified: Apple rejects the default application/json with 406 NOT_ACCEPTABLE) and query `filter[frequency]`=DAILY | WEEKLY | MONTHLY | YEARLY, `filter[reportSubType]`=SUMMARY | DETAILED, `filter[reportType]`=SALES, `filter[vendorNumber]`=<vendor number from Payments and Financial Reports>, `filter[reportDate]`=YYYY-MM-DD (DAILY) / YYYY-MM (MONTHLY) / YYYY (YEARLY). The response is the gzip report itself, not JSON: the npm server returns {_binary:{encoding:'base64', base64}} (or a temp file path for large files); the Rust build returns metadata only.
2. Finance: `financeReports_getCollection` with `_accept`="application/a-gzip", `filter[regionCode]` (e.g. US, CN, ZZ for rest of world), `filter[reportType]`=FINANCIAL, `filter[vendorNumber]`, and `filter[reportDate]` in the same granularity. Same gzip handling.
3. Decode: base64 -> bytes -> gunzip -> text/tab-separated file (client side). For Xcode performance metrics use `apps_perfPowerMetrics_getToManyRelated` (or builds_...) with `_accept`="*/*" - it returns application/vnd.apple.xcode-metrics+json, which parses as normal JSON.

## Pitfalls

- Report dates use the report's own frequency granularity; DAILY takes a full date, MONTHLY takes YYYY-MM, YEARLY takes YYYY.
- The vendorNumber is not the app id - find it in App Store Connect > Payments and Financial Reports.
- Without `_accept` these endpoints fail with 406; this is an API requirement, not a transient error.
- Report generation is asynchronous on Apple's side: a request for a date that has no report yet returns 404 NOT_FOUND, not an empty file.
