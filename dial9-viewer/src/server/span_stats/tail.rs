//! Server-side, selected-type tail comparison. Reuses credential-scoped folds;
//! sends summaries and bounded examples, never the full observation dataset.
use std::collections::{BTreeMap, BTreeSet};

use axum::{Json, body::Bytes, extract::State, http::StatusCode};
use axum_extra::extract::Query;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use super::{
    AttrFilter, Exemplar, RowComposition, SpanStatsInput, SpanStatsParams, SpanStatsRow,
    SpansBatchReader, parse_attr_filters, parse_span_type_uid, raw_trace_bytes,
};
use crate::ingest::{aggregate, decode, refine};
use crate::server::{AppState, credentials::MaybeCreds};

const MAX_FILES: usize = 24;
const MAX_RECORDS: usize = 1_000_000;
const MAX_FIELDS: usize = 32;
const MAX_GROUP_VALUES: usize = 12;
const HISTOGRAM_LOG_BINS: usize = 36;
// Keep permits in blocking workers as well: dropping a timed-out HTTP future
// must not release capacity while its CPU work is still running.
static ANALYSIS_LIMIT: Semaphore = Semaphore::const_new(2);

#[derive(Deserialize)]
pub(crate) struct TailOptions {
    slow_percentile: Option<f64>,
    group_key: Option<String>,
    group_value: Option<String>,
}

struct TailParams {
    scope: SpanStatsParams,
    options: TailOptions,
}

struct Selection {
    uid: [u8; 16],
    filters: Vec<AttrFilter>,
    percentile: f64,
    group: Option<(String, String)>,
    min_ms: Option<f64>,
    max_ms: Option<f64>,
}

