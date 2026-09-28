# Deploying the app (live demo URL)

The app is a Next.js project in `app/` inside a pnpm workspace. It reads contract addresses from `@strike/sdk`, so every deployment that updates `contracts/deployments/` (and is pushed) shows up in the app on the next build.

## Vercel (about two minutes)

1. Sign in at https://vercel.com with GitHub and choose **Add New… → Project**.
2. Import `Prashant-thakur77/Strike`.
3. Set **Root Directory** to `app`. Leave "Include files outside the root directory" on (the app builds the SDK from source).
4. Framework preset: Next.js. `app/vercel.json` already sets the install and build commands.
5. Optional environment variables:
   - `NEXT_PUBLIC_DEFAULT_CHAIN_ID`: `46630` (Robinhood Chain testnet, the default) or `421614`
   - `NEXT_PUBLIC_RPC_46630`, `NEXT_PUBLIC_RPC_421614`, `NEXT_PUBLIC_RPC_4663`: private RPC URLs if the public ones rate-limit
6. Deploy. Put the resulting URL in the README "Live app" row and in `docs/submission/hackquest-answers.md`.

The ERC-1155 option metadata URI in the contracts is `https://strike-options.vercel.app/api/option/{id}.json`. If the Vercel project gets a different domain, either add `strike-options.vercel.app` as a domain alias or call `OptionToken.setURI` with the new base.
