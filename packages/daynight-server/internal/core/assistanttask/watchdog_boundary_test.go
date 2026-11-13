package assistanttask_test

import (
	"context"
	"encoding/json"
	"errors"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask/watchdog"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"testing"
	"time"
)

const boundaryOwner = "11111111-1111-4111-8111-111111111111"
const boundaryTask = "22222222-2222-4222-8222-222222222222"
const boundaryBot = "33333333-3333-4333-8333-333333333333"
const boundaryEntry = "44444444-4444-4444-8444-444444444444"
const boundaryToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

type boundaryDAO struct {
	store.AssistantTaskDAO
	now      time.Time
	proposal bool
	rules    json.RawMessage
}

func (d boundaryDAO) Credential(context.Context, model.Principal) error { return nil }
func (d boundaryDAO) Bot(context.Context, string) (model.Bot, error) {
	return model.Bot{ID: boundaryBot, OwnerUserID: boundaryOwner}, nil
}
func (d boundaryDAO) Now(context.Context) (time.Time, error) { return d.now, nil }
func (d boundaryDAO) Task(context.Context, string, string, bool) (model.AssistantTask, error) {
	holder, hash := boundaryBot, "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd"
	until := d.now.Add(time.Hour)
	return model.AssistantTask{ID: boundaryTask, OwnerUserID: boundaryOwner, Application: "watchdog", State: "active", Version: 1, ManualVersion: 1, ClaimGeneration: 1, HolderBotID: &holder, ClaimTokenHash: &hash, LeaseUntil: &until}, nil
}
func (d boundaryDAO) Manual(context.Context, string, string, int64) (model.AssistantTaskManual, error) {
	return model.AssistantTaskManual{Rules: json.RawMessage(`[]`)}, nil
}
func (d boundaryDAO) Proposal(context.Context, string, string, string) (model.AssistantTaskProposal, error) {
	if !d.proposal {
		return model.AssistantTaskProposal{}, model.ErrNotFound
	}
	return model.AssistantTaskProposal{ID: boundaryEntry, Status: "pending", BaseVersion: 1, Rules: d.rules}, nil
}

func TestWatchdogBoundaryRejectsEveryManualWriteEntry(t *testing.T) {
	for _, rules := range []json.RawMessage{
		json.RawMessage(`[{"id":"a","category":"waiting_input","action":{"kind":"send_message","message":"Continue"}}]`),
		json.RawMessage(`[{"id":"a","category":"stalled","action":{"kind":"approve","message":"Continue"}}]`),
	} {
		for _, entry := range []string{"create", "proposal", "approve", "edited"} {
			t.Run(entry+string(rules), func(t *testing.T) {
				module := core.New()
				if err := module.RegisterRules("watchdog", watchdog.ValidateRules); err != nil {
					t.Fatal(err)
				}
				actor := core.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: boundaryOwner, CredentialID: boundaryEntry}}
				dao := boundaryDAO{now: time.Now(), proposal: entry == "approve" || entry == "edited", rules: rules}
				var err error
				switch entry {
				case "create":
					input := watchdog.Preset(boundaryTask)
					input.Rules = rules
					_, err = module.Create(t.Context(), dao, actor, input)
				case "proposal":
					bot := boundaryBot
					actor.BotID = &bot
					_, err = module.Propose(t.Context(), dao, actor, core.ProposalInput{Mutation: core.Mutation{TaskID: boundaryTask, ID: boundaryEntry, ClaimToken: boundaryToken, ClaimGeneration: 1}, BaseVersion: 1, Body: "Manual", Reason: "Reason", Rules: rules})
				default:
					decision := "approved"
					var replacement *json.RawMessage
					if entry == "edited" {
						decision = "edited"
						replacement = &rules
						dao.rules = json.RawMessage(`[]`)
					}
					_, err = module.Decide(t.Context(), dao, actor, core.DecisionInput{TaskID: boundaryTask, ID: boundaryEntry, IfVersion: 1, Decision: decision, Rules: replacement})
				}
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "invalid_input" {
					t.Fatalf("boundary failed: %v", err)
				}
			})
		}
	}
}