impl TailParams {
    fn selection(&self) -> Result<Selection, String> {
        let uid = parse_span_type_uid(self.scope.span_type_uid.as_deref())?
            .ok_or("span_type_uid is required")?;
        let percentile = self.options.slow_percentile.unwrap_or(99.0);
        if !percentile.is_finite() || !(50.0..=99.99).contains(&percentile) {
            return Err("slow_percentile must be between 50 and 99.99".into());
        }
        if self
            .scope
            .start_ns
            .zip(self.scope.end_ns)
            .is_some_and(|(a, b)| a > b)
        {
            return Err("inverted occurrence time range".into());
        }
        if self.scope.min_span_ns.is_some_and(|n| n < 0)
            || self.scope.max_span_ns.is_some_and(|n| n < 0)
            || self
                .scope
                .min_span_ns
                .zip(self.scope.max_span_ns)
                .is_some_and(|(a, b)| a > b)
        {
            return Err("invalid span duration bounds".into());
        }
        let group = match (&self.options.group_key, &self.options.group_value) {
            (None, None) => None,
            (Some(key), Some(value)) if !key.is_empty() => Some((key.clone(), value.clone())),
            _ => return Err("group_key and group_value must be supplied together".into()),
        };
        Ok(Selection {
            uid,
            filters: parse_attr_filters(&self.scope.attr)?,
            percentile,
            group,
            min_ms: self.scope.min_span_ns.map(|n| n as f64 / 1e6),
            max_ms: self.scope.max_span_ns.map(|n| n as f64 / 1e6),
        })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Example {
    elapsed_ms: f64,
    inside_ms: Option<f64>,
    start_ns: String,
    end_ns: String,
    source_url: String,
    request_id: Option<String>,
}

struct Observation {
    example: Example,
    composition: Option<RowComposition>,
    detailed: bool,
    source: usize,
    numeric: BTreeMap<String, f64>,
    groups: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Signal {
    key: String,
    unit: Option<String>,
    typical: Option<f64>,
    slow: Option<f64>,
    typical_count: usize,
    slow_count: usize,
    typical_coverage: f64,
    slow_coverage: f64,
    separation: Option<f64>,
    correlation: Option<f64>,
    correlation_count: usize,
    duplicates_latency: bool,
    files_compared: usize,
    files_agree: usize,
    points: Vec<(f64, f64, Example)>,
}

#[derive(Serialize)]
struct Group {
    key: String,
    values: Vec<String>,
    typical: BTreeMap<String, f64>,
    slow: BTreeMap<String, f64>,
}

#[derive(Serialize)]
struct MixChange {
    key: String,
    value: String,
    typical: f64,
    slow: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CategoryLatency {
    value: String,
    count: usize,
    shares: Vec<f64>,
    median_ms: f64,
    p99_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CategoricalHistogram {
    key: String,
    count: usize,
    missing_count: usize,
    bin_edges_ms: Vec<f64>,
    max_share: f64,
    values: Vec<CategoryLatency>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompositionCategory {
    key: &'static str,
    share: f64,
    mean_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CohortComposition {
    count: usize,
    detailed_count: usize,
    detailed_coverage: f64,
    categories: Vec<CompositionCategory>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    count: usize,
    typical_count: usize,
    slow_count: usize,
    boundary_ms: f64,
    median_ms: f64,
    typical_elapsed_ms: Option<f64>,
    slow_elapsed_ms: Option<f64>,
    typical_inside_ms: Option<f64>,
    slow_inside_ms: Option<f64>,
    typical_outside_ms: Option<f64>,
    slow_outside_ms: Option<f64>,
    typical_attributed: usize,
    slow_attributed: usize,
    typical_composition: Option<CohortComposition>,
    slow_composition: Option<CohortComposition>,
    signals: Vec<Signal>,
    groups: Vec<Group>,
    histograms: Vec<CategoricalHistogram>,
    mix_changes: Vec<MixChange>,
    examples: Vec<Example>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TailResponse {
    report: Report,
    files_used: usize,
    files_matched: usize,
    truncated: bool,
    fields_truncated: bool,
}

#[derive(Default)]
struct Collector {
    rows: Vec<Observation>,
    // Err marks incompatible producer units; these fields are excluded.
    fields: BTreeMap<String, Result<Option<String>, ()>>,
    groups: BTreeMap<String, Option<BTreeSet<String>>>,
    truncated: bool,
    fields_truncated: bool,
}

fn numeric(value: &str) -> Option<f64> {
    if value.is_empty() || value.trim() != value {
        return None;
    }
    let n: f64 = value.parse().ok()?;
    (n.is_finite() && (n.fract() != 0.0 || n.abs() <= 9_007_199_254_740_991.0)).then_some(n)
}

impl Collector {
    fn push(&mut self, row: SpanStatsRow, selection: &Selection, source: usize, url: &str) {
        if row.span_type_uid != selection.uid
            || row.elapsed_ns < 0
            || !selection.filters.iter().all(|f| {
                row.attributes
                    .iter()
                    .any(|(k, v)| k == &f.key && v == &f.value)
            })
        {
            return;
        }
        if self.rows.len() == MAX_RECORDS {
            self.truncated = true;
            return;
        }
        let elapsed_ms = row.elapsed_ns as f64 / 1e6;
        let inside_ms = row
            .observed_active_wall_ns
            .filter(|n| row.details_complete == Some(true) && *n >= 0 && *n <= row.elapsed_ns)
            .map(|n| n as f64 / 1e6);
        let mut numbers = BTreeMap::new();
        let mut groups = BTreeMap::new();
        let mut units = BTreeMap::new();
        let mut conflicting_units = BTreeSet::new();
        for (key, unit) in row.attribute_units {
            if units
                .insert(key.clone(), unit.clone())
                .is_some_and(|old| old != unit)
            {
                conflicting_units.insert(key);
            }
        }
        let request_id = row
            .attributes
            .iter()
            .find(|(k, v)| k == "RequestId" && v.len() <= 512)
            .map(|(_, v)| v.clone());
        for (key, value) in row.attributes {
            if key.len() > 256 || value.len() > 512 || key.starts_with("dial9.") {
                continue;
            }
            if let Some(n) = numeric(&value) {
                if !self.fields.contains_key(&key) && self.fields.len() >= MAX_FIELDS {
                    self.fields_truncated = true;
                    continue;
                }
                let unit = units.get(&key).cloned();
                let known = self
                    .fields
                    .entry(key.clone())
                    .or_insert_with(|| Ok(unit.clone()));
                if conflicting_units.contains(&key) || known.as_ref().is_ok_and(|old| old != &unit)
                {
                    *known = Err(());
                }
                numbers.insert(key, n);
            } else {
                if !self.groups.contains_key(&key) && self.groups.len() >= MAX_FIELDS {
                    self.fields_truncated = true;
                    continue;
                }
                let values = self
                    .groups
                    .entry(key.clone())
                    .or_insert_with(|| Some(BTreeSet::new()));
                if let Some(values) = values {
                    values.insert(value.clone());
                    if values.len() > MAX_GROUP_VALUES {
                        self.groups.insert(key, None);
                    } else {
                        groups.insert(key, value);
                    }
                }
            }
        }
        let exemplar = row
            .exemplar
            .filter(|e| !e.source_key.is_empty() && e.end_ns >= e.start_ns);
        let (start_ns, end_ns, source_url) = match exemplar {
            Some(e) => (
                e.start_ns.to_string(),
                e.end_ns.to_string(),
                url.to_string(),
            ),
            None => (String::new(), String::new(), String::new()),
        };
        self.rows.push(Observation {
            example: Example {
                elapsed_ms,
                inside_ms,
                start_ns,
                end_ns,
                source_url,
                request_id,
            },
            source,
            composition: row.composition,
            detailed: row.details_complete == Some(true),
            numeric: numbers,
            groups,
        });
    }

    fn report(&self, selection: &Selection) -> Result<Report, String> {
        let mut rows: Vec<_> = self
            .rows
            .iter()
            .filter(|r| {
                selection
                    .group
                    .as_ref()
                    .is_none_or(|(k, v)| r.groups.get(k) == Some(v))
            })
            .collect();
        rows.sort_by(|a, b| a.example.elapsed_ms.total_cmp(&b.example.elapsed_ms));
        if rows.is_empty() {
            return Err("No matching spans in this comparison.".into());
        }
        let quantile = |p: f64| {
            rows[((rows.len() as f64 * p).ceil() as usize).saturating_sub(1)]
                .example
                .elapsed_ms
        };
        let median_ms = quantile(0.5);
        let boundary_ms = selection.min_ms.unwrap_or_else(|| {
            if selection.max_ms.is_some() {
                0.0
            } else {
                quantile(selection.percentile / 100.0)
            }
        });
        let typical: Vec<_> = rows
            .iter()
            .copied()
            .filter(|r| r.example.elapsed_ms <= median_ms)
            .collect();
        let slow: Vec<_> = rows
            .iter()
            .copied()
            .filter(|r| {
                r.example.elapsed_ms >= boundary_ms
                    && selection.max_ms.is_none_or(|n| r.example.elapsed_ms <= n)
            })
            .collect();
        let mut signals = Vec::new();
        for (key, unit) in &self.fields {
            let Ok(unit) = unit else { continue };
            let all: Vec<_> = rows
                .iter()
                .filter_map(|r| r.numeric.get(key).map(|n| (*r, *n)))
                .collect();
            if all.is_empty() || all.iter().all(|(_, n)| *n == all[0].1) {
                continue;
            }
            let a: Vec<_> = typical
                .iter()
                .filter_map(|r| r.numeric.get(key).copied())
                .collect();
            let b: Vec<_> = slow
                .iter()
                .filter_map(|r| r.numeric.get(key).copied())
                .collect();
            let difference = separation(&a, &b);
            let scale = match unit.as_deref() {
                Some("ns") => Some(1e-6),
                Some("us" | "µs") => Some(1e-3),
                Some("ms") => Some(1.0),
                Some("s") => Some(1000.0),
                _ => None,
            };
            let duplicates_latency = scale.is_some_and(|scale| {
                all.iter()
                    .filter(|(r, n)| {
                        (n * scale - r.example.elapsed_ms).abs()
                            <= 0.001_f64.max(r.example.elapsed_ms * 0.002)
                    })
                    .count() as f64
                    / all.len() as f64
                    > 0.98
            });
            let mut files: BTreeMap<usize, (Vec<f64>, Vec<f64>)> = BTreeMap::new();
            for row in &typical {
                if let Some(n) = row.numeric.get(key) {
                    files.entry(row.source).or_default().0.push(*n);
                }
            }
            for row in &slow {
                if let Some(n) = row.numeric.get(key) {
                    files.entry(row.source).or_default().1.push(*n);
                }
            }
            let differences: Vec<_> = files
                .values()
                .filter(|(a, b)| a.len() >= 5 && b.len() >= 5)
                .filter_map(|(a, b)| separation(a, b))
                .collect();
            let sampled: Vec<_> = sample_indices(all.len(), 2048)
                .into_iter()
                .map(|i| (all[i].0.example.elapsed_ms, all[i].1))
                .collect();
            let slow_indices: Vec<_> = all
                .iter()
                .enumerate()
                .filter(|(_, (r, _))| {
                    r.example.elapsed_ms >= boundary_ms
                        && selection.max_ms.is_none_or(|n| r.example.elapsed_ms <= n)
                })
                .map(|(i, _)| i)
                .collect();
            let mut plot_indices: BTreeSet<_> =
                sample_indices(all.len(), 250).into_iter().collect();
            plot_indices.extend(
                sample_indices(slow_indices.len(), 80)
                    .into_iter()
                    .map(|i| slow_indices[i]),
            );
            let points = plot_indices
                .into_iter()
                .filter_map(|i| {
                    let (r, n) = &all[i];
                    (!r.example.start_ns.is_empty())
                        .then(|| (r.example.elapsed_ms, *n, r.example.clone()))
                })
                .collect();
            signals.push(Signal {
                key: key.clone(),
                unit: unit.clone(),
                typical: mean(a.iter().copied()),
                slow: mean(b.iter().copied()),
                typical_count: a.len(),
                slow_count: b.len(),
                typical_coverage: fraction(a.len(), typical.len()),
                slow_coverage: fraction(b.len(), slow.len()),
                separation: difference,
                correlation: spearman(&sampled),
                correlation_count: sampled.len(),
                duplicates_latency,
                files_compared: differences.len(),
                files_agree: differences
                    .iter()
                    .filter(|d| {
                        difference.is_some_and(|overall| {
                            overall != 0.0 && **d != 0.0 && d.signum() == overall.signum()
                        })
                    })
                    .count(),
                points,
            });
        }
        let quality = |s: &Signal| {
            if s.duplicates_latency {
                -1
            } else if s.typical_count.min(s.slow_count) < 20
                || s.typical_coverage.min(s.slow_coverage) < 0.5
            {
                0
            } else {
                1
            }
        };
        signals.sort_by(|a, b| {
            quality(b)
                .cmp(&quality(a))
                .then_with(|| {
                    b.separation
                        .unwrap_or(0.0)
                        .abs()
                        .total_cmp(&a.separation.unwrap_or(0.0).abs())
                })
                .then_with(|| a.key.cmp(&b.key))
        });
        let prevalence = |cohort: &[&Observation], key: &str, values: &BTreeSet<String>| {
            values
                .iter()
                .map(|v| {
                    (
                        v.clone(),
                        fraction(
                            cohort
                                .iter()
                                .filter(|r| r.groups.get(key) == Some(v))
                                .count(),
                            cohort.len(),
                        ),
                    )
                })
                .collect()
        };
        let groups: Vec<Group> = self
            .groups
            .iter()
            .filter_map(|(key, values)| {
                values.as_ref().filter(|v| v.len() > 1).map(|values| Group {
                    key: key.clone(),
                    values: values.iter().cloned().collect(),
                    typical: prevalence(&typical, key, values),
                    slow: prevalence(&slow, key, values),
                })
            })
            .collect();
        let mut mix_changes: Vec<_> = groups
            .iter()
            .flat_map(|group| {
                group.values.iter().filter_map(|value| {
                    let typical = group.typical[value];
                    let slow = group.slow[value];
                    ((slow - typical).abs() >= 0.15).then(|| MixChange {
                        key: group.key.clone(),
                        value: value.clone(),
                        typical,
                        slow,
                    })
                })
            })
            .collect();
        mix_changes.sort_by(|a, b| {
            (b.slow - b.typical)
                .abs()
                .total_cmp(&(a.slow - a.typical).abs())
        });
        mix_changes.truncate(2);
        let known = |cohort: &[&Observation]| {
            cohort
                .iter()
                .filter(|r| r.example.inside_ms.is_some())
                .count()
        };
        let histograms = categorical_histograms(&rows, &self.groups);
        Ok(Report {
            count: rows.len(),
            typical_count: typical.len(),
            slow_count: slow.len(),
            boundary_ms,
            median_ms,
            typical_elapsed_ms: mean(typical.iter().map(|r| r.example.elapsed_ms)),
            slow_elapsed_ms: mean(slow.iter().map(|r| r.example.elapsed_ms)),
            typical_inside_ms: mean(typical.iter().filter_map(|r| r.example.inside_ms)),
            slow_inside_ms: mean(slow.iter().filter_map(|r| r.example.inside_ms)),
            typical_outside_ms: mean(
                typical
                    .iter()
                    .filter_map(|r| r.example.inside_ms.map(|n| r.example.elapsed_ms - n)),
            ),
            slow_outside_ms: mean(
                slow.iter()
                    .filter_map(|r| r.example.inside_ms.map(|n| r.example.elapsed_ms - n)),
            ),
            typical_attributed: known(&typical),
            slow_attributed: known(&slow),
            typical_composition: cohort_composition(&typical)?,
            slow_composition: cohort_composition(&slow)?,
            signals,
            groups,
            histograms,
            mix_changes,
            examples: slow
                .iter()
                .rev()
                .filter(|r| !r.example.start_ns.is_empty())
                .take(8)
                .map(|r| r.example.clone())
                .collect(),
        })
    }
}

/// Shared logarithmic bins and per-value normalization preserve distribution
/// shape when category frequencies differ. The first bin includes zero.
fn categorical_histograms(
    rows: &[&Observation],
    groups: &BTreeMap<String, Option<BTreeSet<String>>>,
) -> Vec<CategoricalHistogram> {
    let positive_min = rows
        .iter()
        .map(|r| r.example.elapsed_ms)
        .filter(|n| *n > 0.0)
        .min_by(f64::total_cmp);
    // A nanosecond is the trace's smallest measurable elapsed duration.
    let low = positive_min.map_or(1e-6, |n| 10.0_f64.powf(n.log10().floor()));
    let maximum = rows.last().map_or(0.0, |r| r.example.elapsed_ms);
    let high = 10.0_f64
        .powf(maximum.max(low).log10().ceil())
        .max(low * 10.0);
    let mut edges = vec![0.0];
    edges.extend(
        (0..=HISTOGRAM_LOG_BINS)
            .map(|i| low * (high / low).powf(i as f64 / HISTOGRAM_LOG_BINS as f64)),
    );
    let bins = edges.len() - 1;
    groups
        .iter()
        .filter_map(|(key, discovered)| {
            let discovered = discovered.as_ref()?;
            if discovered.len() < 2 {
                return None;
            }
            let mut values = Vec::new();
            let mut count = 0;
            let mut max_share = 0.0_f64;
            let mut by_value: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
            for row in rows {
                if let Some(value) = row.groups.get(key) {
                    by_value
                        .entry(value)
                        .or_default()
                        .push(row.example.elapsed_ms);
                }
            }
            for (value, latencies) in by_value {
                // rows are already sorted by elapsed time for exact quantiles.
                let mut counts = vec![0; bins];
                for latency in &latencies {
                    let bin = edges
                        .partition_point(|edge| edge <= latency)
                        .saturating_sub(1)
                        .min(bins - 1);
                    counts[bin] += 1;
                }
                let shares: Vec<_> = counts
                    .into_iter()
                    .map(|n| fraction(n, latencies.len()))
                    .collect();
                max_share = shares.iter().copied().fold(max_share, f64::max);
                let quantile = |p: f64| {
                    latencies[((latencies.len() as f64 * p).ceil() as usize).saturating_sub(1)]
                };
                count += latencies.len();
                values.push(CategoryLatency {
                    value: value.to_string(),
                    count: latencies.len(),
                    median_ms: quantile(0.5),
                    p99_ms: quantile(0.99),
                    shares,
                });
            }
            // A field constant within a selected group offers no comparison.
            (values.len() > 1).then(|| CategoricalHistogram {
                key: key.clone(),
                count,
                missing_count: rows.len() - count,
                bin_edges_ms: edges.clone(),
                max_share,
                values,
            })
        })
        .collect()
}

/// Same equal-per-instance shares as the catalog's five-way composition.
/// Absent composition is explicitly unknown; zero-time rows have no share.
fn cohort_composition(cohort: &[&Observation]) -> Result<Option<CohortComposition>, String> {
    if cohort.is_empty() {
        return Ok(None);
    }
    let mut means = [0.0; 5];
    let mut shares = [0.0; 5];
    let mut share_count = 0;
    let mut detailed_count = 0;
    for (index, row) in cohort.iter().enumerate() {
        let parts = match &row.composition {
            Some(c) => {
                let values = [
                    c.on_cpu_ns,
                    c.blocked_ns,
                    c.async_wait_ns,
                    c.scheduler_delay_ns,
                    c.unknown_ns,
                ];
                if values.iter().any(|n| *n < 0) {
                    return Err("negative time-composition category".into());
                }
                detailed_count += usize::from(row.detailed);
                values.map(|n| n as f64 / 1e6)
            }
            None => [0.0, 0.0, 0.0, 0.0, row.example.elapsed_ms],
        };
        for (i, value) in parts.iter().enumerate() {
            means[i] += (value - means[i]) / (index + 1) as f64;
        }
        let total: f64 = parts.iter().sum();
        if total > 0.0 {
            share_count += 1;
            for (i, value) in parts.iter().enumerate() {
                shares[i] += (value / total - shares[i]) / share_count as f64;
            }
        }
    }
    Ok(Some(CohortComposition {
        count: cohort.len(),
        detailed_count,
        detailed_coverage: fraction(detailed_count, cohort.len()),
        categories: ["on_cpu", "blocked", "async_wait", "sched_delay", "unknown"]
            .into_iter()
            .enumerate()
            .map(|(i, key)| CompositionCategory {
                key,
                share: shares[i],
                mean_ms: means[i],
            })
            .collect(),
    }))
}

fn fraction(count: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        count as f64 / total as f64
    }
}

fn mean(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut count = 0;
    let mut average = 0.0;
    for n in values {
        count += 1;
        average += (n - average) / count as f64;
    }
    (count > 0).then_some(average)
}

/// Rank-biserial effect size: 2 P(slow > typical) - 1, splitting ties equally.
fn separation(typical: &[f64], slow: &[f64]) -> Option<f64> {
    if typical.is_empty() || slow.is_empty() {
        return None;
    }
    let mut sorted = typical.to_vec();
    sorted.sort_by(f64::total_cmp);
    let wins: f64 = slow
        .iter()
        .map(|n| {
            let below = sorted.partition_point(|v| v < n);
            let equal_end = sorted.partition_point(|v| v <= n);
            below as f64 + (equal_end - below) as f64 / 2.0
        })
        .sum();
    Some(2.0 * wins / (typical.len() as f64 * slow.len() as f64) - 1.0)
}

fn sample_indices(length: usize, limit: usize) -> Vec<usize> {
    let count = length.min(limit);
    (0..count).map(|i| i * length / count).collect()
}

fn ranks(values: &[f64]) -> Vec<f64> {
    let mut order: Vec<_> = (0..values.len()).collect();
    order.sort_by(|a, b| values[*a].total_cmp(&values[*b]));
    let mut ranks = vec![0.0; values.len()];
    let mut i = 0;
    while i < order.len() {
        let mut end = i + 1;
        while end < order.len() && values[order[end]] == values[order[i]] {
            end += 1;
        }
        for index in &order[i..end] {
            ranks[*index] = (i + end - 1) as f64 / 2.0;
        }
        i = end;
    }
    ranks
}

fn spearman(points: &[(f64, f64)]) -> Option<f64> {
    if points.len() < 2 {
        return None;
    }
    let x = ranks(&points.iter().map(|p| p.0).collect::<Vec<_>>());
    let y = ranks(&points.iter().map(|p| p.1).collect::<Vec<_>>());
    let center = (points.len() - 1) as f64 / 2.0;
    let (mut xy, mut xx, mut yy) = (0.0, 0.0, 0.0);
    for (x, y) in x.iter().zip(&y) {
        let (x, y) = (x - center, y - center);
        xy += x * y;
        xx += x * x;
        yy += y * y;
    }
    (xx > 0.0 && yy > 0.0).then(|| xy / (xx * yy).sqrt())
}

fn internal(error: impl std::fmt::Display) -> (StatusCode, String) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("span analysis failed: {error}"),
    )
}

pub(crate) async fn get_tail(
    State(state): State<AppState>,
    creds: MaybeCreds,
    Query(scope): Query<SpanStatsParams>,
    Query(options): Query<TailOptions>,
) -> Result<Json<TailResponse>, (StatusCode, String)> {
    let params = TailParams { scope, options };
    let selection = params
        .selection()
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let permit = ANALYSIS_LIMIT
        .acquire()
        .await
        .expect("analysis semaphore is never closed");
    let agg = state
        .agg_context_for(
            params.scope.bucket.as_deref(),
            params.scope.prefix.as_deref(),
            params.scope.aws_region.as_deref(),
            creds,
        )
        .await?
        .ok_or((
            StatusCode::NOT_FOUND,
            "span analysis requires aggregation".into(),
        ))?;
    let scope = aggregate::Scope {
        start_ns: params.scope.start_ns,
        end_ns: params.scope.end_ns,
        service: params.scope.service,
        hosts: params.scope.host,
    };
    let resolved = refine::resolve(
        &agg,
        &scope,
        refine::RefineOpts {
            max_files: Some(
                params
                    .scope
                    .max_files
                    .unwrap_or(MAX_FILES)
                    .clamp(1, MAX_FILES),
            ),
        },
    )
    .await
    .ok_or((
        StatusCode::NOT_FOUND,
        "no source files match this scope".into(),
    ))?;
    let files_used = resolved.capped.len();
    let files_matched = resolved.files_matched;
    let agg = std::sync::Arc::new(agg);
    let mut folds = Box::pin(refine::fold_stream(
        agg.clone(),
        state.fold_limits.clone(),
        resolved.unfolded_capped(),
    ));
    while let Some(outcome) = folds.next().await {
        if let refine::FoldOutcome::Failed { raw_key, error } = outcome {
            return Err(internal(format!("{raw_key}: {error}")));
        }
    }
    let collector = Collector::default();
    // Blocking parsing and calculation stay off Tokio workers. Move the permit
    // through each job so cancellation cannot create unbounded orphaned work.
    let mut work = (collector, selection, permit);
    for (source, (raw_key, full_key)) in resolved.capped.iter().enumerate() {
        let key = aggregate::spans_part_key_pub(&agg.output_prefix, full_key);
        let data = agg
            .output
            .get_object(&agg.output_bucket, &key)
            .await
            .map_err(internal)?;
        let url = format!(
            "/api/object?bucket={}&key={}",
            urlencoding::encode(&agg.source_bucket),
            urlencoding::encode(raw_key)
        );
        let (start, end) = (scope.start_ns, scope.end_ns);
        work = tokio::task::spawn_blocking(move || {
            let (mut collector, selection, permit) = work;
            let reader = SpansBatchReader::new(start, end, Some(selection.uid), None);
            let (_, result) = reader.read(data, |input| {
                if let SpanStatsInput::Row(row) = input {
                    collector.push(*row, &selection, source, &url);
                }
                Ok(())
            });
            result.map(|()| (collector, selection, permit))
        })
        .await
        .map_err(internal)?
        .map_err(internal)?;
    }
    let response = tokio::task::spawn_blocking(move || {
        let (collector, selection, _permit) = work;
        collector.report(&selection).map(|report| TailResponse {
            report,
            files_used,
            files_matched,
            truncated: collector.truncated,
            fields_truncated: collector.fields_truncated,
        })
    })
    .await
    .map_err(internal)?
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(response))
}

pub(crate) async fn post_tail(
    Query(scope): Query<SpanStatsParams>,
    Query(options): Query<TailOptions>,
    body: Bytes,
) -> Result<Json<TailResponse>, (StatusCode, String)> {
    let params = TailParams { scope, options };
    let selection = params
        .selection()
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let permit = ANALYSIS_LIMIT
        .acquire()
        .await
        .expect("analysis semaphore is never closed");
    let response = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let trace = raw_trace_bytes(
            &body,
            super::RAW_SPAN_STATS_BODY_LIMIT,
            super::RAW_SPAN_STATS_DECOMPRESSED_LIMIT,
        )?;
        let (_, _, _, spans) = decode::decode_samples(&trace, "raw-trace")?;
        let mut collector = Collector::default();
        for span in spans {
            if params
                .scope
                .start_ns
                .is_some_and(|n| (span.end_ns as i128) < n as i128)
                || params
                    .scope
                    .end_ns
                    .is_some_and(|n| (span.end_ns as i128) >= n as i128)
            {
                continue;
            }
            // Missing estimates contribute zero to the five-way invariant;
            // unknown_ns already carries the unclassified remainder.
            let composition = RowComposition {
                on_cpu_ns: i64::try_from(span.on_cpu_ns_est.unwrap_or(0))?,
                blocked_ns: i64::try_from(span.blocked_ns_est.unwrap_or(0))?,
                async_wait_ns: i64::try_from(span.async_wait_ns.unwrap_or(0))?,
                scheduler_delay_ns: i64::try_from(span.scheduler_delay_ns.unwrap_or(0))?,
                unknown_ns: i64::try_from(span.unknown_ns)?,
            };
            let row = SpanStatsRow {
                span_type_uid: span.span_type_uid,
                kind: span.kind,
                name: span.name,
                target: Some(span.target),
                callsite_file: span.callsite_file,
                callsite_line: span.callsite_line,
                elapsed_ns: i64::try_from(span.elapsed_ns)?,
                observed_active_wall_ns: Some(i64::try_from(span.observed_active_wall_ns)?),
                details_complete: Some(span.details_complete),
                attributes: span.attributes,
                attribute_units: span.attribute_units,
                composition: Some(composition),
                exemplar: Some(Exemplar {
                    span_uid: hex::encode(span.span_uid),
                    start_ns: i64::try_from(span.start_ns)?,
                    end_ns: i64::try_from(span.end_ns)?,
                    elapsed_ns: i64::try_from(span.elapsed_ns)?,
                    host: span.host,
                    source_key: span.source_key,
                    attributes: Vec::new(),
                    callsite_file: None,
                    callsite_line: None,
                    composition: None,
                }),
            };
            collector.push(row, &selection, 0, "");
        }
        let report = collector.report(&selection).map_err(anyhow::Error::msg)?;
        Ok::<_, anyhow::Error>(TailResponse {
            report,
            files_used: 1,
            files_matched: 1,
            truncated: collector.truncated,
            fields_truncated: collector.fields_truncated,
        })
    })
    .await
    .map_err(internal)?
    .map_err(|e| (StatusCode::BAD_REQUEST, format!("{e:#}")))?;
    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    fn params(extra: &str) -> TailParams {
        let uri = format!("/api/span-tail?span_type_uid={}&{extra}", "01".repeat(16))
            .parse()
            .unwrap();
        TailParams {
            scope: Query::<SpanStatsParams>::try_from_uri(&uri).unwrap().0,
            options: Query::<TailOptions>::try_from_uri(&uri).unwrap().0,
        }
    }

    fn row(n: i64) -> SpanStatsRow {
        SpanStatsRow {
            span_type_uid: [1; 16],
            kind: "test".into(),
            name: "same-name".into(),
            target: None,
            callsite_file: None,
            callsite_line: None,
            elapsed_ns: n * 1_000_000,
            exemplar: Some(Exemplar {
                elapsed_ns: n * 1_000_000,
                span_uid: n.to_string(),
                callsite_file: None,
                callsite_line: None,
                host: "host".into(),
                start_ns: 1,
                end_ns: 1 + n * 1_000_000,
                source_key: "test".into(),
                composition: None,
                attributes: Vec::new(),
            }),
            attributes: vec![
                ("Work".into(), (n as f64 / 2.0).to_string()),
                ("ElapsedAlias".into(), n.to_string()),
                ("Constant".into(), "1".into()),
                ("Mode".into(), if n > 900 { "bulk" } else { "small" }.into()),
            ],
            attribute_units: vec![
                ("Work".into(), "ms".into()),
                ("ElapsedAlias".into(), "ms".into()),
            ],
            observed_active_wall_ns: Some(n * 100_000),
            composition: None,
            details_complete: Some(n % 2 == 0),
        }
    }

    #[rstest]
    #[case("1", Some(1.0))]
    #[case("1.5e2", Some(150.0))]
    #[case("NaN", None)]
    #[case("Infinity", None)]
    #[case(" 1", None)]
    #[case("9007199254740992", None)]
    #[case("request-123", None)]
    fn numeric_values_do_not_turn_missing_values_or_identifiers_into_numbers(
        #[case] value: &str,
        #[case] expected: Option<f64>,
    ) {
        assert_eq!(numeric(value), expected);
    }

    #[rstest]
    #[case(vec![1.0, 2.0], vec![3.0], Some(1.0))]
    #[case(vec![3.0], vec![1.0, 2.0], Some(-1.0))]
    #[case(vec![1.0, 2.0], vec![1.0, 2.0], Some(0.0))]
    #[case(vec![], vec![1.0], None)]
    fn effect_size_splits_ties_and_keeps_missing_groups_unavailable(
        #[case] typical: Vec<f64>,
        #[case] slow: Vec<f64>,
        #[case] expected: Option<f64>,
    ) {
        assert_eq!(separation(&typical, &slow), expected);
    }

    #[rstest]
    #[case("slow_percentile=NaN")]
    #[case("slow_percentile=100")]
    #[case("min_span_ns=-1")]
    #[case("min_span_ns=5&max_span_ns=1")]
    #[case("start_ns=20&end_ns=10")]
    #[case("group_key=Mode")]
    fn invalid_comparison_parameters_are_rejected(#[case] query: &str) {
        assert!(params(query).selection().is_err());
    }

    #[test]
    fn query_retains_repeated_scope_and_attribute_filters() {
        let p = params("host=a&host=b&attr=Mode=bulk&start_ns=10&end_ns=20&slow_percentile=95");
        assert_eq!(p.scope.host, ["a", "b"]);
        assert_eq!(p.scope.start_ns, Some(10));
        assert_eq!(p.selection().unwrap().filters.len(), 1);
    }

    #[test]
    fn report_ranks_fields_and_uses_only_complete_interval_timing() {
        let selection = params("").selection().unwrap();
        let mut collector = Collector::default();
        for n in 1..=1000 {
            collector.push(row(n), &selection, 0, "/source");
        }
        let report = collector.report(&selection).unwrap();
        assert_eq!(
            (report.count, report.typical_count, report.slow_count),
            (1000, 500, 11)
        );
        assert_eq!(report.boundary_ms, 990.0);
        assert_eq!(report.typical_elapsed_ms, Some(250.5));
        assert_eq!(report.slow_elapsed_ms, Some(995.0));
        assert_eq!(report.typical_attributed, 250);
        assert_eq!(report.slow_attributed, 6);
        assert_eq!(report.signals.len(), 2);
        assert_eq!(report.signals[0].key, "Work");
        assert_eq!(report.signals[0].correlation, Some(1.0));
        assert!(report.signals[1].duplicates_latency);
        assert!(report.signals.iter().all(|s| s.points.len() <= 330));
        assert_eq!(report.examples.len(), 8);
        let group = params("group_key=Mode&group_value=bulk")
            .selection()
            .unwrap();
        let grouped = collector.report(&group).unwrap();
        assert_eq!(grouped.count, 100);
        assert_eq!(grouped.boundary_ms, 999.0);
        assert_eq!(grouped.slow_count, 2);
    }

    fn category<'a>(composition: &'a CohortComposition, key: &str) -> &'a CompositionCategory {
        composition
            .categories
            .iter()
            .find(|c| c.key == key)
            .unwrap()
    }

