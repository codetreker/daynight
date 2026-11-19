package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func botBarrierCapture(ctx context.Context, dao store.WebhookCaptureDAO, project string, actor wm.Actor, fact protocol.Fact) (string, error) {
	audience, err := dao.FreezeAudience(ctx, project, []string{fact.Type})
	if err != nil {
		return "", err
	}
	event, deliveries, err := taskWebhookPrepared(fact, audience)
	if err != nil {
		return "", err
	}
	event.Actor = actor
	return event.ID, dao.SaveCapture(ctx, event, deliveries)
}

func botBarrierStoredActor(t *testing.T, ctx context.Context, database *Store, eventID string) wm.Actor {
	t.Helper()
	tx, err := database.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	provenance, err := webhook.New(tx).CapturedEventProvenance(ctx, eventID)
	if err != nil {
		t.Fatal(err)
	}
	return provenance.Actor
}

func botBarrierDeletion() *model.BotDeletion {
	return &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 1,
		WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
}

// Project and Thread writes read a declared Bot through the shared barrier and
// store the verified Bot actor with Task, Step and Thread captures.
func TestDeclaredBotActorIsStoredWithTaskStepAndThreadCaptures(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := taskWebhookStore(t)
	bot := runtimeStoredBot(t, f.db)
	actor := wm.BotActor(bot.OwnerUserID, bot.ID)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var events []string
	completion, err := f.db.WriteProject(ctx, f.project, func(sc store.ProjectWriteScope) error {
		locked, err := sc.BotBarrierDAO().Bot(ctx, bot.ID)
		if err != nil || locked.OwnerUserID != bot.OwnerUserID || locked.Deletion != nil {
			t.Fatalf("barrier Bot: %+v %v", locked, err)
		}
		changed, err := sc.TaskDAO().UpdateTask(ctx, f.task, store.TaskWrite{Title: "source", Status: model.TaskInProgress})
		if err != nil {
			return err
		}
		now, err := sc.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		step := model.TaskStep{ID: "0000000a", Title: "declared", Status: model.TaskStepTodo, CreatedAt: now, UpdatedAt: now}
		if err = sc.TaskDAO().InsertTaskStep(ctx, f.task, step); err != nil {
			return err
		}
		if err = sc.TaskDAO().TouchTask(ctx, f.task, now); err != nil {
			return err
		}
		header, err := sc.TaskDAO().TaskHeader(ctx, f.task)
		if err != nil {
			return err
		}
		for _, fact := range []protocol.Fact{
			{Type: protocol.StatusChanged, ProjectID: f.project, TaskID: f.task, TaskVersion: changed.Version, OccurredAt: changed.UpdatedAt, PreviousStatus: "todo", Status: "in_progress"},
			{Type: protocol.StepUpdated, ProjectID: f.project, TaskID: f.task, TaskVersion: header.Version, OccurredAt: now, StepID: step.ID, Action: "created"},
		} {
			id, err := botBarrierCapture(ctx, sc.CaptureDAO(), f.project, actor, fact)
			if err != nil {
				return err
			}
			events = append(events, id)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("project capture: %v %v", completion, err)
	}
	completion, err = f.db.WriteThread(ctx, func(sc store.ThreadScope) error {
		if _, err := sc.BotBarrierDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		message, err := taskWebhookInsertMessage(ctx, sc, f, "declared", nil)
		if err != nil {
			return err
		}
		id, err := botBarrierCapture(ctx, sc.CaptureDAO(), f.project, actor, protocol.Fact{Type: protocol.ThreadPosted, ProjectID: f.project, TaskID: f.task, MessageID: message.ID, CreatedAt: &message.CreatedAt, OccurredAt: message.CreatedAt})
		events = append(events, id)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("thread capture: %v %v", completion, err)
	}
	if len(events) != 3 {
		t.Fatalf("captured events: %v", events)
	}
	for _, id := range events {
		stored := botBarrierStoredActor(t, ctx, f.db, id)
		if stored != actor || stored.Kind != wm.ActorBot || stored.UserID != bot.OwnerUserID || stored.BotID != bot.ID {
			t.Fatalf("stored actor for %s = %+v, want %+v", id, stored, actor)
		}
	}
	if _, err := webhookBarrierMissingBot(ctx, f.db, f.project); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Bot barrier = %v, want not found", err)
	}
}

func webhookBarrierMissingBot(ctx context.Context, database *Store, project string) (model.Bot, error) {
	var bot model.Bot
	_, err := database.WriteProject(ctx, project, func(sc store.ProjectWriteScope) error {
		var err error
		bot, err = sc.BotBarrierDAO().Bot(ctx, uuid.NewString())
		return err
	})
	return bot, err
}

// A deletion that commits while a write waits on the barrier is visible to the
// write's fresh read, so the write cannot commit an actor for a deleted Bot.
func TestBotBarrierObservesDeletionCommittedDuringWait(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := taskWebhookStore(t)
	bot := runtimeStoredBot(t, f.db)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	write := make(chan error, 1)
	var observed model.Bot
	completion, err := f.db.WriteBot(ctx, func(scope store.BotScope) error {
		if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		go func() {
			_, err := f.db.WriteThread(ctx, func(sc store.ThreadScope) error {
				var err error
				observed, err = sc.BotBarrierDAO().Bot(ctx, bot.ID)
				return err
			})
			write <- err
		}()
		waitForQueryLock(t, f.db, "SELECT id::text FROM bots WHERE id=$1 FOR SHARE")
		_, err := scope.BotDAO().SaveBotDeletion(ctx, bot.ID, botBarrierDeletion())
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("deletion: %v %v", completion, err)
	}
	if err := receiveQueryResult(t, ctx, write); err != nil {
		t.Fatal(err)
	}
	if observed.Deletion == nil {
		t.Fatal("barrier returned the Bot as live after deletion committed")
	}
}

// A write holding the barrier makes deletion wait until the Bot actor commits.
func TestBotDeletionWaitsForWriteHoldingBarrier(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := taskWebhookStore(t)
	bot := runtimeStoredBot(t, f.db)
	actor := wm.BotActor(bot.OwnerUserID, bot.ID)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	deletion := make(chan error, 1)
	var eventID string
	var capturedAt, deletedAt time.Time
	completion, err := f.db.WriteProject(ctx, f.project, func(sc store.ProjectWriteScope) error {
		if _, err := sc.BotBarrierDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		go func() {
			_, err := f.db.WriteBot(ctx, func(scope store.BotScope) error {
				if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
					return err
				}
				deletedAt = time.Now()
				_, err := scope.BotDAO().SaveBotDeletion(ctx, bot.ID, botBarrierDeletion())
				return err
			})
			deletion <- err
		}()
		waitForQueryLock(t, f.db, "SELECT id::text FROM bots WHERE id=$1 FOR UPDATE")
		changed, err := sc.TaskDAO().UpdateTask(ctx, f.task, store.TaskWrite{Title: "source", Status: model.TaskInProgress})
		if err != nil {
			return err
		}
		eventID, err = botBarrierCapture(ctx, sc.CaptureDAO(), f.project, actor, protocol.Fact{Type: protocol.StatusChanged, ProjectID: f.project, TaskID: f.task, TaskVersion: changed.Version, OccurredAt: changed.UpdatedAt, PreviousStatus: "todo", Status: "in_progress"})
		capturedAt = time.Now()
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("write: %v %v", completion, err)
	}
	if err := receiveQueryResult(t, ctx, deletion); err != nil {
		t.Fatal(err)
	}
	if !deletedAt.After(capturedAt) {
		t.Fatal("deletion acquired the Bot before the barrier holder committed")
	}
	if stored := botBarrierStoredActor(t, ctx, f.db, eventID); stored != actor {
		t.Fatalf("stored actor = %+v, want %+v", stored, actor)
	}
}
