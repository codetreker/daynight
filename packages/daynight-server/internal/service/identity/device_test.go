package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestDeviceRateAndCollisionAttempts(t *testing.T) {
	cause := errors.New("driver detail")
	collision := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{DatabaseFailure: true, SQLState: "23505", Cause: cause}}
	for _, scenario := range []string{"success", "rate", "retry success", "exhaustion", "unknown collision", "cleanup collision", "other database", "operation"} {
		t.Run(scenario, func(t *testing.T) {
			f := newIdentityFixture(t)
			s := f.identity
			client, source := "raw-client", "raw-source"
			refusal := &model.Fault{Code: "rate_limited"}
			want := core.DeviceStart{DeviceCode: "opaque-code", UserCode: "BCDFG-HJKLM", ExpiresAt: f.now.Add(10 * time.Minute)}
			f.plan = []string{"validate", "write", "rate", "finish"}
			f.transaction()
			s.ops.validateDeviceClient = func(c string) error { f.hit("validate"); f.equal(c, client); return nil }
			s.ops.deviceRate = func(ctx context.Context, dao store.IdentityDAO, op, actor string, global, perActor int, now time.Time) error {
				f.hit("rate")
				f.bound(ctx, dao)
				f.equal([]any{op, actor, global, perActor, now}, []any{"device-create", source, 120, 30, f.now})
				if scenario == "rate" {
					return refusal
				}
				return nil
			}
			attempts := 1
			if scenario == "retry success" || scenario == "exhaustion" {
				attempts = 3
			}
			if scenario != "rate" {
				for range attempts {
					f.plan = append(f.plan, "write", "start", "finish")
					f.transaction()
				}
			}
			attemptErrors := make([]error, attempts)
			for i := range attempts {
				switch scenario {
				case "retry success":
					if i < 2 {
						attemptErrors[i] = collision
					}
				case "exhaustion":
					attemptErrors[i] = collision
				case "unknown collision":
					attemptErrors[i] = &store.TransactionError{Phase: "operation", Outcome: store.TransactionUnknown, Cause: collision}
				case "cleanup collision":
					attemptErrors[i] = &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: collision}
				case "other database":
					attemptErrors[i] = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{DatabaseFailure: true, SQLState: "08006", Cause: cause}}
				case "operation":
					attemptErrors[i] = cause
				}
			}
			calls := 0
			s.ops.startDevice = func(ctx context.Context, dao store.IdentityDAO, c string, now time.Time) (core.DeviceStart, error) {
				f.hit("start")
				f.bound(ctx, dao)
				f.equal([]any{c, now}, []any{client, f.now})
				err := attemptErrors[calls]
				calls++
				return want, err
			}
			for i := 1; i < len(f.transactions); i++ {
				f.transactions[i].callbackErr = attemptErrors[i-1]
				f.transactions[i].err = attemptErrors[i-1]
			}
			got, err := s.StartDevice(f.ctx, client, source)
			if scenario == "success" || scenario == "retry success" {
				if err != nil {
					t.Fatal(err)
				}
				f.equal(got, want)
			} else {
				f.equal(got, core.DeviceStart{})
				if err == nil {
					t.Fatal("failed device start succeeded")
				}
				if scenario == "rate" && err != refusal {
					t.Fatal("rate refusal changed")
				}
			}
		})
	}
}

func TestDeviceBrowserStagesAndPostTransactionClock(t *testing.T) {
	for _, operation := range []string{"inspect", "decide"} {
		for _, stage := range []string{"success", "browser", "rate", "admission", "lower", "completion"} {
			t.Run(operation+"/"+stage, func(t *testing.T) {
				f := newIdentityFixture(t)
				s := f.identity
				p := model.Principal{Kind: model.SessionCredential, UserID: "current-user", CredentialID: "session"}
				raw := " bcdfg\t-hjklm "
				failure := &model.Fault{Code: "forbidden"}
				f.plan = []string{"browser"}
				s.ops.validateDeviceBrowser = func(got model.Principal) error {
					f.hit("browser")
					f.equal(got, p)
					if stage == "browser" {
						return failure
					}
					return nil
				}
				if stage != "browser" {
					f.plan = append(f.plan, "write", "rate", "finish")
					f.transaction()
				}
				s.ops.deviceRate = func(ctx context.Context, dao store.IdentityDAO, op, actor string, global, perActor int, now time.Time) error {
					f.hit("rate")
					f.bound(ctx, dao)
					f.equal([]any{op, actor, global, perActor, now}, []any{"device-lookup", p.UserID, 120, 12, f.now})
					if stage == "rate" {
						return failure
					}
					return nil
				}
				if stage != "browser" && stage != "rate" {
					if operation == "decide" {
						f.plan = append(f.plan, "admission")
					}
					if stage != "admission" {
						f.plan = append(f.plan, "write", operation, "finish")
						f.transaction()
						if stage == "completion" {
							f.transactions[1].err = context.Canceled
						}
					}
					if stage == "success" && operation == "inspect" {
						f.plan = append(f.plan, "render")
					}
				}
				s.ops.validateDeviceDecision = func(principal model.Principal, code, decision, user string) (string, string, error) {
					f.hit("admission")
					f.equal([]any{principal, code, decision, user}, []any{p, raw, "approve", p.UserID})
					if stage == "admission" {
						return "", "", failure
					}
					return "normalized", "approved", nil
				}
				loaded := model.DeviceAuthorization{ID: "device", UserCode: "BCDFGHJKLM", Status: "pending", CreatedAt: f.now, ExpiresAt: f.now.Add(time.Second), NextPollAt: f.now, PollIntervalSeconds: 5}
				want := core.DeviceInspection{UserCode: "BCDFG-HJKLM", ExpiresAt: loaded.ExpiresAt, Status: "expired"}
				s.ops.inspectDevice = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal, code string, now time.Time) (model.DeviceAuthorization, error) {
					f.hit("inspect")
					f.bound(ctx, dao)
					f.equal([]any{principal, code, now}, []any{p, raw, f.now})
					if stage == "lower" {
						return loaded, failure
					}
					f.now = loaded.ExpiresAt
					return loaded, nil
				}
				s.ops.deviceInspection = func(got model.DeviceAuthorization, now time.Time) core.DeviceInspection {
					f.hit("render")
					f.equal(got, loaded)
					f.equal(now, loaded.ExpiresAt)
					return want
				}
				s.ops.decideDevice = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal, code, decision, user string, now time.Time) error {
					f.hit("decide")
					f.bound(ctx, dao)
					f.equal([]any{principal, code, decision, user, now}, []any{p, raw, "approve", p.UserID, f.now})
					if stage == "lower" {
						return failure
					}
					return nil
				}
				var err error
				if operation == "inspect" {
					if stage == "admission" {
						raw = "bad"
					}
					got, e := s.InspectDevice(f.ctx, p, raw)
					err = e
					if stage == "success" {
						f.equal(got, want)
					} else {
						f.equal(got, core.DeviceInspection{})
					}
				} else {
					err = s.DecideDevice(f.ctx, p, raw, "approve", p.UserID)
				}
				if stage == "success" {
					if err != nil {
						t.Fatal(err)
					}
				} else if err == nil {
					t.Fatal("failed stage succeeded")
				}
				if stage == "completion" && !errors.Is(err, context.Canceled) {
					t.Fatalf("completion cause=%v", err)
				}
			})
		}
	}
}
