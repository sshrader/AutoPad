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

## Fee options at launch

The launch form lets the creator choose how creator fees work. The choice is checked on the server, kept with the coin, and fixed on-chain when the coin is created.

| Option | What happens |
| --- | --- |
| **Creator rewards** (default) | The creator keeps 90% and AutoPay 10%, paid out automatically by the keeper. |
| **Share with a wallet** | The creator names a partner wallet and a whole-number share, 1 to 40% (50 minus the platform share). The platform still takes 10%. The creator keeps the rest. |
| **Holder rewards** | pump.fun pays all creator fees to the coin's holders. A flat launch fee (`HOLDER_LAUNCH_FEE_SOL`, default 0.05 SOL) goes to the platform wallet, there is no split, and no first buy at launch. Greyed out as "Coming soon" unless `HOLDER_REWARDS=yes`. Only tried on devnet so far: test it before turning it on. |

The keeper skips holder-rewards coins, since there is nothing to pay out for them.

## Boost: the Promoted row

At launch a creator can pay a flat fee to put the coin in a labeled **Promoted** row above the newest coins. The fee goes to the platform wallet inside the launch transaction.

- **Price curve:** `price = 0.1 SOL x (minutes / 10) ^ 0.6`, so longer boosts cost more in total and less per hour. Buttons: 10 min 0.10, 30 min 0.20, 1 h 0.30, 3 h 0.57, 12 h 1.31, 24 h 1.98 SOL. A custom amount from 0.10 to 1.98 SOL runs the same curve in reverse (0.5 SOL is about 2 h 26 min). `BOOST_PRICE_MULT` scales every price (0.5 is half price).
- **Ranking:** by SOL paid per hour, so short boosts sit above long ones while they last; an earlier start wins a tie. There are 4 slots. A boost below the top 4 keeps running out its time, and the form warns when all slots are taken.
- **Payment is verified on-chain.** After the launch transaction confirms, the page sends its signature to `POST /api/launch/boost`. The server reads that transaction and only starts the boost if the creator paid, the new coin is in it, and the platform wallet's balance rose by the fee. One signature can start one boost. Fees are not refunded.
- Routes: `GET /api/promoted`, `GET /api/boost/config`, `POST /api/launch/boost`.

## Auto airdrop (optional, off until you switch it on)

A creator who makes a first buy at launch can set aside part of it for holders: a share (1 to 50%), a holder count (2 to 1000) and a wait (1 to 10080 minutes, up to 7 days). When **both** are true, the keeper splits those tokens between the coin's holders, in proportion to what each holds.

- **Non-custodial, but not a lock.** The launch transaction ends with a Token-2022 *approve*: the creator's wallet lets the keeper wallet move up to that many tokens out of the creator's own token account. The tokens stay with the creator until the keeper sends them. If the creator sells them or cancels the permission, nothing is sent, and the coin page says so. The page tells creators this before launch.
- **Who counts as a holder:** a wallet with at least 100,000 of the coin. The creator, the bonding curve, the keeper and the platform wallet are skipped. The count is a signal, not proof of real people: a creator could hold the coin in many wallets.
- **What is sent:** the smaller of the approved amount and what the creator still holds, in batches of 10 transfers. Progress is saved, so a failed batch resumes without paying anyone twice (before resending, the keeper checks whether the batch already landed). Each send costs the keeper a normal network fee, no account rent (holders already have token accounts).
- **Needs:** `KEEPER_SECRET_KEY` and `AIRDROP=yes`. The form hides the option otherwise. Not available for holder-rewards coins or pair launchpads.
- **RPC:** counting holders needs an RPC that allows listing a token's accounts (Helius does; the public devnet RPC does not). Otherwise the keeper falls back to the 20 biggest holders, which is only enough while the coin has fewer than 20 token accounts. Past that it waits and the coin page says to set `LAUNCH_RPC_URL`.
- Wallets will show an extra "approve token delegate" prompt in the launch transaction. That is expected.
- Route: `GET /api/airdrop?pool=` (settings, status, and whether the approval is still in place).

**Test on devnet before turning it on for real:**

