# AutoPay on Meteora (test site)

A separate, small site that shows AutoPay working on Meteora's Dynamic Bonding Curve. It does not touch the main AutoPay site.

- **Site** (`server.mjs`, `public/`): read-only. Shows the real flagship coin (live from the chain once its pool is set) first, then clearly labelled simulated demo coins (`demo-coins.json`). It holds no secrets and cannot spend anything.
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
| `KEEPER_KEYPAIR` | scripts only: path to the keeper wallet file kept outside the repo |
| `KEEPER_SECRET_KEY` | only if the site runs the claimer: the keeper wallet file's contents |
| `MAINNET_OK=yes` | required by scripts that spend on mainnet |

Run `npm install` here first. Tests: `npm test`.
