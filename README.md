# dreamDEX perps

Perps tooling on Somnia Tokyo (Hideki) testnet, built with `@somnia-chain/markets-sdk`.

## First order

`scripts/first-order.ts` sizes a small order with the pool's own `getMaxPerpOrderSize`, sends an IOC that crosses the book, and prints the transaction hash.

- **Linked bot (`OWNER_ADDRESS` set):** `PRIVATE_KEY` is a bot key linked to your dreamDEX account in the app (wallet → Link a bot → Perps). Orders go through `placeOrderFor`, so margin and fills are the account's. The bot key pays gas and cannot withdraw. This is the way to trade an app wallet that has no exportable key.
- **Own account (`OWNER_ADDRESS` blank):** the key trades its own account and claims the one-time paper USDso voucher first if eligible.

```bash
npm install
cp .env.example .env        # set PRIVATE_KEY (and OWNER_ADDRESS for a linked bot)
npm run first-order         # dry run: reads and sizes, sends nothing
DRY_RUN=false npm run first-order
```

Settings in `.env`: `PERP_SYMBOL` (default `ETH-PERP`), `PERP_SIDE` (`long` or `short`), `PERP_NOTIONAL_USDSO` (position value, default 20).

Paper USDso only trades on allowlisted markets. BTC, ETH, SOL, XRP and HYPE are covered; 1000PEPE, LIT, PUMP, VVV, ZEC and ZRO are not.
