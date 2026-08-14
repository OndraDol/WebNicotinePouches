# Recorded-day streak design

## Goal

Prevent inactive calendar days from creating an artificial streak. A streak represents consecutive recorded days on which pouch use stayed within the applicable daily limit.

## Behavior

- A calendar day counts only when it contains at least one valid history entry and its entry count does not exceed that day's dynamic limit.
- If today contains at least one entry and remains within today's limit, today is included immediately.
- If today has no entries yet, the calculation may begin with yesterday so an active streak is not removed before the user has had a chance to record today.
- If neither today nor yesterday contains an entry, the current streak is zero.
- Any earlier day with no entries ends the streak.
- Any day whose entry count exceeds that day's dynamic limit ends the streak.
- An empty history produces a streak of zero.

The result continues to drive the dashboard streak, streak badges, and streak milestone notifications through the existing statistics object.

## Implementation boundary

Move the calendar-day traversal into a small pure function that accepts recorded counts by local date, the current local date, and a way to obtain the applicable limit for a date. `calculateStats()` remains responsible for building day counts and supplying the dynamic-limit calculation.

The function uses local calendar dates rather than elapsed 24-hour durations, preserving the application's existing timezone behavior across daylight-saving changes.

## Testing

Add focused automated tests for:

- an old isolated record followed by months without records returns zero;
- consecutive recorded days within their limits are counted;
- a valid entry today is included immediately;
- no entry today preserves a streak ending yesterday;
- missing both today and yesterday returns zero;
- an empty day inside a sequence breaks the streak;
- a recorded day above its dynamic limit breaks the streak;
- empty history returns zero.

Run the focused regression tests first, then the repository's existing automated tests. No unrelated streak semantics, badge thresholds, copy, or visual layout will change.