    fn tagged_row(n: i64, value: Option<&str>) -> SpanStatsRow {
        let mut row = row(n);
        row.attributes = value
            .map(|v| vec![("Mode".into(), v.into())])
            .unwrap_or_default();
        row
    }

    #[test]
    fn categorical_histograms_normalize_unequal_groups_and_include_the_last_edge() {
        let selection = params("").selection().unwrap();
        let mut collector = Collector::default();
        for (value, repetitions) in [("large", 100), ("small", 1)] {
            for _ in 0..repetitions {
                for latency in [1, 10, 100] {
                    collector.push(tagged_row(latency, Some(value)), &selection, 0, "");
                }
            }
        }
        let report = collector.report(&selection).unwrap();
        let histogram = &report.histograms[0];
        assert_eq!(histogram.count, 303);
        assert_eq!(histogram.missing_count, 0);
        assert_eq!(histogram.values[0].count, 300);
        assert_eq!(histogram.values[1].count, 3);
        assert_eq!(histogram.values[0].shares, histogram.values[1].shares);
        for value in &histogram.values {
            assert!((value.shares.iter().sum::<f64>() - 1.0).abs() < 1e-12);
            assert_eq!(value.median_ms, 10.0);
            assert_eq!(value.p99_ms, 100.0);
            assert_eq!(value.shares.last(), Some(&(1.0 / 3.0)));
        }
    }

