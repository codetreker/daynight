package bot

import (
	"context"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/google/uuid"
)

type beforeCreationStore struct {
	botStore
	before func()
}

func (s *beforeCreationStore) WriteBot(ctx context.Context, operation func(store.BotScope) error) (store.Completion, error) {
	if s.before != nil {
		before := s.before
		s.before = nil
		before()
	}
	return s.botStore.WriteBot(ctx, operation)
}

func TestCreationRejectsWorkerChangeHiddenByRetiredPreference(t *testing.T) {
	bots, db, principal, worker := botService(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	report := serviceWorkerReport()
	report.Telemetry.AssistantHost = validAssistantHost()
	report.Telemetry.AssistantHost.ObservedAt = time.Now().Add(-time.Second)
	report.Telemetry.AssistantHost.CreationConfigurationVersion = 1
	report.Telemetry.AssistantHost.DefaultProvider = model.AgentCodex
	report.Telemetry.AssistantHost.Providers[0].Model = pointer("model-a")
	if _, err := workerservice.NewWorkers(db).Report(ctx, principal, worker, report); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO bot_model_preferences (user_id,worker_id,provider,model,creation_order) VALUES ($1,$2,'codex','retired',1)`, principal.UserID, worker); err != nil {
		t.Fatal(err)
	}
	calls := 0
	bots.models = modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
		calls++
		report.Telemetry.AssistantHost.Providers[0].Model = pointer("model-b")
		if _, err := workerservice.NewWorkers(db).Report(ctx, principal, worker, report); err != nil {
			return ro.Message{}, err
		}
		return nativeResponse(p, w, r), nil
	})
	input := botcore.CreateBot{ID: uuid.NewString(), Name: "Retired preference"}
	_, err := bots.CreateResolved(ctx, principal, input)
	requireFault(t, err, "resource_conflict")
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM bots WHERE id=$1`, input.ID).Scan(&count); err != nil || count != 0 || calls != 1 {
		t.Fatalf("stale observation inserted or retried: count=%d calls=%d err=%v", count, calls, err)
	}
}

func TestCreationRejectsNewEffortHistoryWithoutDiscovery(t *testing.T) {
	for _, winner := range []bool{false, true} {
		name := "new history requires discovery"
		if winner {
			name = "original ID wins before new history"
		}
		t.Run(name, func(t *testing.T) {
			bots, db, principal, worker := botService(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			report := serviceWorkerReport()
			report.Telemetry.AssistantHost = validAssistantHost()
			report.Telemetry.AssistantHost.ObservedAt = time.Now().Add(-time.Second)
			report.Telemetry.AssistantHost.CreationConfigurationVersion = 1
			report.Telemetry.AssistantHost.DefaultProvider = model.AgentCodex
			if _, err := workerservice.NewWorkers(db).Report(ctx, principal, worker, report); err != nil {
				t.Fatal(err)
			}
			input := botcore.CreateBot{ID: uuid.NewString(), Name: "Native model"}
			var committed model.Bot
			bots.store = &beforeCreationStore{botStore: db, before: func() {
				if winner {
					var err error
					committed, err = New(db).CreateResolved(ctx, principal, input)
					if err != nil {
						t.Fatal(err)
					}
				}
				if _, err := db.Pool.Exec(ctx, `INSERT INTO bot_effort_preferences (user_id,worker_id,provider,model,reasoning_effort,creation_order) VALUES ($1,$2,'codex','model-a','low',1)`, principal.UserID, worker); err != nil {
					t.Fatal(err)
				}
			}}
			calls := 0
			bots.models = modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
				calls++
				return nativeResponse(p, w, r), nil
			})
			created, err := bots.CreateResolved(ctx, principal, input)
			if winner {
				if err != nil || created.ID != committed.ID || created.ResolvedConfiguration.ReasoningEffort != nil || calls != 0 {
					t.Fatalf("original ID did not retain its frozen result: %+v %v calls=%d", created, err, calls)
				}
				return
			}
			requireFault(t, err, "resource_conflict")
			var count int
			if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM bots WHERE id=$1`, input.ID).Scan(&count); err != nil || count != 0 || calls != 0 {
				t.Fatalf("undiscovered history inserted or retried: count=%d calls=%d err=%v", count, calls, err)
			}
			created, err = bots.CreateResolved(ctx, principal, input)
			if err != nil || created.ID != input.ID || created.ResolvedConfiguration.ReasoningEffort == nil || *created.ResolvedConfiguration.ReasoningEffort != "low" || created.ResolvedConfiguration.Selection.ReasoningEffortSource != "preference" || calls != 1 {
				t.Fatalf("fresh original-ID request lost discovered history: %+v %v calls=%d", created, err, calls)
			}
		})
	}
}
