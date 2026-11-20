package runtime

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sc "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestRecoveryLifecycleRefusalPrecedesHostingAndGrant(t *testing.T) {
	for _, kind := range []string{"register", "takeover", "grant", "generation"} {
		t.Run(kind, func(t *testing.T) {
			f := newRecoveryFixture(t)
			f.executionError = &model.Fault{Code: "worker_disabled"}
			var err error
			switch kind {
			case "register":
				f.bot.Recovery = nil
				_, err = f.service.RegisterBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, sc.BotRecoveryRegistration{BotRecoveryIdentity: f.identity, BotRecoveryBinding: f.binding(), OperationID: uuid.NewString(), BotVersion: f.bot.Version})
			case "takeover":
				_, err = f.service.TakeoverBot(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, f.input())
			case "grant":
				input := f.input()
				input.Grant.Kind = "bootstrap"
				_, err = f.service.GrantBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
			case "generation":
				input := f.input()
				previous := input.Grant.ExecutionGeneration
				input.Grant.PreviousGeneration = &previous
				input.Grant.ExecutionGeneration = "2"
				input.Grant.StopProof = &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: input.Grant.ControllerInstanceID, StoppedAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)}
				input.Grant.ControllerInstanceID = uuid.NewString()
				_, err = f.service.GrantBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
			}
			if !errors.Is(err, f.executionError) || f.executionChecks != 1 || f.grant != nil || f.registered != 0 || f.advanced != 0 || f.saved != nil {
				t.Fatalf("gate bypass: %v %+v", err, f)
			}
		})
	}
}

func TestRecoveryProducerScopePrecedesLifecycleGate(t *testing.T) {
	for _, kind := range []string{"register", "takeover", "grant"} {
		for _, allowed := range []bool{false, true} {
			t.Run(kind+map[bool]string{false: "/scope-denied", true: "/worker-disabled"}[allowed], func(t *testing.T) {
				f := newRecoveryFixture(t)
				f.executionError = &model.Fault{Code: "worker_disabled", Message: "Worker is disabled."}
				checks := 0
				f.service.producer = func(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
					checks++
					if ctx != t.Context() || scope != f || p != f.p || f.executionChecks != 0 {
						t.Fatal("producer admission lost identity or ran after Worker lock")
					}
					if allowed {
						return producerPolicy(t, p, "session:produce"), nil
					}
					return producerPolicy(t, p, "session:read"), nil
				}
				var err error
				switch kind {
				case "register":
					f.bot.Recovery = nil
					_, err = f.service.RegisterBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, sc.BotRecoveryRegistration{BotRecoveryIdentity: f.identity, BotRecoveryBinding: f.binding(), OperationID: uuid.NewString(), BotVersion: f.bot.Version})
				case "takeover":
					_, err = f.service.TakeoverBot(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, f.input())
				case "grant":
					input := f.input()
					input.Grant.Kind = "bootstrap"
					_, err = f.service.GrantBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
				}
				expected := "insufficient_scope"
				gateChecks := 0
				if allowed {
					expected = "worker_disabled"
					gateChecks = 1
				}
				requireRuntimeFault(t, err, expected)
				if checks != 1 || f.executionChecks != gateChecks || f.grant != nil || f.registered != 0 || f.advanced != 0 || f.saved != nil {
					t.Fatalf("admission side effects: checks %d gate %d grant %+v registered %d advanced %d saved %+v", checks, f.executionChecks, f.grant, f.registered, f.advanced, f.saved)
				}
			})
		}
	}
}

func TestDisabledRecoveryRenewsOnlyTheCurrentExecution(t *testing.T) {
	for _, variant := range []string{"renew", "producer denied", "changed controller", "changed execution"} {
		t.Run(variant, func(t *testing.T) {
			f := newRecoveryFixture(t)
			f.executionError = &model.Fault{Code: "worker_disabled"}
			expired := time.Now().Add(-time.Minute)
			f.record.GrantExpiry = &expired
			checks := 0
			f.service.producer = func(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
				checks++
				if ctx != t.Context() || scope != f || p != f.p {
					t.Fatal("renewal changed producer authority")
				}
				if variant == "producer denied" {
					return producerPolicy(t, p, "session:read"), nil
				}
				return producerPolicy(t, p, "session:produce"), nil
			}
			input := f.input()
			if variant == "changed controller" {
				input.Grant.ControllerInstanceID = uuid.NewString()
			} else if variant == "changed execution" {
				input.Grant.ExecutionGeneration = "2"
			}
			out, err := f.service.GrantBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
			if checks != 1 || f.executionChecks != 0 || f.advanced != 0 || f.registered != 0 {
				t.Fatalf("renewal changed admission or hosting: checks=%d gate=%d advanced=%d registered=%d", checks, f.executionChecks, f.advanced, f.registered)
			}
			if variant == "renew" {
				if err != nil || !out.Current || f.grant == nil || !f.grant.ExpiresAt.After(time.Now()) || f.saved == nil || f.disconnected != 1 || f.credentials != 2 || out.Receipt.HostingGeneration != 1 || out.Receipt.ExecutionGeneration != "1" || out.Receipt.ControllerInstanceID != input.Grant.ControllerInstanceID {
					t.Fatalf("disabled renewal lost current authority: out=%+v err=%v stages=%v", out, err, f.stages)
				}
			} else {
				code := "session_conflict"
				if variant == "producer denied" {
					code = "insufficient_scope"
				}
				requireRuntimeFault(t, err, code)
				if f.grant != nil || f.saved != nil || f.disconnected != 0 || f.saves != 0 {
					t.Fatalf("invalid renewal wrote state: %v", f.stages)
				}
			}
		})
	}
}

func TestRecoveryTakeoverAdmitsDestinationBeforeAdvancingExecution(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		t.Run(map[bool]string{false: "destination disabled", true: "destination open"}[allowed], func(t *testing.T) {
			f := newRecoveryFixture(t)
			destination := uuid.NewString()
			disabled := &model.Fault{Code: "worker_disabled"}
			f.executionErrors = map[string]error{f.bot.WorkerID: disabled, destination: disabled}
			if allowed {
				f.executionErrors[destination] = nil
			}
			input := f.input()
			previous := input.Grant.ExecutionGeneration
			input.Grant.PreviousGeneration = &previous
			input.Grant.ExecutionGeneration = "2"
			input.Grant.StopProof = &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: input.Grant.ControllerInstanceID, StoppedAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)}
			input.Grant.ControllerInstanceID = uuid.NewString()
			f.expectedStopProof = input.Grant.StopProof
			out, err := f.service.TakeoverBot(t.Context(), f.p, destination, f.bot.ID, input)
			if !allowed {
				requireRuntimeFault(t, err, "worker_disabled")
				if !reflect.DeepEqual(f.executionWorkers, []string{destination}) || f.grant != nil || f.advanced != 0 || f.saved != nil || f.saves != 0 {
					t.Fatalf("disabled destination changed execution: workers=%v stages=%v", f.executionWorkers, f.stages)
				}
				return
			}
			if err != nil || !out.Current || out.Receipt.WorkerID != destination || out.Receipt.HostingGeneration != 2 || out.Receipt.ExecutionGeneration != "2" || out.Receipt.ControllerInstanceID != input.Grant.ControllerInstanceID || f.grant == nil || f.saved == nil || f.advanced != 1 || f.disconnected != 1 || !reflect.DeepEqual(f.executionWorkers, []string{destination, destination}) {
				t.Fatalf("takeover used old host or lost generation: out=%+v err=%v workers=%v stages=%v", out, err, f.executionWorkers, f.stages)
			}
		})
	}
}