    #[test]
    fn categorical_histograms_distinguish_missing_zero_and_slow_values() {
        let selection = params("").selection().unwrap();
        let mut collector = Collector::default();
        for (n, value) in [
            (0, Some("fast")),
            (1, Some("fast")),
            (100, Some("slow")),
            (500, None),
        ] {
            collector.push(tagged_row(n, value), &selection, 0, "");
        }
        let report = collector.report(&selection).unwrap();
        let histogram = &report.histograms[0];
        assert_eq!((histogram.count, histogram.missing_count), (3, 1));
        assert_eq!(histogram.bin_edges_ms[0], 0.0);
        assert_eq!(histogram.values[0].shares[0], 0.5);
        assert_eq!(histogram.values[0].p99_ms, 1.0);
        assert_eq!(histogram.values[1].p99_ms, 100.0);
        assert_eq!(
            histogram.values[0]
                .shares
                .iter()
                .zip(&histogram.values[1].shares)
                .filter(|(a, b)| **a > 0.0 && **b > 0.0)
                .count(),
            0
        );
    }

    #[rstest]
    #[case(0)]
    #[case(1)]
    #[case(i64::MAX)]
    fn categorical_bins_remain_finite_and_ordered_for_constant_or_extreme_latency(
        #[case] elapsed_ns: i64,
    ) {
        let selection = params("").selection().unwrap();
        let mut collector = Collector::default();
        for value in ["a", "b"] {
            let mut row = tagged_row(0, Some(value));
            row.elapsed_ns = elapsed_ns;
            collector.push(row, &selection, 0, "");
        }
        let report = collector.report(&selection).unwrap();
        let histogram = &report.histograms[0];
        assert!(
            histogram
                .bin_edges_ms
                .windows(2)
                .all(|w| w[0].is_finite() && w[1] > w[0])
        );
        assert!(
            histogram
                .values
                .iter()
                .all(|v| v.shares.iter().sum::<f64>() == 1.0)
        );
    }

