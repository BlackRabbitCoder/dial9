# Span Explorer latency investigation

The latency investigation view lives in **Span Explorer**, below the selected span
type's duration histogram. Click **Analyse source traces**. It works from
the current source, exact span-type ID, time window, and attribute filters.
There are no service-specific fields, operation names, or datasets in the
native feature.

See [TASKS.md](TASKS.md) for the paused improvement backlog and
[WORKFLOW.md](WORKFLOW.md) for task assignment, branches, and integration.

Selecting a span type collapses the catalog to a compact selected-span bar.
**Change span** reopens the list; choosing another type collapses it again.

It supports aggregate S3 scopes and single raw traces. The Rust backend
computes the entire analysis through `GET /api/span-tail` (aggregate scope)
or `POST /api/span-tail` (raw bytes). It reuses credential-scoped resolve,
fold, and Parquet reads, discovers numeric attributes and producer units,
and identifies categorical attributes with up to twelve values. The browser
only requests reports and renders summaries and bounded plot points. It compares
the faster half with the selected slow percentile or histogram band. Choosing a
categorical group recalculates the percentiles inside that group.
Orange dashed plot lines label the percentile cutoff, or both endpoints of a
brushed range. The comparison dropdown displays **Custom selection: X to Y**;
choosing a percentile clears the brush and restores that percentile comparison.

The view starts with:

- Explicit comparison-group definitions, counts, and source-file coverage.
- Categorical latency distributions when a varying categorical field is present.
  Two values overlay in distinct colors; larger categories stack vertically.
  Each value shows its count and p99. Shared logarithmic bins and Y scales make
  the shapes comparable; bin heights are percentages within each value.
  Missing values are counted separately. The category selector changes fields.
- A **Numeric fields** view with three compact scatterplots, ordered by distribution
  differences. All panels share their elapsed-time axis; each field has its
  own value axis. Additional fields and enlarged plots are available on demand.
- Two stacked time-composition bars for typical and selected spans, using the
  existing On CPU, Blocked, Async wait, Scheduling delay, and Unknown categories.
  Rust computes the mean per-instance shares and category durations. Mean elapsed
  time appears beside each bar; hover a segment or legend item for its values.

Categorical bin counts, normalization, and exact per-value percentiles are
computed in Rust across the selected source scope, including any attribute or
group filter. A slow-percentile or histogram-band comparison does not discard
the rest of the distribution. Fields constant within that scope or exceeding
twelve values are omitted. Group counts remain visible because a small sample's
observed p99 is a weak basis for a conclusion.

The field score is rank-biserial separation: `2 × P(slow > typical) − 1`,
with ties split equally. Fields with fewer than twenty values in either
group or under 50% coverage come after better-observed fields. Duration
attributes that merely repeat total elapsed time come last; constant
fields are omitted. This is a descriptive ranking, not a significance test.

Each card shows group means, the comparison score, Spearman, and repetition
across qualifying source files. Definitions appear once in a shared guide;
missing coverage and repeated latency are shown as exceptions. The guide
explains that file repetition needs five observations in each cohort. Spearman
uses up to 2,048 evenly spaced observations across latency ranks; comparison
means and separation use every loaded recorded value. Drawing uses up to
330 points. A dot or slow-example button opens its original trace focused
on the selected span, preserving the viewer's credential contract.

## Run locally

Start a release-mode core viewer using the appropriate access workflow for
your data source. The API retains the viewer's normal per-request credential
contract. Build the canonical upstream UI, then run this loopback-only
development server:

```bash
mise exec node@22 -- npm ci
mise exec node@22 -- npm run build
mkdir -p /tmp/span-tail-demo
mise exec node@22 -- node scripts/serve-span-explorer.mjs \
  /tmp/span-tail-demo http://127.0.0.1:<core-viewer-port>
```

Open the printed origin with the original `/span_explorer.html` path and
query. The helper forwards GET/POST requests and credential headers to the
core. Successful responses are captured under the temporary directory,
keyed by request and credential identity, so previously read selections
can continue to work after the core viewer stops. New scopes still need
the core viewer. Keep trace captures outside the repository.

## Limits and interpretation

The analysis reads at most twenty-four files in the backend's deterministic
resolve order and retains at most one million matching spans. Partial
coverage and field-discovery limits are explicit. Exact span-type IDs
separate callsites with the same name. Occurrence-time filtering uses
`end_ns` in the same half-open interval as the catalog. Each comparison
request reads cached Parquet after any required folds.

Time composition uses the same estimated five-way accounting as the catalog.
Each positive-time instance contributes equally to the bar's shares; category
durations are means across all instances in that cohort. Missing composition
contributes Unknown rather than disappearing from the comparison. A zero-time
instance contributes no share. These estimates describe the recorded time,
not the resource or cause of a wait. Producer timers can overlap and are not
added together. Producer-declared units are
preserved in an additive `attribute_units` Parquet column. Older
parts without that column show unknown units; conflicting units exclude
the field instead of guessing a conversion.

Nearest-rank thresholds include all boundary ties. Bands include both
duration endpoints. A band that includes the faster half produces
overlapping comparison groups. Missing numeric values are excluded from
that field's mean and comparison. None of these associations establishes
causation or predicts the improvement from changing a field.

## Verification

```bash
mise exec node@22 -- npm run test
mise exec node@22 -- npm run check:types
mise exec node@22 -- npx tsc --noEmit
mise exec node@22 -- npm run build
cargo fmt --check
cargo clippy --all-targets --all-features
cargo nextest run
cargo nextest run --stress-duration 20s
cargo build --release -p dial9-viewer --bin dial9-viewer
```

Rust backend tests cover discovery/ranking, latency aliases, constant and missing
values, tied comparisons, group-specific thresholds, per-file agreement,
equal-weighted time composition, missing/zero composition, categorical bin
boundaries, unequal group sizes, zero/extreme durations, scoped category
distributions, and raw/Parquet parity.
Browser verification should cover multiple span types and raw/aggregate
sources, group/percentile/band changes, trace jumps, and desktop/mobile layout.
