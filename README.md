# Tayron LoL data feed

This public repository publishes validated League of Legends statistics, champion-and-lane item builds, and champion-and-lane rune recommendations for Tayron. It contains the release pipeline and signed feed, not application source, Riot credentials, or user data.

## Release flow

The scheduled GitHub Actions job runs daily and can also be started with **Actions → Build and publish draft statistics → Run workflow**. It refreshes the current game patch, resumes checkpoints only when retrying the same interrupted run, and validates champion/rank/matchup, item-build, and rune coverage before publishing. Item builds and runes use LoLalytics with `tier=all`, `region=all`, and ranked solo queue (`queue=420`), selecting the most-picked sample-qualified recommendation for each champion and lane. The five lane grids cover all champions; item or rune cells without a 100-game sample are marked insufficient and not applied. The CSV exports item-build rows for review; both build and rune recommendations are included in Tayron's signed runtime cache.

Each successful snapshot is immutable in a GitHub Release. A new game patch always publishes. Within the same patch, win-rate updates publish only when at least 30 distinct champions move by 2 percentage points or more; smaller values are held at the last published baseline so daily noise does not notify users. Item-build changes publish when 30 or more champions change, while a newly introduced item triggers an immediate update. Rune-page changes publish when 30 or more champions change; rune catalog changes trigger immediately. These changes are included in the same signed full snapshot or delta, so one restart activates stats, builds, and runes together. The release always contains a full gzip snapshot for recovery. If a verified delta is materially smaller, it is published too. `latest.json` points at those versioned release assets and is Ed25519-signed. Tayron verifies the signature and artifact hash before staging an update.

If a scrape or validation fails, no release is published and the prior `latest.json` remains active. A retry reuses completed, validated page checkpoints and retries only missing or unavailable pages; it does not repeat the full crawl. After a successful run, those checkpoints are cleared so the next daily run refreshes the statistics instead of treating an old same-patch scrape as current.

When LoLalytics returns an explicit HTTP 500 server-error page for a matchup with no published table, that cell is recorded as unavailable without retrying that page. Tayron treats unavailable matchups as missing and falls back to the general lane win rate; it does not fabricate or reuse matchup rates. Other filter mismatches or malformed pages still fail validation.

## Required repository secret

GitHub Actions requires `TAYRON_DATA_SIGNING_KEY`, an Ed25519 private key in PEM format. Its matching public key is embedded in Tayron. Never put the private key in this repository. GitHub Releases and the raw `latest.json` file are public, read-only data distribution endpoints.

## Local commands

- `npm run data:bundle` builds the statistics and item-build snapshot; the scheduled workflow also creates the rune snapshot and joins all data before release.
- `npm run data:verify` refuses incomplete or malformed snapshots.

The central job may take a while because it respects the source site's request pace. End users download a signed delta or full snapshot in the background; they do not wait for the source crawl.
