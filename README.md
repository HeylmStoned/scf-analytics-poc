# SCF analytics spike

Proof for the SCF #46 RFP, **Web and API Analytics for Stellar Ecosystem Projects**.

This is not the product. The product is a fork of Umami plus this collector. The spike proves the three parts Umami does not already do:

1. An OpenTelemetry collector that keeps route, status, and a latency histogram, and drops span, trace, and log bodies.
2. A fixed path normalizer for numeric ids, UUIDs, hex hashes, and Stellar `G`, `C`, and `M` strkeys.
3. Tenant isolation. A project token cannot write another project's `tenant.id`, and cannot read another project's rows. An operator token can read all of them.

Web pageviews, bounce rate, visit duration, country, and device stay in Umami. They are not reimplemented here.

## Run

```bash
npm install
npm test
npm run demo
```

`npm run demo` opens `http://127.0.0.1:8787`.

The console is the product preview. **Northwind** and **Harbor** are the two demo projects. Visitors, referrers, bounce rate, visit duration, country, device, and browser are sample numbers, and they change with the range (24h, 7d, 30d, 90d). Each project view shows only that project. **SCF** compares both, with sort, filter, and the same numbers side by side.

Path normalization, API ingest, and the 403 isolation check are live.

On Overview, **Record a page view** stores a Stellar address as `/accounts/:account`. **Send an API call** keeps route, status, and latency, and drops the span and the log. **Check isolation** asks for the other project and gets 403.

Postgres, matching the proposal, is optional:

```bash
docker compose up -d
set DATABASE_URL=postgres://poc:poc@127.0.0.1:54329/analytics
set OPERATOR_TOKEN=operator-dev-token
npm start
```

The schema is created on startup.

## What a request does

`POST /v1/traces` accepts [OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/#otlphttp). Protobuf returns 415 in this spike.

Resource attributes used: `tenant.id`, `service.name`.

Span attributes used: `http.route` (else `http.target` or `url.path`), `http.response.status_code`.

Latency is `endTimeUnixNano - startTimeUnixNano`. It is stored as a count in a fixed bucket (`5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000` ms). `p50Ms` and `p95Ms` in the read API are that bucket's upper bound, not an exact percentile.

`POST /v1/logs` counts and drops the records.

`POST /s/e` with a tenant token records a normalized page path. It is the collect shape from the design, not the Umami script.

`GET /metrics/api` and `GET /metrics/web` return the caller's rows. Operators pass `?all=1`.

## Out of scope

Umami itself, cookie-less dashboards, country lookup, GDPR hosting, pinned script hosting, protobuf OTLP, and the 12-month service. Those are the grant build, described in the technical design.
