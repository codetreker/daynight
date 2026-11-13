package assistanttask_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask/watchdog"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type legacyRepairDAO struct {
	boundaryDAO
	manuals   []model.AssistantTaskManual
	proposals []model.AssistantTaskProposal
	tasks     []model.AssistantTask
	events    []model.AssistantTaskEvent
	cleared   bool
	rollback  bool
}

func (d *legacyRepairDAO) Task(ctx context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
	task, err := d.boundaryDAO.Task(ctx, owner, id, lock)
	if d.rollback {
		task.ManualVersion = 2
	}
	return task, err
}

func (d *legacyRepairDAO) Manual(_ context.Context, _, _ string, version int64) (model.AssistantTaskManual, error) {
	if d.rollback && version == 1 {
		return model.AssistantTaskManual{Version: 1, Body: "Report only", Rules: json.RawMessage(`[]`)}, nil
	}
	return model.AssistantTaskManual{Version: version, Body: "Legacy manual", Rules: json.RawMessage(`{}`)}, nil
}
func (d *legacyRepairDAO) InsertManual(_ context.Context, value model.AssistantTaskManual) error {
	d.manuals = append(d.manuals, value)
	return nil
}
func (d *legacyRepairDAO) InsertProposal(_ context.Context, value model.AssistantTaskProposal) (bool, error) {
	d.proposals = append(d.proposals, value)
	return true, nil
}
func (d *legacyRepairDAO) SaveProposal(_ context.Context, value model.AssistantTaskProposal, _ string) (bool, error) {
	d.proposals = append(d.proposals, value)
	return true, nil
}
func (d *legacyRepairDAO) Proposals(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskProposal, error) {
	return nil, nil
}
func (d *legacyRepairDAO) SaveTask(_ context.Context, value model.AssistantTask, _ store.AssistantTaskCondition) (bool, error) {
	d.tasks = append(d.tasks, value)
	return true, nil
}
func (d *legacyRepairDAO) InsertEvent(_ context.Context, value model.AssistantTaskEvent) (bool, error) {
	d.events = append(d.events, value)
	return true, nil
}
func (d *legacyRepairDAO) Event(context.Context, string, string, string) (model.AssistantTaskEvent, error) {
	return model.AssistantTaskEvent{ID: boundaryEntry, State: "pending", Attention: true}, nil
}
func (d *legacyRepairDAO) SaveEvent(_ context.Context, value model.AssistantTaskEvent, _ string) (bool, error) {
	d.cleared = !value.Attention
	return true, nil
}

func TestWatchdogLegacyManualRepairEntries(t *testing.T) {
	for _, entry := range []string{"proposal", "approved", "edited", "rollback"} {
		t.Run(entry, func(t *testing.T) {
			module := core.New()
			if err := module.RegisterRules("watchdog", watchdog.ValidateRules); err != nil {
				t.Fatal(err)
			}
			dao := &legacyRepairDAO{boundaryDAO: boundaryDAO{now: time.Now(), proposal: entry == "approved" || entry == "edited", rules: json.RawMessage(`[]`)}}
			dao.rollback = entry == "rollback"
			currentVersion := int64(1)
			if dao.rollback {
				currentVersion = 2
			}
			actor := core.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: boundaryOwner, CredentialID: boundaryEntry}}
			var err error
			switch entry {
			case "proposal":
				bot := boundaryBot
				actor.BotID = &bot
				_, err = module.Propose(t.Context(), dao, actor, core.ProposalInput{Mutation: core.Mutation{TaskID: boundaryTask, ID: boundaryEntry, ClaimToken: boundaryToken, ClaimGeneration: 1}, BaseVersion: 1, Body: "Report only", Reason: "Repair legacy empty rules", Rules: json.RawMessage(`[]`)})
			case "rollback":
				_, err = module.Rollback(t.Context(), dao, actor, core.RollbackInput{TaskID: boundaryTask, IfVersion: 1, ManualVersion: 1})
			default:
				input := core.DecisionInput{TaskID: boundaryTask, ID: boundaryEntry, IfVersion: 1, Decision: entry}
				if entry == "edited" {
					dao.rules = json.RawMessage(`{}`)
					replacement := json.RawMessage(`[]`)
					input.Rules = &replacement
				}
				_, err = module.Decide(t.Context(), dao, actor, input)
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(dao.tasks) != 1 {
				t.Fatalf("task writes: %d", len(dao.tasks))
			}
			if entry == "proposal" {
				if len(dao.manuals) != 0 || dao.tasks[0].ManualVersion != 1 {
					t.Fatal("proposal changed manual")
				}
			} else if len(dao.manuals) != 1 || string(dao.manuals[0].Rules) != `[]` || dao.manuals[0].Version != currentVersion+1 || dao.tasks[0].ManualVersion != currentVersion+1 {
				t.Fatalf("repair did not append valid rules: %#v", dao.manuals)
			}
			if entry != "rollback" {
				if len(dao.proposals) != 1 || dao.proposals[0].Widens || string(dao.proposals[0].Rules) != `[]` || len(dao.events) != 1 {
					t.Fatalf("repair proposal or notification: %#v", dao)
				}
				if entry != "proposal" && !dao.cleared {
					t.Fatal("approval retained pending attention")
				}
			}
		})
	}
}
