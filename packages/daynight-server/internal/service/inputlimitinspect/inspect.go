// Package inputlimitinspect applies the shared input policies to bounded,
// read-only inventory records. It never writes to the database or files.
package inputlimitinspect

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// StatFunc obtains an object's size without reading its contents.
type StatFunc func(context.Context, string, string) (int64, error)

// Finding contains only bounded resource identifiers and measurements, not source values.
type Finding struct {
	Kind               string            `json:"kind"`
	IDs                map[string]string `json:"ids"`
	Field              string            `json:"field"`
	Category           string            `json:"category"`
	Actual             int64             `json:"actual"`
	Max                int64             `json:"max"`
	Unit               string            `json:"unit,omitempty"`
	ActualIsLowerBound bool              `json:"actualIsLowerBound,omitempty"`
	Diagnostic         string            `json:"diagnostic,omitempty"`
	LocatorBytes       int64             `json:"locatorBytes,omitempty"`
}

// Outcome records visited resources and reasons a scan cannot clear.
type Outcome struct {
	Counts        map[string]int64 `json:"counts"`
	Findings      int64            `json:"findings"`
	Indeterminate int64            `json:"indeterminate"`
	Incomplete    bool             `json:"incomplete"`
}

type Inspector struct {
	ctx        context.Context
	stat       StatFunc
	onIdentity func(store.InputLimitsIdentity) error
	emit       func(Finding) error
	outcome    Outcome
	identity   bool
	observed   time.Time
	steps      stepGroup
}

func New(ctx context.Context, stat StatFunc, onIdentity func(store.InputLimitsIdentity) error, emit func(Finding) error) *Inspector {
	return &Inspector{ctx: ctx, stat: stat, onIdentity: onIdentity, emit: emit, outcome: Outcome{Counts: make(map[string]int64)}}
}

func (i *Inspector) Identity(identity store.InputLimitsIdentity) error {
	if i.identity || i.onIdentity == nil {
		return errors.New("inspection identity missing or repeated")
	}
	i.identity = true
	i.observed = identity.ObservedAt
	return i.onIdentity(identity)
}

func (i *Inspector) Outcome() Outcome { return i.outcome }

func (i *Inspector) finding(r store.InputLimitsRecord, field, category, diagnostic string, actual, max int64, unit string, lower bool) error {
	if i.emit == nil {
		return errors.New("inspection finding sink missing")
	}
	f := Finding{Kind: r.Kind, IDs: r.IDs, Field: field, Category: category, Diagnostic: diagnostic, Actual: actual, Max: max, Unit: unit, ActualIsLowerBound: lower}
	switch r.Kind {
	case "property":
		f.LocatorBytes = r.Fields["name"].Bytes
	case "attachment", "transfer":
		f.LocatorBytes = r.Fields["path"].Bytes
	case "archive":
		f.LocatorBytes = r.Fields["objectPath"].Bytes
	}
	if category == "violation" {
		i.outcome.Findings++
	} else {
		i.outcome.Indeterminate++
	}
	return i.emit(f)
}

func (i *Inspector) violation(r store.InputLimitsRecord, err error) error {
	if err == nil {
		return nil
	}
	var v *limit.Violation
	if errors.As(err, &v) {
		return i.finding(r, v.Field, "violation", "", v.Actual, v.Max, v.Unit, v.LowerBound)
	}
	return i.finding(r, "candidate", "indeterminate", "invalid stored representation", 0, 0, "", false)
}

func (i *Inspector) incomplete(r store.InputLimitsRecord, field, diagnostic string) error {
	i.outcome.Incomplete = true
	return i.finding(r, field, "indeterminate", diagnostic, 0, 0, "", false)
}

func (i *Inspector) textLimit(r store.InputLimitsRecord, name string, max int64, chars bool) error {
	f, ok := r.Fields[name]
	if !ok {
		return i.incomplete(r, name, "missing field metadata")
	}
	if !f.Present {
		return nil
	}
	actual, unit := f.Bytes, "bytes"
	if chars {
		actual, unit = f.Characters, "code points"
	}
	if actual > max {
		return i.finding(r, name, "violation", "", actual, max, unit, false)
	}
	return nil
}

func (i *Inspector) Finish() error {
	if !i.identity {
		i.outcome.Incomplete = true
		return errors.New("inspection identity missing")
	}
	return i.finishSteps()
}

func (i *Inspector) Record(r store.InputLimitsRecord) error {
	if err := i.ctx.Err(); err != nil {
		i.outcome.Incomplete = true
		return err
	}
	if !i.identity {
		i.outcome.Incomplete = true
		return errors.New("record before identity")
	}
	i.outcome.Counts[r.Kind]++
	switch r.Kind {
	case "task":
		return i.task(r)
	case "property":
		return i.property(r)
	case "step":
		return i.step(r)
	case "project":
		return i.project(r)
	case "team":
		return i.team(r)
	case "profile":
		return i.profile(r)
	case "worker":
		return i.worker(r)
	case "workerConfig":
		return i.workerConfig(r)
	case "attachment":
		return i.attachment(r)
	case "archive":
		return i.archive(r)
	case "transfer":
		return i.transfer(r)
	case "transferChunk":
		return i.transferChunk(r)
	case "login":
		return i.login(r)
	case "activeOwner":
		return i.activeOwner(r)
	default:
		return i.incomplete(r, "kind", fmt.Sprintf("unsupported resource kind %q", r.Kind))
	}
}