    #[test]
    fn categorical_histograms_follow_group_filters_and_skip_unbounded_fields() {
        let selection = params("").selection().unwrap();
        let mut collector = Collector::default();
        for n in 0..26 {
            let mut row = tagged_row(n, Some(if n % 2 == 0 { "a" } else { "b" }));
            row.attributes.extend([
                ("Region".into(), if n < 13 { "east" } else { "west" }.into()),
                ("Identifier".into(), format!("id-{n}")),
                ("Constant".into(), "same".into()),
            ]);
            collector.push(row, &selection, 0, "");
        }
        let all = collector.report(&selection).unwrap();
        assert_eq!(all.histograms.len(), 2);
        let selected = params("group_key=Region&group_value=east")
            .selection()
            .unwrap();
        let grouped = collector.report(&selected).unwrap();
        assert_eq!(grouped.histograms.len(), 1);
        assert_eq!(grouped.histograms[0].key, "Mode");
        assert_eq!(grouped.histograms[0].count, 13);
        assert_eq!(grouped.histograms[0].values[0].count, 7);
        assert_eq!(grouped.histograms[0].values[1].count, 6);
    }

    fn composed_row(n: i64, parts: [i64; 5]) -> SpanStatsRow {
        let mut row = row(n);
        row.details_complete = Some(true);
        row.composition = Some(RowComposition {
            on_cpu_ns: parts[0],
            blocked_ns: parts[1],
            async_wait_ns: parts[2],
            scheduler_delay_ns: parts[3],
            unknown_ns: parts[4],
        });
        row
    }