1. Set `AIRDROP=yes` with the keeper wallet funded (devnet), and launch with a first buy and an airdrop of 10%, 2 holders, 10 minutes.
2. Check the wallet prompt shows the approve, and the coin page shows "Airdrop scheduled".
3. Buy the coin from 2 other devnet wallets (each at least 100,000 tokens' worth).
4. After an hour and the next keeper run (up to 15 minutes), check the 2 wallets received tokens, the creator's balance dropped, and the coin page says "Airdrop sent".
5. Launch a second one, then sell the tokens or revoke the approval before it is due, and check it says cancelled and sends nothing.

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
| `BOOST_PRICE_MULT` | Scales every boost price. Default 1. Start lower (for example 0.5) until the site has visitors. |
| `AIRDROP` | `yes` switches on the Auto airdrop option on the launch form (needs `KEEPER_SECRET_KEY`). Test on devnet first. |
| `HOLDER_REWARDS` | `yes` switches on the Holder rewards option on the launch form. Leave unset until it has been tested. |
| `HOLDER_LAUNCH_FEE_SOL` | Flat launch fee for holder-rewards coins. Default 0.05. |
| `LAUNCH_CLUSTER` | `devnet` (default) or `mainnet-beta`. |
| `MAINNET_ENABLED` | Must be `yes` for `mainnet-beta`. |
| `LAUNCH_RPC_URL` | RPC address. Mainnet needs a dedicated one. The keeper uses it too. |
| `LAUNCH_LOOKUP_TABLE` | **Needed for a block-zero dev buy.** See the checklist below. |
| `DATA_DIR` | Volume mount (for example `/data`) so launches and payouts survive a deploy. |
| `FLAGSHIP_WALLET` (same as `FOUNDER_WALLET`), `FOUNDER_NAME`, `FOUNDER_SYMBOL`, `FOUNDER_DESCRIPTION` | Optional. Only `FOUNDER_WALLET` can launch the founder coin at `/admin/launch`. |
| `PRIORITY_FEE_MICROLAMPORTS` | Priority fee per compute unit. Default 50000 on mainnet. |
| `ORIGINALS_CHECK` | `yes` turns on the one-coin-per-ticker/name/picture rule. |
| `PUBLIC_URL`, `PAD`, `LAUNCHES_FILE`, `HIDE_POOLS`, `ART_DIR`, `VERIFY_SECRET`, picture-studio keys | Optional; as in the code. |

Leave `PLATFORM_SHARE_PCT` and `PAIRS_*` unset.

## Before every mainnet launch

- [ ] **`LAUNCH_LOOKUP_TABLE` is set for mainnet and `/api/launch/config` shows `"atomic": true`.** Without it a launch is up to three separate steps, and bots can buy between the coin's creation and the creator's first buy. Make the table once with `devnet/12-make-lookup-table.mjs` (about 0.01 SOL, frozen afterwards). A devnet table does not work on mainnet.
- [ ] `LAUNCH_CLUSTER=mainnet-beta`, `MAINNET_ENABLED=yes`, `LAUNCH_RPC_URL` is the mainnet RPC (not devnet). Press Deploy after changing variables.
- [ ] `/api/launch/config` shows `mainnet-beta` and the right platform wallet.
- [ ] The keeper wallet has a few cents of SOL and `/api/autoclaim` shows `enabled: true` and `lowGas: false`.
- [ ] The launching wallet has enough real SOL for the launch fees plus the dev buy.
- [ ] After the first launch, check the dev buy is the **first** trade on the coin.
- [ ] Launch one coin with a 10-minute boost and check it appears in the Promoted row and the platform wallet received the fee.
- [ ] Launch one coin with **Share with a wallet** and check the split on the coin page shows the partner.

## Pages and routes

`/` the launchpad · `/coin/<pool>` a coin · `/rules` how payouts work · `/admin` platform fee page (platform wallet only) · `/admin/launch` founder coin (`FOUNDER_WALLET` only) · `/api/launch/config` · `/api/autoclaim` · `/api/payouts` · `/api/promoted` · `/api/boost/config` · `/api/airdrop`.

The look is in `public/ap.css` (tokens at the top; light and dark), the payout stub in `public/stub.js`, the brand in `pads/autopad.json` and `pads/autopad/assets/`.


## Free test launch (devnet)

The newest code is shown to every visitor on the main page ("Free test launch" box) until someone uses it; then it reads as used until you make another. Needs `KEEPER_SECRET_KEY` and devnet (turn off with `FREE_LAUNCH=no`). On the admin page, connect the platform wallet and press "Make a code" (it signs a free message). Give the code to one tester: they fill in the coin on the launch page, enter the code under "Free test launch" and press "Launch for free", with no wallet. The keeper wallet pays and is the coin's creator, so there is no first buy, boost or airdrop. A code works once and lasts 7 days; at most 10 unused codes at a time. Codes are saved in `freecodes.json` in the data folder. Each visitor (same browser cookie or same network address) can make one free launch; set `FREE_PER_VISITOR=0` (no limit) or another number on Railway when you want to test several yourself.
