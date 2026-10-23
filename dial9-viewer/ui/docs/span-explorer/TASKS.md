# Span Explorer UI task list

Status: planning only. These tasks are recorded for future assignment; do not
execute them yet. Keep the task numbers stable when assigning work.

Follow [WORKFLOW.md](WORKFLOW.md) when the user authorizes an assignment.
Unassigned tasks remain paused.

Design guidance: start with why the user is here, minimize the explanation a
visual needs, and make the initial view useful for deciding where to go deeper.
Keep analysis in the backend and render its results in the frontend.

- [ ] **1. Replace raw Spearman numbers with qualitative correlation labels.**
  Use descriptions such as "Highly correlated" and "Not correlated", with a
  clear label such as "Perfectly correlated" for +1. Handle inverse correlation
  and unavailable estimates explicitly. Keep the coefficient and its rank-based
  meaning available on demand; the label must not imply causation.

- [ ] **2. Make observation warnings explain themselves on click.**
  Badges such as "Limited observations" should open a concise explanation of
  the actual reason, including relevant counts, coverage, and thresholds.
  Support keyboard activation and dismissal.

- [ ] **3. Automatically hide fields that repeat elapsed time.**
  Elapsed-time aliases should never appear among the numeric field graphs,
  including after expanding the full field list. Exclude them from visible
  counts, ranking, and shared field-axis calculations.

- [ ] **4. Make recomputation visually obvious.**
  Clearly mark graphs as being recomputed, for example with a simple blur or
  dimming treatment and one loading indicator. Previously rendered results
  must not look current or remain misleadingly interactive while loading.
  Restore the normal presentation when the request completes; make failure
  and cancellation states clear.

- [ ] **5. Remove extra repetitions of the selected span name.**
  Preserve the requested two appearances across the page and remove additional
  copies. Audit the selected-span bar, detail headings, and lower analysis UI
  together when consolidating the layout.

- [ ] **6. Explain a dot's click action before it is clicked.**
  Hovering or focusing a dot should show its values and clearly say that
  clicking opens the corresponding trace focused on that span. The tooltip
  must be discoverable before navigation.

- [ ] **7. Share scales between graphs with identical units by default.**
  Graphs displaying the same unit should use the same value-axis limits.
  Normalize compatible time units to one displayed unit, so if one time-field
  graph needs a 12 ms maximum, all time-field graphs use that maximum.
  Preserve explicit unknown units rather than guessing a conversion.

- [ ] **8. Consolidate the new analysis UI and the existing lower UI.**
  Build one coherent selected-span investigation view. Combine overlapping
  graphs, summaries, composition displays, and controls while retaining useful
  functionality.

- [ ] **9. Integrate the analysis directly into the page layout.**
  Remove the unnecessary inset container and its wasted padding. Use the
  available width and height for graphs, with consistent page-level alignment
  and a usable mobile layout.

- [ ] **10. Rework "Higher in slow XX% of pairs".**
  **Required feedback checkpoint:** when this task is picked up, ask the user
  for feedback before implementing a replacement. Establish what comparison
  the user wants to understand, then choose wording or a visual they can
  interpret without a statistical explanation. Do not preselect a solution.

- [ ] **11. Make scatterplot density visible.**
  Distinguish dense regions from sparse ones, especially to the left of the
  slow cutoff. Derive density from the backend's loaded observations so the
  bounded dot sample does not misrepresent concentration. Give the density
  encoding a clear legend and preserve a way to inspect individual traces.

## Coordination

- Assign tasks 5, 8, and 9 together or agree on the page layout before parallel
  implementation; they affect the same structure.
- Complete task 3 before finalizing the shared scales in task 7.
- Task 10 requires user feedback when work starts, not during backlog creation.
- For implemented tasks, verify the visual result on actual data and check
  loading, custom selections, desktop/mobile layouts, and keyboard interaction
  where relevant.

## Additional UI feedback

- [ ] **12. Show only properties with meaningfully different latency distributions.**
  Filter categorical properties to those whose values have meaningful latency
  differences. Define the criterion before implementation, account for sample
  size, and compute the comparison in the backend.

- [ ] **13. Make overlay the default, with an optional stacked histogram view.**
  Default to overlaid distributions. Provide a control to switch to stacked
  histograms using the same rendering style, colors, bins, and comparable axes.

- [ ] **14. Rename "Categories" to "Properties" and add property filter buttons.**
  Use "Properties" in the visible UI. Provide buttons to filter/select the
  displayed properties, with clear active states.

- [ ] **15. Show numeric results directly below the property graphs.**
  Present numeric results below the categorical property results rather than
  hiding them behind a separate view. When there are no meaningful categorical
  properties, give the numeric results a clearly separated section.

- [ ] **16. Clarify "Mix shift" with human input.**
  **Required feedback checkpoint:** when this task is picked up, ask the user
  for input before implementing a replacement. Establish what the user needs
  to understand and whether the concept should remain, be renamed, or be
  presented differently.

- [ ] **17. Include raw counts in overlaid histogram readouts.**
  The overlay should display raw span counts for each series and latency bin,
  alongside any percentages. Clearly identify the corresponding value and bin.

- [ ] **18. Adapt the top histogram's behavior for multiple series.**
  Show a labeled, dashed p99 line for every series, including both series in a
  two-value overlay. Reuse the top histogram's axes, units, percentile marker
  conventions, readouts, and selection behavior for the multi-series view.
  Preserve the line rendering of distributions that works well for overlays.

Tasks 12–18 remain paused and unassigned. Coordinate tasks 13, 17, and 18
because they affect the same histogram component. Task 16 requires user
feedback when work starts.
