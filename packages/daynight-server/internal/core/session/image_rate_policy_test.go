package session

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestImageRateRefillHonorsExactBoundaryAndClockRollback(t *testing.T) {
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name      string
		tokens    int64
		advance   time.Duration
		allowed   bool
		remaining int64
	}{
		{"last token", 1_000_000, 0, true, 0},
		{"empty", 0, 0, false, 0},
		{"before refill", 0, 499999 * time.Microsecond, false, 999998},
		{"exact refill", 0, 500000 * time.Microsecond, true, 0},
		{"fraction retained", 9, 500000 * time.Microsecond, true, 9},
		{"rollback", 0, -time.Hour, false, 0},
		{"submicrosecond rollback", 0, -time.Nanosecond, false, 0},
		{"full bucket cap", 8_000_000, time.Second, true, 7_000_000},
		{"large forward jump", 0, 20 * 365 * 24 * time.Hour, true, 7_000_000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previous := store.SessionMediaRate{Tokens: tc.tokens, UpdatedAt: now}
			next, allowed, err := replenishImageRate(previous, now.Add(tc.advance), 2, 8)
			if err != nil || allowed != tc.allowed || next.Tokens != tc.remaining {
				t.Fatal(next, allowed, err)
			}
			wantTime := now.Add(tc.advance)
			if wantTime.Before(now) {
				wantTime = now
			}
			if !next.UpdatedAt.Equal(wantTime) {
				t.Fatal("rate accounting clock regressed", next.UpdatedAt, wantTime)
			}
		})
	}
}

func TestImageRateRejectsInvalidPolicyAndCorruptPersistence(t *testing.T) {
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	valid := store.SessionMediaRate{Tokens: 1_000_000, UpdatedAt: now}
	for _, tc := range []struct {
		name        string
		previous    store.SessionMediaRate
		now         time.Time
		rate, burst int
		code        string
	}{
		{"zero rate", valid, now, 0, 8, "invalid_input"},
		{"excess rate", valid, now, 21, 8, "invalid_input"},
		{"zero burst", valid, now, 2, 0, "invalid_input"},
		{"excess burst", valid, now, 2, 41, "invalid_input"},
		{"zero decision clock", valid, time.Time{}, 2, 8, "invalid_input"},
		{"negative tokens", store.SessionMediaRate{Tokens: -1, UpdatedAt: now}, now, 2, 8, "source_corrupt"},
		{"above bucket cap", store.SessionMediaRate{Tokens: 8_000_001, UpdatedAt: now}, now, 2, 8, "source_corrupt"},
		{"zero stored clock", store.SessionMediaRate{Tokens: 1_000_000}, now, 2, 8, "source_corrupt"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			next, allowed, err := replenishImageRate(tc.previous, tc.now, tc.rate, tc.burst)
			var f *model.Fault
			if !errors.As(err, &f) || f.Code != tc.code || allowed || next != (store.SessionMediaRate{}) {
				t.Fatal("invalid rate facts were normalized", next, allowed, err)
			}
		})
	}
}
