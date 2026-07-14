# Spec: Resolve / Archive Button Hierarchy

## Context

The Resolve and Archive buttons on the incident detail page should have clear visual hierarchy. Resolve is the primary action (positive completion); Archive is secondary/neutral.

## URL

http://localhost:5173 — navigate to any incident detail page (e.g. `/incidents/<id>`)

## Acceptance Criteria

### AC1: Resolve button has solid green fill
<!-- clarified: browser agent should navigate the incidents list to find an active/needs_human incident, or create test data if none exists -->
When an incident is in a non-resolved, non-archived state, the Resolve button must have a solid green background (not ghost/outline only). The text must be dark (not green) to contrast against the green fill.

### AC2: Resolve button is visually dominant over Archive
<!-- clarified: same page as AC1 — agent finds an active incident via list navigation -->
On the same incident detail page, the Resolve button must be more visually prominent than the Archive button — filled vs outlined/surface.

### AC3: Archive button reads as secondary
<!-- clarified: same page as AC1 — agent inspects computed styles on the Archive button -->
The Archive button must have a visible background (surface-2) and border, with primary text color — clearly a button, but clearly less prominent than Resolve.

### AC4: Unarchive button has solid indigo fill
<!-- clarified: agent should find an archived incident from the list (filter by archived status), or archive one first if none exist -->
When an incident is in `archived` state, the Unarchive button must have a solid indigo background with dark text, similar treatment to Resolve.

### AC5: Both buttons show 50% opacity when disabled
<!-- clarified: simulate slow network via CDP Network.emulateNetworkConditions (offline or slow-3g) before clicking Resolve/Archive, screenshot mid-flight, then restore network -->
While an action is loading (`actionLoading` is true), both the Resolve and Archive buttons must appear at reduced opacity (disabled state).

### AC6: Resolve button is absent when incident is resolved or archived
<!-- clarified: agent navigates to a resolved incident from the list (filter resolved), or resolves one first by clicking Resolve on an active incident -->
When incident status is `resolved` or `archived`, the Resolve button must not be rendered in the DOM.

### AC7: Archive button is absent when incident is archived
<!-- clarified: same archived incident as AC4 — agent verifies Archive button is absent from DOM -->
When incident status is `archived`, the Archive button must not be rendered — only Unarchive should appear.
