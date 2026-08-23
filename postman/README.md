# WgCards Sandbox Testing

Two ways to hit the WgCards sandbox described in `WgCards_English_API_Doc_V3_0_8`:

## 1. Postman

Import `WgCards_Sandbox.postman_collection.json` into Postman. It contains:

1. **Get Token** — `POST /api/getToken`, no auth. Its *Tests* script decrypts the
   response and stores the token into the collection variable `token`.
2. **Get Account** — wallet balance, sanity-checks the token works.
3. **Get All Item** — full catalog pull.
4. **Get Stock** — stock check for two SKU ids taken directly from the doc's own
   examples.

Run them in order (1 → 4) from the same collection run so the token from step 1
carries into the rest. All encryption/decryption (AES/ECB/PKCS7, key = the
sandbox `appId` string's raw UTF-8 bytes) happens automatically in each
request's pre-request/test scripts via Postman's built-in `crypto-js`.

Sandbox credentials are pre-filled as collection variables (these are the
public debug credentials published in the doc itself, not anything secret):

```
host:      http://121.43.36.102:9009
appId:     2025112058411324
accountId: 2025112058411325
appKey:    o%Cmiq52TP4o06Uok&R6tC#^#FXGNE*3
```

## 2. Node script

```bash
node scripts/test-wgcards-sandbox.js
```

Runs an offline AES/ECB/PKCS7 self-test against the doc's own worked examples
first (so crypto correctness is verified even with zero network access), then
attempts the same 4 calls as the Postman collection live and prints a
pass/fail summary. Override host/credentials via `WGCARDS_HOST`,
`WGCARDS_APP_ID`, `WGCARDS_ACCOUNT_ID`, `WGCARDS_APP_KEY` env vars.

## Known gotcha

The doc states: *"Only addresses in the ip whitelist can be successfully
accessed"* — the WgCards sandbox itself is IP-restricted. If every call times
out, that's the first thing to check with WgCards' contact
(tech@wgcards.com), independent of whether Postman/the script is configured
correctly.
