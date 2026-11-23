# Changelog

## Unreleased

## 0.1.0 — 2026-11-23

First tagged release of the Pulse OTLP collector POC.

- Accepts OTLP/HTTP JSON at `/v1/traces` with bearer tenant tokens.
- Keeps route, status, and latency histograms; drops span and log bodies.
- Exposes operator `/metrics/api` aggregates for the reviewer console.
- Ships Railway-ready `Dockerfile` and `railway.toml`, plus `/health`.
- Includes path normalization for ids, UUIDs, hashes, and Stellar G/C/M addresses.
