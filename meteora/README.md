# AutoPayment on Meteora (test site)

A separate, small site that shows AutoPayment working on Meteora's Dynamic Bonding Curve. It does not touch the main AutoPay site.

- **Site** (`server.mjs`, `public/`): read-only. Shows the real flagship coin (live from the chain once its pool is set) first, then clearly labelled simulated demo coins (`demo-coins.json`). It holds no secrets and cannot spend anything.
- **Pages:** coins, coin page (with a buy and sell box), launch form, How it works, Rules.
- **Launch form:** off unless `LAUNCH=yes`. The visitor pays and signs as buyer; the keeper signs only as the on-chain pool creator, so it can claim creator fees for them. The site then holds the keeper key.
- **Config** (`scripts/01-config.mjs`): makes the curve config. Permanent, so it shows the numbers and needs `--yes`.
- **Launch** (`scripts/02-launch-flagship.mjs`): one transaction creates the pool and makes the first buy. Only the keeper wallet signs. Creator fees and the first-buy tokens go to `FLAGSHIP_CREATOR`.
- **Claimer** (`scripts/04-claim.mjs`): dry run by default. `--send` claims the creator share to the creator wallet and the platform share to `PLATFORM_WALLET`. The site can also run it on a timer (`AUTOCLAIM=dry|yes`), off by default.

## Settings

| Name | What |
| --- | --- |
| `CLUSTER` | `devnet` or `mainnet-beta` |
| `RPC_URL` | RPC address (mainnet needs your own; keep it private) |
| `SITE_URL` | the site's public https address (used for the coin's metadata) |
| `PLATFORM_WALLET` | public address that receives the platform share |
| `DBC_CONFIG` | config address (after `01-config.mjs`) |
| `FLAGSHIP_CREATOR` | public address of the flagship coin's creator wallet |
| `FLAGSHIP_MINT`, `FLAGSHIP_POOL` | printed by `02-launch-flagship.mjs` |
| `LAUNCH` | `yes` turns on the launch form (needs `DBC_CONFIG`, `KEEPER_SECRET_KEY`, `RPC_URL`, https `SITE_URL`) |
| `TRADE` | `no` hides the buy and sell box (on by default when `RPC_URL` is set) |
| `DATA_DIR` | where launched coins and their pictures are kept. On Railway, attach a volume and point this at it |
| `LAUNCH_MAX_BUY` | most SOL a first buy may be (default 2) |
| `HIDE_COINS` (or `HIDE_POOLS`) | comma-separated coin ids, mint addresses or pool addresses to stop showing. Hidden coins are also skipped by the fee claimer, so claim their fees first |
| `AUTOCLAIM`, `AUTOCLAIM_EVERY_MIN`, `AUTOCLAIM_MIN_SOL` | `dry` or `yes` runs the fee claimer inside the site (needs `KEEPER_SECRET_KEY`) |
| `KEEPER_KEYPAIR` | scripts only: path to the keeper wallet file kept outside the repo |
| `KEEPER_SECRET_KEY` | only if the site runs the claimer: the keeper wallet file's contents |
| `MAINNET_OK=yes` | required by scripts that spend on mainnet |

Run `npm install` here first. Tests: `npm test`.
