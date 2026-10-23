# Span Explorer UI task list

Status: all twenty-four tasks are integrated and verified. The user
authorized direct integration through subagents, coordination, QA, and demos;
the feature remains on the shared branch for final review before main.
Keep the task numbers stable.

Follow [WORKFLOW.md](WORKFLOW.md) when the user authorizes an assignment.
The coordinator assigns batches that minimize conflicting edits.

## Assignment ledger

| Batch | Tasks | Owner | Branch | Status |
| --- | --- | --- | --- | --- |
| Page | 4, 5, 8, 9, 15 | page-layout | `codex/span-ui-page` | Integrated; native-page QA passed |
| Backend | 3, 11 (aggregation), 12 | backend-analysis | `codex/span-ui-backend` | Integrated; full Rust/stress and raw/aggregate QA passed |
| Histograms | 13, 14, 17, 18 | property-histograms | `codex/span-ui-histograms` | Integrated; component and mobile QA passed |
| Numeric | 1, 2, 6, 7, 10, 11 (rendering), 16; property controls integration | page-layout | `codex/span-ui-numeric` | Integrated; density colors, keyboard and native QA passed |
| Default analysis | 19 | page-layout | `codex/span-ui-default-analysis` | Integrated; full UI and 16 native lifecycle checks passed |
| True stacked distribution | 20 | property-histograms | `codex/span-ui-true-stacked` | Integrated; exact pooled counts and native one-graph replay passed |
| Tail evidence | 21, 24 (data) | backend-analysis | `codex/span-ui-tail-evidence` | Integrated; full Rust/stress and metadata bounds/parity checks passed |
| Property interaction | 21 (rendering), 22, 23, 24 (rendering) | page-layout | `codex/span-ui-property-interaction` | Integrated; native table/scope/point fields and resize regression passed |

Design guidance: start with why the user is here, minimize the explanation a
visual needs, and make the initial view useful for deciding where to go deeper.
Keep analysis in the backend and render its results in the frontend.

- [x] **1. Replace raw Spearman numbers with qualitative correlation labels.**
  Use descriptions such as "Highly correlated" and "Not correlated", with a
  clear label such as "Perfectly correlated" for +1. Handle inverse correlation
  and unavailable estimates explicitly. Keep the coefficient and its rank-based
  meaning available on demand; the label must not imply causation.

- [x] **2. Make observation warnings explain themselves on click.**
  Badges such as "Limited observations" should open a concise explanation of
  the actual reason, including relevant counts, coverage, and thresholds.
  Support keyboard activation and dismissal.

- [x] **3. Automatically hide fields that repeat elapsed time.**
  Elapsed-time aliases should never appear among the numeric field graphs,
  including after expanding the full field list. Exclude them from visible
  counts, ranking, and shared field-axis calculations. Preserve a timer that
  matches elapsed time for ordinary requests but differs meaningfully in the
  tail; a majority-match rule must not hide that signal.

- [x] **4. Make recomputation visually obvious.**
  Clearly mark graphs as being recomputed, for example with a simple blur or
  dimming treatment and one loading indicator. Previously rendered results
  must not look current or remain misleadingly interactive while loading.
  Restore the normal presentation when the request completes; make failure
  and cancellation states clear.

- [x] **5. Remove extra repetitions of the selected span name.**
  Preserve the requested two appearances across the page and remove additional
  copies. Audit the selected-span bar, detail headings, and lower analysis UI
  together when consolidating the layout.

- [x] **6. Explain a dot's click action before it is clicked.**
  Hovering or focusing a dot should show its values and clearly say that
  clicking opens the corresponding trace focused on that span. The tooltip
  must be discoverable before navigation.

- [x] **7. Share scales between graphs with identical units by default.**
  Graphs displaying the same unit should use the same value-axis limits.
  Normalize compatible time units to one displayed unit, so if one time-field
  graph needs a 12 ms maximum, all time-field graphs use that maximum.
  Preserve explicit unknown units rather than guessing a conversion.

- [x] **8. Consolidate the new analysis UI and the existing lower UI.**
  Build one coherent selected-span investigation view. Combine overlapping
  graphs, summaries, composition displays, and controls while retaining useful
  functionality.

- [x] **9. Integrate the analysis directly into the page layout.**
  Remove the unnecessary inset container and its wasted padding. Use the
  available width and height for graphs, with consistent page-level alignment
  and a usable mobile layout.

- [x] **10. Remove "Higher in slow XX% of pairs".**
  **Feedback received:** after discussing the pair comparison, the user asked
  to drop the statistic. Keep the numeric graphs and actual typical/slow
  values. Do not replace the removed statistic with another pair-score label.

- [x] **11. Make scatterplot density visible.**
  Distinguish dense regions from sparse ones, especially to the left of the
  slow cutoff. Derive density from the backend's loaded observations so the
  bounded dot sample does not misrepresent concentration. Give the density
  encoding a clear legend and preserve a way to inspect individual traces.
  Color density blue outside the slow/selected range and orange inside it,
  with brightness showing bin counts. Split cells visually at exact selection
  boundaries; their counts still describe the entire bin.

