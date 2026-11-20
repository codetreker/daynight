package runtime

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sc "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"testing"
)

func TestRecoveryLifecycleRefusalPrecedesHostingAndGrant(t *testing.T) {
	for _, kind := range []string{"register", "takeover", "grant"} {
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
				_, err = f.service.GrantBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, f.input())
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
					_, err = f.service.GrantBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, f.input())
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
