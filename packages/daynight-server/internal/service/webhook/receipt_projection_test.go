package webhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestOperationReadRetainsRotationResultWithoutCurrentKey(t *testing.T) {
	f := newMgmtFixture(t)
	m := f.mutation("signing.rotate")
	m.Mode = "overlap"
	until := f.now.Add(24 * time.Hour)
	original := f.respondMutation(m, f.endpoint, "applied", []wm.SigningKey{{ID: f.key.ID, Slot: "overlap", OverlapUntil: &until}})
	original.ActiveKeyID = "77777777-7777-4777-8777-777777777777"
	original.OverlapUntil = &until
	f.preDAO.OperationFn = func(_ context.Context, o wm.Owner, id string) (wm.Operation, error) {
		if o != original.Owner || id != original.ID {
			t.Errorf("receipt identity=%v %s", o, id)
		}
		return original, nil
	}
	f.preDAO.EndpointFn = nil
	f.preDAO.SigningKeysFn = nil
	f.db.WriteFn = nil
	value, err := f.service.Operation(f.ctx, f.principal, f.owner, original.ID)
	if err != nil {
		t.Fatal(err)
	}
	receipt := value.(map[string]any)
	if receipt["keyId"] != original.ActiveKeyID || receipt["overlapUntil"] == nil || !receipt["overlapUntil"].(*time.Time).Equal(until) {
		t.Fatalf("GET lost original rotation result after key removal: %#v", receipt)
	}
	if mgmtCallNameCount(f.trace.snapshot(), "pre.dao.Endpoint") != 0 || mgmtCallNameCount(f.trace.snapshot(), "pre.dao.SigningKeys") != 0 {
		t.Fatal("receipt result depended on current endpoint or key")
	}
}

func TestOperationReadLogicalExpiryBeforeCollection(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		offset time.Duration
	}{{"before deadline", time.Nanosecond}, {"at deadline", 0}, {"after deadline", -time.Nanosecond}} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newMgmtFixture(t)
			m := f.mutation("endpoint.update")
			op := f.respondMutation(m, f.endpoint, "unchanged", []wm.SigningKey{f.key})
			op.ExpiresAt = f.now.Add(scenario.offset)
			op.RecordedAt = op.ExpiresAt.Add(-30 * 24 * time.Hour)
			f.preDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
			f.db.WriteFn = nil
			got, err := f.service.Operation(f.ctx, f.principal, f.owner, op.ID)
			if scenario.offset > 0 {
				if err != nil || got.(map[string]any)["operationId"] != op.ID {
					t.Fatalf("live receipt=%#v %v", got, err)
				}
			} else {
				mgmtWantFault(t, err, "not_found")
				if got != nil {
					t.Fatalf("expired receipt returned body=%#v", got)
				}
			}
			if mgmtCallNameCount(f.trace.snapshot(), "pre.dao.Operation") != 1 {
				t.Fatal("logical deadline bypassed retained-row lookup")
			}
		})
	}
	cause := errors.New("receipt observation failed")
	f := newMgmtFixture(t)
	m := f.mutation("endpoint.update")
	op := f.respondMutation(m, f.endpoint, "unchanged", []wm.SigningKey{f.key})
	f.preDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
	f.pre.ObservedAtFn = func(context.Context) (time.Time, error) { return time.Time{}, cause }
	if _, err := f.service.Operation(f.ctx, f.principal, f.owner, op.ID); !errors.Is(err, cause) {
		t.Fatalf("receipt clock error was hidden: %v", err)
	}
}

func TestOperationReplayDeadlineAndConflictBeforeCollection(t *testing.T) {
	for _, kind := range []string{"management", "redelivery"} {
		for _, scenario := range []string{"live old intent", "expired same intent", "expired conflicting intent", "expiry after fence", "clock failure"} {
			t.Run(kind+"/"+scenario, func(t *testing.T) {
				f := newMgmtFixture(t)
				var call func() (Result, error)
				var op wm.Operation
				recorded := f.now.Add(-29 * 24 * time.Hour)
				if kind == "management" {
					m := f.mutation("endpoint.update")
					m.Name = mgmtPtr("recorded change")
					m.IssuedAt = recorded.Format(time.RFC3339Nano)
					current := f.endpoint
					current.ConfigVersion = 3
					op = f.respondMutation(m, current, "applied", []wm.SigningKey{f.key})
					op.ConfigVersion = 2
					if scenario == "expired conflicting intent" {
						m.Name = mgmtPtr("conflicting change")
					}
					call = func() (Result, error) { return f.service.Mutate(f.ctx, f.principal, f.owner, m) }
				} else {
					r := newMgmtRedeliveryFixture(t)
					f = r.mgmtFixture
					m := r.intent()
					m.IssuedAt = recorded.Format(time.RFC3339Nano)
					current := r.expectedDelivery(m)
					op = r.respond(m, current)
					current.Generation = 3
					r.postDAO.HistoryDeliveryFn = func(context.Context, wm.Owner, string, string) (store.WebhookDelivery, error) { return current, nil }
					if scenario == "expired conflicting intent" {
						m.IfGeneration = 2
					}
					call = func() (Result, error) { return r.call(m) }
				}
				op.RecordedAt = recorded
				op.ExpiresAt = f.now.Add(time.Hour)
				if scenario == "expired same intent" || scenario == "expired conflicting intent" {
					op.ExpiresAt = f.now
					op.RecordedAt = op.ExpiresAt.Add(-30 * 24 * time.Hour)
				}
				f.writer.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
				f.postDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
				cause := errors.New("receipt clock unavailable")
				if scenario == "expiry after fence" {
					op.ExpiresAt = f.now.Add(time.Second)
					base := f.db.WriteFn
					f.db.WriteFn = func(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
						completion, err := base(ctx, o, id, fn)
						if err == nil {
							f.post.ObservedAtFn = func(context.Context) (time.Time, error) { return op.ExpiresAt, nil }
						}
						return completion, err
					}
				} else if scenario == "clock failure" {
					f.post.ObservedAtFn = func(context.Context) (time.Time, error) { return time.Time{}, cause }
				}
				f.recordWrites()
				got, err := call()
				switch scenario {
				case "live old intent":
					if err != nil || !got.Replay || got.Body == nil {
						t.Fatalf("retained live replay failed despite stale admission versions: %#v %v", got, err)
					}
				case "expired same intent", "expiry after fence":
					mgmtWantFault(t, err, "operation_expired")
					if got.Body != nil {
						t.Fatalf("expired replay exposed body=%#v", got)
					}
				case "expired conflicting intent":
					mgmtWantFault(t, err, "operation_conflict")
				case "clock failure":
					if !errors.Is(err, cause) {
						t.Fatalf("clock error was hidden: %v", err)
					}
				}
				f.noEffects()
				if mgmtCallNameCount(f.trace.snapshot(), "write.dao.Policy") != 0 {
					t.Fatal("existing operation reentered new intent admission")
				}
			})
		}
	}
}
