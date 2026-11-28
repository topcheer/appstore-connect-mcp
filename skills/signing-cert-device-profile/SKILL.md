---
name: signing-cert-device-profile
description: "Use when the user wants to create a certificate, register a test device (UDID), or create a provisioning profile for development/ad-hoc/App Store distribution."
license: "MIT"
compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."
metadata:
  source: "appstore-connect-mcp"
---
# Create signing certificate, register device, and provisioning profile

Every operation below is called through the MCP tool `call_api` with `name` = the operation name. Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.

## Inputs

- `profile_type` (optional): IOS_APP development | IOS_APP_STORE | IOS_AD_HOC | MAC_APP_STORE | TVOS_APP ... (full list in get_tool_details profiles_createInstance).

## Steps

1. Certificate: generate a CSR locally (openssl req -new -keyform PEM -keyout key.pem -out csr.pem -subj '/CN=Name/O=Org'), then `certificates_createInstance` with `_body` = { data: { type: 'certificates', attributes: { certificateType: 'IOS_DEVELOPMENT' | 'IOS_DISTRIBUTION' | 'DEVELOPMENT' | 'DISTRIBUTION' | 'MAC_APP_DISTRIBUTION' ..., csrContent }, relationships: {} } }. The response contains certificateContent once - download and store it.
2. Device: `devices_createInstance` with attributes { name, platform: IOS | MAC_OS | TV_OS ..., udid }. List with `devices_getCollection`.
3. Profile: `profiles_createInstance` with `_body` = { data: { type: 'profiles', attributes: { name, profileType }, relationships: { bundleId: { data: { type: 'bundleIds', id } }, certificates: { data: [{ type: 'certificates', id }] }, devices: { data: [{ type: 'devices', id }] } } } }. devices is omitted for App Store profiles. Response includes profileContent (base64 .mobileprovision).
4. Inspect/download existing: `profiles_getCollection` (filter[name], filter[profileType]) and `profiles_getInstance`.

## Pitfalls

- certificateContent and profileContent are returned only in the create/get responses; save them immediately.
- Apple limits certificates per type; delete expired ones with certificates_deleteInstance first.
- Bundle ids are registered with `bundleIds_createInstance` (attributes name, platform, identifier) if missing.
