package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mediaRateDAO struct {
	store.SessionDAO
	t                    *testing.T
	ctx                  context.Context
	now                  time.Time
	calls                []string
	deny, corrupt        string
	lockError, saveError error
}

func (d *mediaRateDAO) LockSessionMediaRate(ctx context.Context, owner, kind string, initial store.SessionMediaRate) (store.SessionMediaRate, error) {
	d.t.Helper()
	capacity := int64(40_000_000)
	if kind == "prepare" {
		capacity = 8_000_000
	}
	if ctx != d.ctx || owner != "actor" || initial.Tokens != capacity || !initial.UpdatedAt.Equal(d.now) {
		d.t.Fatal("rate storage input changed", owner, kind, initial)
	}
	d.calls = append(d.calls, "lock/"+kind)
	if kind == d.deny {
		initial.Tokens = 0
	}
	if kind == d.corrupt {
		initial.Tokens = -1
	}
	return initial, d.lockError
}
func (d *mediaRateDAO) SaveSessionMediaRate(ctx context.Context, owner, kind string, next store.SessionMediaRate) error {
	d.t.Helper()
	capacity := int64(40_000_000)
	if kind == "prepare" {
		capacity = 8_000_000
	}
	if ctx != d.ctx || owner != "actor" || next.Tokens != capacity-1_000_000 || !next.UpdatedAt.Equal(d.now) {
		d.t.Fatal("rate decision changed before storage", owner, kind, next)
	}
	d.calls = append(d.calls, "save/"+kind)
	return d.saveError
}

func TestImageRateSeparatesPrepareAndObservation(t *testing.T) {
	for _, kind := range []string{"prepare", "control", "observe", "release"} {
		t.Run(kind, func(t *testing.T) {
			s := &Execution{Engine: NewEngine(nil)}
			now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
			s.now = func() time.Time { return now }
			d := &mediaRateDAO{t: t, ctx: t.Context(), now: now}
			if e := s.admitImageRate(t.Context(), &operationTx{dao: d}, "actor", kind); e != nil {
				t.Fatal(e)
			}
			want := []string{"lock/" + kind, "save/" + kind}
			if kind == "prepare" {
				want = []string{"lock/control", "save/control", "lock/prepare", "save/prepare"}
			}
			if !reflect.DeepEqual(d.calls, want) {
				t.Fatal(d.calls, want)
			}
		})
	}
}

func TestImageRateStopsAfterRefusalCorruptionOrUnknownStorage(t *testing.T) {
	for _, point := range []string{"control denied", "prepare denied", "corrupt", "lock failed", "save unknown", "invalid policy", "invalid clock"} {
		t.Run(point, func(t *testing.T) {
			s := &Execution{Engine: NewEngine(nil)}
			now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
			s.now = func() time.Time { return now }
			d := &mediaRateDAO{t: t, ctx: t.Context(), now: now}
			cause := &store.TransactionError{Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("commit confirmation lost")}
			category := "prepare"
			switch point {
			case "control denied":
				d.deny = "control"
			case "prepare denied":
				d.deny = "prepare"
			case "corrupt":
				d.corrupt = "control"
			case "lock failed":
				d.lockError = cause
			case "save unknown":
				d.saveError = cause
			case "invalid policy":
				category = "invalid"
			case "invalid clock":
				s.now = func() time.Time { return time.Time{} }
			}
			err := s.admitImageRate(t.Context(), &operationTx{dao: d}, "actor", category)
			if err == nil {
				t.Fatal("unsafe rate admission succeeded")
			}
			if (d.lockError != nil || d.saveError != nil) && !errors.Is(err, cause) {
				t.Fatal("storage cause lost", err)
			}
			want := []string{"lock/control"}
			if point == "save unknown" {
				want = append(want, "save/control")
			}
			if point == "prepare denied" {
				want = []string{"lock/control", "save/control", "lock/prepare"}
			}
			if point == "invalid policy" || point == "invalid clock" {
				want = nil
			}
			if !reflect.DeepEqual(d.calls, want) {
				t.Fatal("continued or retried unsafe rate decision", d.calls, want)
			}
		})
	}
	s := &Execution{Engine: NewEngine(nil)}
	if s.admitImageRate(t.Context(), &operationTx{dao: &mediaRateMissingDAO{}}, "actor", "control") == nil {
		t.Fatal("old adapter enabled media")
	}
}

type mediaRateMissingDAO struct{ store.SessionDAO }