    #[test]
    fn paired_composition_weights_instances_equally_and_follows_exact_cohorts() {
        let selection = params("").selection().unwrap();
        let mut collector = Collector::default();
        for (n, parts) in [
            (1, [1_000_000, 0, 0, 0, 0]),
            (9, [0, 0, 9_000_000, 0, 0]),
            (100, [0, 100_000_000, 0, 0, 0]),
            (1000, [0, 0, 0, 500_000_000, 500_000_000]),
        ] {
            collector.push(composed_row(n, parts), &selection, 0, "/source");
        }
        let report = collector.report(&selection).unwrap();
        let typical = report.typical_composition.unwrap();
        assert_eq!(typical.count, 2);
        assert_eq!(category(&typical, "on_cpu").share, 0.5);
        assert_eq!(category(&typical, "async_wait").share, 0.5);
        assert_eq!(category(&typical, "on_cpu").mean_ms, 0.5);
        assert_eq!(category(&typical, "async_wait").mean_ms, 4.5);
        let slow = report.slow_composition.unwrap();
        assert_eq!(category(&slow, "sched_delay").share, 0.5);
        assert_eq!(category(&slow, "unknown").mean_ms, 500.0);

        let band = params("min_span_ns=9000000&max_span_ns=100000000")
            .selection()
            .unwrap();
        let report = collector.report(&band).unwrap();
        let selected = report.slow_composition.unwrap();
        assert_eq!(selected.count, 2);
        assert_eq!(category(&selected, "async_wait").share, 0.5);
        assert_eq!(category(&selected, "blocked").share, 0.5);
        assert_eq!(category(&selected, "blocked").mean_ms, 50.0);

        let group = params("group_key=Mode&group_value=small")
            .selection()
            .unwrap();
        let report = collector.report(&group).unwrap();
        assert_eq!(report.slow_composition.unwrap().categories[1].share, 1.0);
    }

