package webhook

import (
	"testing"
	"time"
)

func TestAutomaticPlanMissedAndFutureOpportunities(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	offsets := []time.Duration{0, time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour, 12 * time.Hour, 24 * time.Hour, 48 * time.Hour, 71 * time.Hour}
	schedule := make([]time.Time, len(offsets))
	for i, offset := range offsets {
		schedule[i] = start.Add(offset)
	}
	expires := start.Add(72 * time.Hour)
	now := start.Add(7 * time.Hour)
	slot, ok, err := AutomaticSlot(schedule, 0, now, expires)
	if err != nil || !ok || slot != 6 {
		t.Fatalf("slot=%d ok=%v err=%v", slot, ok, err)
	}
	next, cursor, ok, err := NextAutomatic(schedule, slot, 1, true, now, expires, nil)
	if err != nil || !ok || cursor != 6 || !next.Equal(schedule[6]) {
		t.Fatalf("next=%v cursor=%d ok=%v err=%v", next, cursor, ok, err)
	}
	wait := expires.Add(time.Second)
	_, _, ok, err = NextAutomatic(schedule, slot, 1, true, now, expires, &wait)
	if err != nil || ok {
		t.Fatalf("wait past expiry ok=%v err=%v", ok, err)
	}
	_, _, ok, err = NextAutomatic(schedule, slot, 10, true, now, expires, nil)
	if err != nil || ok {
		t.Fatalf("exhaustion ok=%v err=%v", ok, err)
	}
	if _, ok, err = AutomaticSlot(schedule, 0, expires, expires); err != nil || ok {
		t.Fatalf("expired ok=%v err=%v", ok, err)
	}
}

func TestAutomaticPlanBounds(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	schedule := make([]time.Time, 10)
	for i := range schedule {
		schedule[i] = start.Add(time.Duration(i) * time.Minute)
	}
	expires := start.Add(72 * time.Hour)
	if _, _, err := AutomaticSlot(schedule[:9], 0, start, expires); err == nil {
		t.Fatal("short plan accepted")
	}
	if _, _, err := AutomaticSlot(schedule, -1, start, expires); err == nil {
		t.Fatal("negative cursor accepted")
	}
	now := start.Add(time.Minute - time.Second)
	next, _, ok, err := NextAutomatic(schedule, 1, 1, true, now, expires, nil)
	if err != nil || !ok || !next.Equal(now.Add(5*time.Second)) {
		t.Fatalf("failure floor: %v %v %v", next, ok, err)
	}
	schedule[4] = schedule[3]
	if _, _, err := AutomaticSlot(schedule, 0, start, expires); err == nil {
		t.Fatal("non-increasing plan accepted")
	}
}

func TestNextAutomaticRejectsCorruptPlanAndSkipsMissedSlots(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	schedule := make([]time.Time, 10)
	for i := range schedule {
		schedule[i] = start.Add(time.Duration(i) * time.Minute)
	}
	expires := start.Add(72 * time.Hour)
	if _, _, _, err := NextAutomatic(schedule[:9], 0, 0, true, start, expires, nil); err == nil {
		t.Fatal("short plan accepted")
	}
	if _, _, _, err := NextAutomatic(schedule, 0, 11, true, start, expires, nil); err == nil {
		t.Fatal("invalid attempt count accepted")
	}
	next, cursor, ok, err := NextAutomatic(schedule, 1, 1, true, start.Add(5*time.Minute), expires, nil)
	if err != nil || !ok || cursor != 6 || !next.Equal(schedule[6]) {
		t.Fatalf("missed slots: %v %d %v %v", next, cursor, ok, err)
	}
	if _, cursor, ok, err = NextAutomatic(schedule, 1, 1, true, start.Add(11*time.Minute), expires, nil); err != nil || ok || cursor != 10 {
		t.Fatalf("all slots missed: %d %v %v", cursor, ok, err)
	}
}
