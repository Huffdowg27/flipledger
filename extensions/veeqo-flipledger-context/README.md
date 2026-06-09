# Flip Ledger Veeqo Context Extension

Unpacked Chrome extension for the shipping station. It reads Veeqo shipment rows,
uses the visible Amazon order number plus SKU/MSKU, and overlays Flip Ledger ASIN
and bin context under the SKU cell.

## Setup

1. In Flip Ledger Settings, generate and save a Shipping Station Extension key.
2. Run Flip Ledger on a LAN-reachable host, for example `http://192.168.1.25:3000`.
3. In Chrome, open `chrome://extensions`.
4. Enable Developer mode.
5. Click Load unpacked and select this folder:
   `extensions/veeqo-flipledger-context`
6. Open the extension options.
7. Enter the Flip Ledger URL and the same extension key.
8. Click Test Connection.

The extension only injects UI on `https://*.veeqo.com/*` pages. The Flip Ledger
API endpoint is token-gated and lives at:

```text
/api/extension/veeqo-context
```

## Matching

- Order number anchors the lookup.
- SKU/MSKU disambiguates multi-item orders.
- Single-item orders can still match when SKU is missing.
- The displayed bin is the saved Flip Ledger bin. If the saved bin does not
  already include the ASIN, the endpoint appends it for display.