    #[test]
    fn missing_composition_stays_unknown_instead_of_disappearing_from_the_bar() {
        let selection = params("min_span_ns=1000000&max_span_ns=3000000")
            .selection()
            .unwrap();
        let mut collector = Collector::default();
        collector.push(composed_row(1, [1_000_000, 0, 0, 0, 0]), &selection, 0, "");
        collector.push(row(3), &selection, 0, "");
        let selected = collector
            .report(&selection)
            .unwrap()
            .slow_composition
            .unwrap();
        assert_eq!(selected.detailed_count, 1);
        assert_eq!(selected.detailed_coverage, 0.5);
        assert_eq!(category(&selected, "on_cpu").share, 0.5);
        assert_eq!(category(&selected, "unknown").share, 0.5);
        assert_eq!(category(&selected, "unknown").mean_ms, 1.5);
        assert!(cohort_composition(&[]).unwrap().is_none());
    }

    #[rstest]
    #[case([0, 0, 0, 0, 0], false)]
    #[case([-1, 0, 0, 0, 0], true)]
    #[case([0, -1, 0, 0, 0], true)]
    #[case([0, 0, -1, 0, 0], true)]
    #[case([0, 0, 0, -1, 0], true)]
    #[case([0, 0, 0, 0, -1], true)]
    fn zero_time_and_invalid_composition_do_not_produce_plausible_shares(
        #[case] parts: [i64; 5],
        #[case] invalid: bool,
    ) {
        let selection = params("").selection().unwrap();
        let mut collector = Collector::default();
        collector.push(composed_row(0, parts), &selection, 0, "");
        let report = collector.report(&selection);
        if invalid {
            assert!(report.err().unwrap().contains("negative time-composition"));
        } else {
            let composition = report.unwrap().typical_composition.unwrap();
            assert!(
                composition
                    .categories
                    .iter()
                    .all(|c| c.share == 0.0 && c.mean_ms == 0.0)
            );
        }
    }

