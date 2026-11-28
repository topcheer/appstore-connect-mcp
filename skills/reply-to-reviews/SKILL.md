---
name: reply-to-reviews
description: "Use when the user wants to list, fetch, read, analyze, or respond to App Store customer reviews / ratings."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Read and reply to customer reviews

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `app_id` (required): App resource id.

## Steps

1. List: `apps_customerReviews_getToManyRelated` with path id=<app_id>, query `sort`=-createdDate, `limit`=50, `filter[territory]` (optional ISO code), `filter[rating]` (optional), `fields[customerReviews]=rating,title,body,createdDate,territory`. Optional include=response to see existing replies.
2. Reply: `customerReviewResponses_createInstance` with `_body` = { data: { type: 'customerReviewResponses', attributes: { responseBody }, relationships: { review: { data: { type: 'customerReviews', id: reviewId } } } } }.
3. Replace a reply: `customerReviewResponses_deleteInstance` then create again (one response per review). Check state via `customerReviews_response_getToOneRelated` - PUBLISHED appears on the store.

## Pitfalls

- Publishing is asynchronous; the response may stay PENDING for a while.
- Apple allows one response per review; to change it, delete and recreate.
