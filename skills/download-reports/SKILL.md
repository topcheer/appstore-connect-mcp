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

1. Sales: `salesReports_getCollection` with query `filter[frequency]`=DAILY | WEEKLY | MONTHLY | YEARLY, `filter[reportSubType]`=SUMMARY | DETAILED, `filter[reportType]`=SALES, `filter[vendorNumber]`=<vendor number from Payments and Financial Reports>, `filter[reportDate]`=YYYY-MM-DD (for DAILY) or YYYY-MM (MONTHLY) - call get_tool_details for the exact date formats. Returns data.attributes.url (a download link).
2. Finance: `financeReports_getCollection` with `filter[regionCode]` (e.g. US, CN, or ZZ for rest of world), `filter[reportType]`=FINANCIAL, `filter[vendorNumber]`, and the date filter per get_tool_details. Also returns a url.
3. Download the URL with a client-side HTTP request (this MCP returns the link; the file is not JSON).

## Pitfalls

- Report dates use the report's own frequency granularity; DAILY takes a full date, MONTHLY takes YYYY-MM, YEARLY takes YYYY.
- The vendorNumber is not the app id - find it in App Store Connect > Payments and Financial Reports.