    #[test]
    fn exact_type_filter_separates_same_names_and_conflicting_units_are_excluded() {
        let selection = params("").selection().unwrap();
        let mut collector = Collector::default();
        collector.push(row(1), &selection, 0, "/source");
        let mut foreign = row(100);
        foreign.span_type_uid = [2; 16];
        collector.push(foreign, &selection, 0, "/source");
        let mut mismatch = row(2);
        mismatch.attribute_units[0].1 = "bytes".into();
        collector.push(mismatch, &selection, 0, "/source");
        let report = collector.report(&selection).unwrap();
        assert_eq!(report.count, 2);
        assert!(report.signals.iter().all(|s| s.key != "Work"));
    }

    #[rstest]
    #[case(vec![(1.0, 1.0), (2.0, 2.0), (3.0, 3.0)], Some(1.0))]
    #[case(vec![(1.0, 3.0), (2.0, 2.0), (3.0, 1.0)], Some(-1.0))]
    #[case(vec![(1.0, 2.0), (2.0, 2.0), (3.0, 2.0)], None)]
    fn spearman_keeps_constant_fields_unavailable(
        #[case] points: Vec<(f64, f64)>,
        #[case] expected: Option<f64>,
    ) {
        assert_eq!(spearman(&points), expected);
    }

    #[test]
    fn opposite_file_directions_do_not_support_a_pooled_zero_effect() {
        let selection = params("min_span_ns=101000000").selection().unwrap();
        let mut collector = Collector::default();
        for n in 1..=200 {
            let source = usize::from((51..=100).contains(&n) || n > 150);
            let mut row = row(n);
            row.attributes[0].1 = if source == 0 { n } else { -n }.to_string();
            collector.push(row, &selection, source, "/source");
        }
        let report = collector.report(&selection).unwrap();
        let field = report.signals.iter().find(|s| s.key == "Work").unwrap();
        assert_eq!(field.separation, Some(0.0));
        assert_eq!(field.files_compared, 2);
        assert_eq!(field.files_agree, 0);
    }

    #[test]
    fn producer_units_survive_parquet_and_raw_analysis_uses_same_type_identity() {
        let (_, _, _, mut spans) = decode::decode_samples(
            &raw_trace_bytes(
                include_bytes!("../../../ui/public/demo-trace.bin"),
                super::super::RAW_SPAN_STATS_BODY_LIMIT,
                super::super::RAW_SPAN_STATS_DECOMPRESSED_LIMIT,
            )
            .unwrap(),
            "fixture",
        )
        .unwrap();
        let mut span = spans.pop().unwrap();
        span.attributes = vec![("Payload".into(), "42".into())];
        span.attribute_units = vec![("Payload".into(), "bytes".into())];
        let uid = span.span_type_uid;
        let mut data = Vec::new();
        crate::ingest::parquet_writer::write_spans(&mut data, &[span]).unwrap();
        let reader = SpansBatchReader::new(None, None, Some(uid), None);
        let mut seen = 0;
        let (_, result) = reader.read(data, |input| {
            if let SpanStatsInput::Row(row) = input {
                seen += 1;
                assert_eq!(row.attribute_units, [("Payload".into(), "bytes".into())]);
            }
            Ok(())
        });
        result.unwrap();
        assert_eq!(seen, 1);
    }

    #[tokio::test]
    async fn raw_endpoint_decodes_the_trace_on_the_server() {
        let trace = include_bytes!("../../../ui/public/demo-trace.bin");
        let (_, _, _, spans) = decode::decode_samples(
            &raw_trace_bytes(
                trace,
                super::super::RAW_SPAN_STATS_BODY_LIMIT,
                super::super::RAW_SPAN_STATS_DECOMPRESSED_LIMIT,
            )
            .unwrap(),
            "fixture",
        )
        .unwrap();
        let uid = spans[0].span_type_uid;
        let expected = spans.iter().filter(|s| s.span_type_uid == uid).count();
        let uri = format!("/api/span-tail?span_type_uid={}", hex::encode(uid))
            .parse()
            .unwrap();
        let response = post_tail(
            Query::<SpanStatsParams>::try_from_uri(&uri).unwrap(),
            Query::<TailOptions>::try_from_uri(&uri).unwrap(),
            Bytes::from_static(trace),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(response.report.count, expected);
        assert_eq!(response.files_used, 1);
        let selection = TailParams {
            scope: Query::<SpanStatsParams>::try_from_uri(&uri).unwrap().0,
            options: Query::<TailOptions>::try_from_uri(&uri).unwrap().0,
        }
        .selection()
        .unwrap();
        let mut data = Vec::new();
        crate::ingest::parquet_writer::write_spans(&mut data, &spans).unwrap();
        let mut collector = Collector::default();
        let (_, result) = SpansBatchReader::new(None, None, Some(uid), None).read(data, |input| {
            if let SpanStatsInput::Row(row) = input {
                collector.push(*row, &selection, 0, "");
            }
            Ok(())
        });
        result.unwrap();
        let folded = collector.report(&selection).unwrap();
        assert_eq!(
            serde_json::to_value(response.report.typical_composition).unwrap(),
            serde_json::to_value(folded.typical_composition).unwrap(),
        );
        assert_eq!(
            serde_json::to_value(response.report.slow_composition).unwrap(),
            serde_json::to_value(folded.slow_composition).unwrap(),
        );
        assert_eq!(
            serde_json::to_value(response.report.histograms).unwrap(),
            serde_json::to_value(folded.histograms).unwrap(),
        );
    }
}
