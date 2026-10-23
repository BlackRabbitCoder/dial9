# Span Explorer latency investigation

The latency investigation view lives in **Span Explorer**, below the selected span
type's duration histogram. Click **Analyse source traces**. It works from
the current source, exact span-type ID, time window, and attribute filters.
There are no service-specific fields, operation names, or datasets in the
native feature.

See [TASKS.md](TASKS.md) for the improvement backlog and
[WORKFLOW.md](WORKFLOW.md) for task assignment, branches, and integration.

Selecting a span type collapses the catalog to a compact selected-span bar.
**Change span** reopens the list; choosing another type collapses it again.

It supports aggregate S3 scopes and single raw traces. The Rust backend
computes the entire analysis through `GET /api/span-tail` (aggregate scope)
or `POST /api/span-tail` (raw bytes). It reuses credential-scoped resolve,
fold, and Parquet reads, discovers numeric attributes and producer units,
and identifies categorical attributes with up to twelve values. The browser
only requests reports and renders summaries, density cells, and trace links. It compares
the faster half with the selected slow percentile or histogram band. Choosing a
categorical group recalculates the percentiles inside that group.
Orange dashed plot lines label the percentile cutoff, or both endpoints of a
brushed range. The comparison dropdown displays **Custom selection: X to Y**;
choosing a percentile clears the brush and restores that percentile comparison.

The view starts with:

- Explicit comparison-group definitions, counts, and source-file coverage.
- Categorical latency distributions when a varying categorical field is present.
  Values overlay in distinct colors by default; **Stacked** shows comparable rows.
  Each value shows its count and p99. Shared logarithmic bins and Y scales make
  the shapes comparable; bin heights are percentages within each value.
  Missing values are counted separately. Property buttons change fields.
  Paired bars below the distributions show typical and slow value proportions,
  with the same colors, actual cohort counts, and explicit missing values.
- A **Numeric fields** section directly below the property graphs, with three
  compact plots ordered by group-distribution differences. Density cells count
  every loaded recorded value; outlined dots are trace-linked samples.
  Blue marks other spans and orange marks slow or selected spans, including
  exact color splits where cutoffs cross a cell. Brightness uses the same count
  scale for both hues; split-cell tooltips retain the whole cell's count.
  Elapsed time uses a shared logarithmic axis with a zero-inclusive first bin.
  The backend shares value limits across identical units and normalizes declared
  time units to milliseconds. Unknown units remain separate. Additional fields
  and enlarged plots are available on demand.
- Two stacked time-composition bars for typical and selected spans, using the
  existing On CPU, Blocked, Async wait, Scheduling delay, and Unknown categories.
  Rust computes the mean per-instance shares and category durations. Mean elapsed
  time appears beside each bar; hover a segment or legend item for its values.

Categorical bin counts, normalization, and exact per-value percentiles are
computed in Rust across the selected source scope, including any attribute or
group filter. A slow-percentile or histogram-band comparison does not discard
the rest of the distribution. Fields constant within that scope or exceeding
twelve values are omitted. The backend screens for distribution or p99
differences with sample-size and coverage thresholds. Screening counts and
definitions are available on demand; an excluded field can have no clear
difference in this sample or insufficient observations. Group counts remain
visible because a small sample's observed p99 is a weak basis for a conclusion.

Numeric fields with fewer than twenty values in either group or under 50%
coverage come after better-observed fields. Duration attributes that repeat
total elapsed time and constant fields are omitted. The backend's ordering is
descriptive, not a significance test.

Elapsed aliases require declared time units and use a tolerance of 1 ns or
0.2% of elapsed time, whichever is larger. A timer that matches every recorded
value is omitted even when some values are missing. A near-duplicate with more
than 98% overall matches is omitted only when every recorded value in both the
source/group's fixed p99 tail and the current selection matches. Each checked
cohort must be nonempty and have at least twenty recorded values or complete
recorded coverage. A near-duplicate can reappear when a custom selection exposes
differences or lacks enough recorded coverage; a meaningful rare-tail difference
must remain visible. Unknown units never imply an elapsed alias.

Each card shows group means, qualitative correlation, and repetition across
qualifying source files. Click a correlation or observation badge for its
definition and recorded counts; Escape closes the explanation and returns focus.
File repetition needs five observations in each cohort. Spearman compares up to
2,048 evenly spaced observations across latency ranks; comparison means use
every loaded recorded value. Drawing uses up to 330 trace-link dots in addition
to the full-observation density grid. Hover or focus a dot to see its values and
the trace action before opening it. A dot or slow-example button opens its
original trace focused on the selected span, preserving the credential contract.
Older cached reports show an explicit sample-only warning and do not invent
missing density or shared-unit metadata.

Recomputation blurs and disables previous results. Failure and cancellation
clear stale comparisons; replacing the source retires its previous detail.
The paired comparison replaces the catalog's single time bar once analysis is
available. Flamegraph links and recorded-instance browsing share one trace
inspection section beneath the charts.

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
