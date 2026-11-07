package webhook

import (
	"fmt"
	"time"
)

// AutomaticSlot selects one elapsed opportunity, skipping older missed slots.
// Cursor counts already consumed or skipped opportunities; the one-based slot
// is persisted only when an attempt is admitted.
func AutomaticSlot(schedule []time.Time, cursor int16, now, expires time.Time) (int16, bool, error) {
	if err := validateAutomaticPlan(schedule, cursor, expires); err != nil {
		return 0, false, err
	}
	if !now.Before(expires) {
		return 0, false, nil
	}
	selected := int16(0)
	for i := int(cursor); i < len(schedule) && !schedule[i].After(now); i++ {
		selected = int16(i + 1)
	}
	return selected, selected != 0, nil
}

// NextAutomatic selects a future original opportunity and applies the minimum
// failure delay and receiver wait without moving the original deadline.
func NextAutomatic(schedule []time.Time, cursor, attempts int16, open bool, now, expires time.Time, wait *time.Time) (time.Time, int16, bool, error) {
	if err := validateAutomaticPlan(schedule, cursor, expires); err != nil {
		return time.Time{}, cursor, false, err
	}
	if attempts < 0 || attempts > 10 {
		return time.Time{}, cursor, false, fmt.Errorf("invalid automatic attempt count")
	}
	if !open || attempts == 10 || !now.Before(expires) {
		return time.Time{}, cursor, false, nil
	}
	for int(cursor) < len(schedule) && !schedule[cursor].After(now) {
		cursor++
	}
	if int(cursor) == len(schedule) {
		return time.Time{}, cursor, false, nil
	}
	next := schedule[cursor]
	if earliest := now.Add(5 * time.Second); next.Before(earliest) {
		next = earliest
	}
	if wait != nil && next.Before(*wait) {
		next = *wait
	}
	if !next.Before(expires) {
		return time.Time{}, cursor, false, nil
	}
	return next, cursor, true, nil
}

func validateAutomaticPlan(schedule []time.Time, cursor int16, expires time.Time) error {
	if len(schedule) != 10 || cursor < 0 || cursor > 10 || expires.IsZero() {
		return fmt.Errorf("invalid automatic plan")
	}
	for i, t := range schedule {
		if t.IsZero() || !t.Before(expires) || (i > 0 && !t.After(schedule[i-1])) {
			return fmt.Errorf("invalid automatic plan")
		}
	}
	return nil
}
