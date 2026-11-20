package runtime

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sc "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
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
