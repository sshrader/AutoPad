# AutoPay

A pump.fun launchpad that pays creators automatically. Creator fees on pump.fun normally sit in a vault until someone claims them. On AutoPay a small server job, the **keeper**, checks every coin on a schedule and sends the waiting fees to the wallets in the coin's fee split. One site, one launchpad. The split is written on-chain at launch: 90% to the wallet that launched the coin, 10% to the platform (`fees.platformSharePct` in `pads/autopad.json`).

The code started from NoVampPad (which started from BuildAPad). The pad builder is switched off; the copy check (one coin per ticker, name and picture) is still in the code and is off unless `ORIGINALS_CHECK=yes`.

## How auto-claim works

1. **Launch:** the coin is created on pump.fun and its fee split is set (launcher and platform), as before.
2. **The keeper runs** every `AUTOCLAIM_EVERY_MIN` minutes (default 15; first run 1 minute after start). For each coin on the site it reads the creator fees waiting.
3. **Pay out:** when a coin has at least `AUTOCLAIM_MIN_SOL` waiting (default 0.02), the keeper builds pump.fun's payout transaction, signs it with its own small wallet and sends it. pump.fun pays the shareholders of that coin's split.
4. **Record:** each payout is saved (`payouts[.cluster].json` in `DATA_DIR`) and shown on the home page stub and the coin page.

**The keeper never holds anyone's fees.** pump.fun's payout can only move fees to the wallets already in the coin's split, whoever sends it. The keeper wallet only pays network fees (a few thousandths of a cent per payout), so it needs a few cents of SOL, not more.

Limits per run: at most 8 payouts and 100 coins looked at, carrying on from where it stopped next run. It skips coins with no split, holder-rewards coins, paired coins, graduated coins (paid out on pump.fun), and coins someone already paid out. If the keeper wallet drops below 0.005 SOL it stops paying and the home page says "Low on gas".

Public, read-only routes: `GET /api/autoclaim` (status, no secrets) and `GET /api/payouts?limit=&pool=`.

## Set up the keeper wallet (once)

Never paste the key into chat, an issue or a commit. It lives only in a file on your computer and in Railway's variables.

1. In PowerShell: `cd devnet`, `npm install`, then `node 09-new-payer.mjs C:\keys\keeper.json`. It prints the keeper's public address.
2. Send that address about 0.05 SOL.
3. Open `C:\keys\keeper.json`, copy everything (a list of 64 numbers in square brackets) into a Railway variable named `KEEPER_SECRET_KEY`.
4. Press **Deploy**. The log says `Auto-claim on: keeper <address>`, and `/api/autoclaim` shows `"enabled": true`.

## Run it

```
npm install
PLATFORM_FEE_WALLET=<public address> node server.js
npm test
```

| Variable | Purpose |
| --- | --- |
| `PLATFORM_FEE_WALLET` | Public address that receives the platform's share. Required: launching is off without it. |
| `KEEPER_SECRET_KEY` | The keeper wallet file's contents (`[12,34,...]`). Auto-claim is off without it. Secret: Railway only. |
| `AUTOCLAIM_MIN_SOL` | Pay out a coin once this much is waiting. Default 0.02. |
| `AUTOCLAIM_EVERY_MIN` | Minutes between checks. Default 15. |
| `LAUNCH_CLUSTER` | `devnet` (default) or `mainnet-beta`. |
| `MAINNET_ENABLED` | Must be `yes` for `mainnet-beta`. |
| `LAUNCH_RPC_URL` | RPC address. Mainnet needs a dedicated one. The keeper uses it too. |
| `LAUNCH_LOOKUP_TABLE` | **Needed for a block-zero dev buy.** See the checklist below. |
| `DATA_DIR` | Volume mount (for example `/data`) so launches and payouts survive a deploy. |
| `FOUNDER_WALLET`, `FOUNDER_NAME`, `FOUNDER_SYMBOL`, `FOUNDER_DESCRIPTION` | Optional. Only `FOUNDER_WALLET` can launch the founder coin at `/admin/launch`. |
| `PRIORITY_FEE_MICROLAMPORTS` | Priority fee per compute unit. Default 50000 on mainnet. |
| `ORIGINALS_CHECK` | `yes` turns on the one-coin-per-ticker/name/picture rule. |
| `PUBLIC_URL`, `PAD`, `LAUNCHES_FILE`, `HIDE_POOLS`, `ART_DIR`, `VERIFY_SECRET`, picture-studio keys | Optional; as in the code. |

Leave `PLATFORM_SHARE_PCT`, `PAIRS_*` and `HOLDER_REWARDS` unset.

## Before every mainnet launch

- [ ] **`LAUNCH_LOOKUP_TABLE` is set for mainnet and `/api/launch/config` shows `"atomic": true`.** Without it a launch is up to three separate steps, and bots can buy between the coin's creation and the creator's first buy. Make the table once with `devnet/12-make-lookup-table.mjs` (about 0.01 SOL, frozen afterwards). A devnet table does not work on mainnet.
- [ ] `LAUNCH_CLUSTER=mainnet-beta`, `MAINNET_ENABLED=yes`, `LAUNCH_RPC_URL` is the mainnet RPC (not devnet). Press Deploy after changing variables.
- [ ] `/api/launch/config` shows `mainnet-beta` and the right platform wallet.
- [ ] The keeper wallet has a few cents of SOL and `/api/autoclaim` shows `enabled: true` and `lowGas: false`.
- [ ] The launching wallet has enough real SOL for the launch fees plus the dev buy.
- [ ] After the first launch, check the dev buy is the **first** trade on the coin.

## Pages and routes

`/` the launchpad · `/coin/<pool>` a coin · `/rules` how payouts work · `/admin` platform fee page (platform wallet only) · `/admin/launch` founder coin (`FOUNDER_WALLET` only) · `/api/launch/config` · `/api/autoclaim` · `/api/payouts`.

The look is in `public/ap.css` (tokens at the top; light and dark), the payout stub in `public/stub.js`, the brand in `pads/autopad.json` and `pads/autopad/assets/`.
