# 0008. Object storage driver

## Status

Accepted, 2026-05-27.

## Context

Uploaded receipt bytes are kept out of Postgres behind an `ObjectStorage` interface (`put(buffer, mime) -> key`, `get(key) -> buffer`) so the rows stay small. The only implementation so far is `FilesystemStorage`, which writes uuid-named files under a directory from `UPLOAD_DIR`.

The filesystem driver is fine for local development and wrong for any real deploy:

- The directory is not shared across replicas, so a receipt uploaded to one instance is invisible to another.
- Platforms with ephemeral filesystems (Railway, Fly.io, most container hosts) lose the files on every restart or redeploy.
- A single node's disk fills up long before object storage would.

So a deploy needs a real object store. The storage interface was designed for exactly this swap; what is left is choosing how the second driver is built and configured. The target self-hoster is a freelancer or small team, not an AWS shop, so the choice cannot assume AWS specifically.

## Decision

**One S3-compatible driver via `@aws-sdk/client-s3`, pointed at a configurable endpoint.** Cloudflare R2, Backblaze B2, MinIO, and AWS S3 all speak the S3 API. The AWS SDK talks to any of them when given an `endpoint` (and path-style addressing for the ones that need it), so a single `S3Storage` class covers every provider a self-hoster is likely to pick. No per-provider SDKs.

**`STORAGE_DRIVER` selects the driver,** `filesystem` (default) or `s3`, mirroring how `EXTRACTION_PROVIDER` already works. Filesystem stays the zero-config local default; `s3` is opt-in for deploys. The env schema refines `s3` to require bucket, region, and credentials, so a half-configured deploy fails at boot rather than on the first upload.

**Credentials are explicit `S3_*` env vars,** not the ambient `AWS_*` chain. A self-hoster on R2 should not have to learn the AWS credential resolution order, and explicit vars avoid silently picking up unrelated AWS credentials from the host.

**Bytes are proxied through the api** (the existing `GET /uploads/:id/bytes` reads `storage.get` and streams the response), not served via presigned URLs. Proxying keeps authorization in one place (the api already guards the route) and keeps the bucket layout private. Presigned URLs are a later optimization for large files or high traffic, not a v1 need.

**Keys stay opaque uuids** the storage layer mints, persisted in `uploads.storage_key`. The bucket is flat for now; a prefix scheme (by user or date) can come later without changing the interface.

## Options considered

**Per-provider SDKs (R2 binding, B2 native API).** Rejected: every provider that matters already exposes the S3 API, so a provider-specific client buys nothing but more dependencies and more code to maintain. The S3 API is the portable contract.

**A dedicated MinIO client.** Smaller than the AWS SDK, but only really targets MinIO; using it against R2/B2/S3 is off-label. The AWS SDK is the one that all four providers test against. The bundle size cost lands on the api server, not the browser, so it does not matter here.

**Presigned URLs from day one.** Lets the browser pull bytes straight from the bucket and skips the api hop. Rejected for v1: it leaks bucket structure, needs URL signing and expiry handling, and splits authorization between the api and the bucket policy. The receipts are small images; the api hop is cheap. Revisit if bandwidth through the api becomes a cost.

**Infer the driver from whether S3 vars are present.** Rejected as too implicit: a deploy missing one S3 var would silently fall back to the filesystem and lose uploads quietly. An explicit `STORAGE_DRIVER` plus a refine that demands the rest makes a misconfiguration loud.

## Consequences

A deploy sets `STORAGE_DRIVER=s3` and the five `S3_*` vars, points them at R2 or B2 or a MinIO box, and uploads survive restarts and span replicas. Local development needs nothing: the filesystem default still works.

The interface is unchanged, so `UploadsService` and the controller do not know which driver is active. Tests can run the real S3 path against a MinIO container without touching application code.

Two things we accept as known limits:

- **No presigned URLs.** Every byte of every receipt download flows through the api process. Fine at the v1 scale; the optimization is a known follow-up if download traffic grows.
- **Flat key space, no lifecycle.** Keys are uuids with no prefix and nothing deletes them; an orphaned object after a failed upload lingers. A cleanup job and a prefix scheme are deferred until there is data worth pruning.