## Coordination

- Assign tasks 5, 8, and 9 together or agree on the page layout before parallel
  implementation; they affect the same structure.
- Complete task 3 before finalizing the shared scales in task 7.
- Task 10 requires user feedback when work starts, not during backlog creation.
- For implemented tasks, verify the visual result on actual data and check
  loading, custom selections, desktop/mobile layouts, and keyboard interaction
  where relevant.

## Additional UI feedback

- [x] **12. Show only properties with meaningfully different latency distributions.**
  Filter categorical properties to those whose values have meaningful latency
  differences. Define the criterion before implementation, account for sample
  size, and compute the comparison in the backend.

- [x] **13. Make overlay the default, with an optional stacked histogram view.**
  Default to overlaid distributions. Provide a control to switch to stacked
  histograms using the same rendering style, colors, bins, and comparable axes.

- [x] **14. Rename "Categories" to "Properties" and add property filter buttons.**
  Use "Properties" in the visible UI. Provide buttons to filter/select the
  displayed properties, with clear active states.

- [x] **15. Show numeric results directly below the property graphs.**
  Present numeric results below the categorical property results rather than
  hiding them behind a separate view. When there are no meaningful categorical
  properties, give the numeric results a clearly separated section.

- [x] **16. Clarify "Mix shift" with human input.**
  **Feedback received:** show typical and slow property-value proportions
  visually. Use aligned bars with consistent value colors and actual counts,
  rather than the "Mix shift" text.

- [x] **17. Include raw counts in overlaid histogram readouts.**
  The overlay should display raw span counts for each series and latency bin,
  alongside any percentages. Clearly identify the corresponding value and bin.

- [x] **18. Adapt the top histogram's behavior for multiple series.**
  Show a labeled, dashed p99 line for every series, including both series in a
  two-value overlay. Reuse the top histogram's axes, units, percentile marker
  conventions, readouts, and selection behavior for the multi-series view.
  Preserve the line rendering of distributions that works well for overlays.

Coordinate tasks 13, 17, and 18
because they affect the same histogram component. Task 16 requires user
feedback when work starts.

## Follow-up feedback

- [x] **19. Open the analysis by default for the selected span.**
  Start the backend comparison automatically on initial selection and when
  the selected span or source changes. Repeated rendering of the same context
  must not issue duplicate requests or retry a cancelled or failed analysis.
  Preserve explicit cancellation and retry, and make initial loading visible.

- [x] **20. Stack categorical contributions on one graph.**
  In stacked mode, draw cumulative layers whose sum is the total recorded
  distribution. Weight each value by its exact population instead of summing
  independently normalized curves. Preserve overlay mode, colors, markers,
  exact readouts, and brushing.

- [x] **21. Make numeric ranking and tail association useful and consistent.**
  **Feedback received:** the user agreed to a primary typical/slow distribution
  difference with coverage separate and overall correlation available on
  demand, and requested a pop-out table of details. Use the backend's exact
  recorded-value CDF difference with a descriptive sampling allowance.
  Explain why ranking can differ from the overall-correlation badge. Inspect
  actual recorded coverage and tail observations before proposing a metric
  better suited to finding slow-tail leads. Discuss the proposal with the
  user; do not reinstate the discarded pairs statistic or imply causation.

- [x] **22. Remove property controls with no meaningful action.**
  A sole already-selected property name must not look like an inert button.
  Multiple-property selection must visibly change the displayed distribution.

- [x] **23. Put value-scoping controls beside the relevant property.**
  Make the selectable property values apparent near the graph. Retain a
  visible way to return to all values even if the scoped property no longer
  passes the distribution screen.

- [x] **24. Show the span's recorded key/value fields on point hover.**
  Supply point metadata from the backend and show it on hover and keyboard
  focus. Keep trace navigation discoverable and metadata/readouts bounded;
  missing or truncated fields must be explicit.

## Completion evidence

The combined feature passes 1,682 Rust tests and the required stress run,
2,805 UI tests, TypeScript checks, and the Vite, viewer embedding, and release
builds. Focused numeric
browser checks cover qualitative labels, explanations, shared axes, exact
density color boundaries, keyboard trace samples, loading/failure/cancellation,
custom brushing, and mobile layout.

The latest combined replay passes 32 native aggregate checks and 37 independent
aggregate/raw/mobile and metadata edge checks, with zero browser exceptions.
These cover exact cohort table values, conservative ranking, sparse coverage,
true stacked contributions, property scope and persistent reset, failure
recovery, ordered original fields, hover/keyboard inspection, and resize
dismissal with focus restoration. Controlled responses additionally exercise
long strings, duplicate keys, safe literal text, and empty/omitted/unavailable
metadata. Alias suppression was verified on both source modes; deterministic
fixtures preserve rare-tail and brushed-cohort divergences.
Production captures and recordings remain private, outside the repository.
Clippy reports only the pre-existing background-symbolization warning.

Automatic initial analysis additionally passes 16 native aggregate/raw checks,
including unchanged selection, custom deep links, failure/retry, cancellation,
span switching, and mobile. The current UI embedding build passes.
