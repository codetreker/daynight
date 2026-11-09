package session

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"reflect"
	"testing"
	"time"
)

type mediaRateDAO struct {
	store.SessionDAO
	calls []string
	deny  string
	err   error
}

func (d *mediaRateDAO) TakeSessionMediaRate(_ context.Context, owner, kind string, _ time.Time, rate, burst int) (bool, error) {
	d.calls = append(d.calls, kind)
	if owner != "actor" || kind == "prepare" && (rate != 2 || burst != 8) || kind != "prepare" && (rate != 20 || burst != 40) {
		panic("wrong rate policy")
	}
	return kind != d.deny, d.err
}
func TestImageRateSeparatesPrepareAndObservation(t *testing.T) {
	s := &Execution{Engine: NewEngine(nil)}
	d := &mediaRateDAO{}
	tx := &operationTx{dao: d}
	if e := s.admitImageRate(t.Context(), tx, "actor", "prepare"); e != nil || !reflect.DeepEqual(d.calls, []string{"control", "prepare"}) {
		t.Fatal(d.calls, e)
	}
	d.deny = "prepare"
	if e := s.admitImageRate(t.Context(), tx, "actor", "prepare"); e == nil {
		t.Fatal("exhausted prepare accepted")
	}
	for _, kind := range []string{"observe", "release", "control"} {
		if e := s.admitImageRate(t.Context(), tx, "actor", kind); e != nil {
			t.Fatal(e)
		}
	}
	d.err = errors.New("database unavailable")
	if !errors.Is(s.admitImageRate(t.Context(), tx, "actor", "observe"), d.err) {
		t.Fatal("database failure hidden")
	}
	d.err = nil
	if s.admitImageRate(t.Context(), tx, "actor", "invalid") == nil {
		t.Fatal("unknown policy accepted")
	}
	tx.dao = &mediaRateMissingDAO{}
	if s.admitImageRate(t.Context(), tx, "actor", "control") == nil {
		t.Fatal("old adapter enabled media")
	}
}

type mediaRateMissingDAO struct{ store.SessionDAO }
