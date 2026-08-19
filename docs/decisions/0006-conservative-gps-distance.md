# 6. Conservative GPS distance

**Status:** Accepted

## Context

Distance is computed from GPS points that contain noise: a stationary phone drifts several metres,
accuracy varies, and coverage holes produce jumps.

Distance feeds fuel estimates, cost-per-km reporting, and in some organizations driver pay.

## Decision

Filter aggressively and under-report rather than over-report.

- Points less accurate than 100 m are dropped.
- Segments under 10 m are dropped (stationary jitter).
- Segments implying more than 60 m/s are dropped.
- Gaps over 5 minutes are **not** bridged.

## Rationale

The two failure modes are not symmetric. Under-reporting is a small, uniform bias that a fleet
manager can calibrate against. Over-reporting invents distance that never happened — and if it
feeds pay, it is a number nobody can defend when questioned.

Refusing to bridge a gap is the same principle: a straight line across 19 minutes of missing data
is a fabrication. The gap is reported as `untrackedSeconds` instead.

## Consequences

- Genuine short movements below 10 m are lost. Immaterial at fleet scale.
- Distance is slightly below odometer readings. Documented so it is not read as a bug.
- A test asserts 60 stationary jittery points integrate to exactly 0 — the behaviour is pinned.
- Route rendering must handle discontinuities; `reconstruct()` returns `gapAfterIndices`.
