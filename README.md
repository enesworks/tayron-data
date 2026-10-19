# Tayron LoL data feed

This public repository publishes validated League of Legends statistics for Tayron. It contains the release pipeline and signed feed, not application source, Riot credentials, or user data.

## Release flow

The scheduled GitHub Actions job runs daily and can also be started with **Actions → Build and publish draft statistics → Run workflow**. It downloads the previous full snapshot, refreshes source pages for the current game patch, resumes checkpoints only when retrying the same interrupted run, and validates all champion, rank, role, lane, and matchup coverage before publishing.

Each successful snapshot is immutable in a GitHub Release. A new game patch always publishes regardless of the rate threshold. Within the same patch, win-rate changes are compared with the last published snapshot: changes below 1.0 percentage point are retained at the published value, and a new release is held until a meaningful data change occurs. Small daily movements therefore accumulate against the published baseline. The release always contains a full gzip snapshot for recovery. If a verified delta is materially smaller, it is published too. `latest.json` points at those versioned release assets and is Ed25519-signed. Tayron verifies the signature and artifact hash before staging an update.

If a scrape or validation fails, no release is published and the prior `latest.json` remains active. A retry reuses completed, validated page checkpoints and retries only missing or unavailable pages; it does not repeat the full crawl. After a successful run, those checkpoints are cleared so the next daily run refreshes the statistics instead of treating an old same-patch scrape as current.

For patch 16.20 only, the Master-tier Lillia-vs-Bot matchup cell is explicitly omitted because its source page returned a server-error document. Tayron treats that one cell as unavailable and falls back to the general lane win rate; it does not fabricate or reuse a matchup rate for it.

## Required repository secret

GitHub Actions requires `TAYRON_DATA_SIGNING_KEY`, an Ed25519 private key in PEM format. Its matching public key is embedded in Tayron. Never put the private key in this repository. GitHub Releases and the raw `latest.json` file are public, read-only data distribution endpoints.

## Local commands

- `npm run data:bundle` builds the complete snapshot (about 6,747 matchup pages at the current champion and rank counts).
- `npm run data:verify` refuses incomplete or malformed snapshots.

The central job may take a while because it respects the source site's request pace. End users download a signed delta or full snapshot in the background; they do not wait for the source crawl.
