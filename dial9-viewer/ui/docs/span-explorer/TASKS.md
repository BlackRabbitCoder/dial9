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
