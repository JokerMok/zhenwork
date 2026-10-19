# Foundation integration spike

R1 only. This proves selected libraries against PostgreSQL and the unchanged Alpha BFF/Harness. It is not a production server and must never be exposed through a tunnel.

Use Node 24. Install with `npm ci --ignore-scripts`, run `node scripts/init.mjs`, then from the product root run `python3 spikes/foundation/scripts/start-alpha-spike.py` and launch `.research/spike-alpha/src/bff.mjs`. Start this directory with `NEXT_TELEMETRY_DISABLED=1 node server.mjs`. Only `127.0.0.1:3417` is bound. Synthetic credentials are generated in the product `.state/foundation/test-users.json`, excluded from Git. Never use real employee data here.

The PostgreSQL container/volume are `wb-v1-spike-postgres` / `wb-v1-spike-pg`; the gateway is `wb-v1-spike-gateway`. Existing Alpha runtimes are reused without modifying source or historical evidence. New gateway logs go to `evidence/v1/reuse-r1/gateway`. Stop these named Spike services after verification; do not remove unrelated containers or historical state.

Checks: `node scripts/test-auth.mjs`, `node --test scripts/test-projector.mjs`, `node scripts/browser-smoke.mjs`, `node scripts/browser-chat-e2e.mjs`, `npm run typecheck`, `npm run build`, `npm audit`, and root `python3 spikes/foundation/scripts/verify-artifacts.py`. Auth tests deliberately respect the upstream login rate limit and may wait for its retry window.

The browser tests use local isolated browser contexts and synthetic accounts, not the P9 independent-device acceptance. See `docs/v1/reuse/spike-report.md` for failures, fixes, evidence and remaining production work. Port provenance and licenses are in the product `third-party-lock.json` / `THIRD_PARTY_NOTICES.md`.
