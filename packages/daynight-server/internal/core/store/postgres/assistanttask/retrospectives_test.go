package assistanttask_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

const retrospectiveWeek = 7 * 24 * time.Hour

// claimToken and its digest form a valid live claim for core work writes.
const claimToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const claimTokenHash = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd"

// heldTask returns a fixture task older than one retrospective period whose
// live claim belongs to a new Bot.
func heldTask(t *testing.T) (fixture, string, model.Principal) {
	t.Helper()
	f := setup(t)
	bot, principal := f.bot(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	hash, lease := claimTokenHash, now.Add(time.Hour)
	f.task.CreatedAt = now.Add(-retrospectiveWeek - time.Hour)
	f.task.HolderBotID, f.task.ClaimTokenHash, f.task.ClaimGeneration = &bot, &hash, 1
	f.task.ClaimedAt, f.task.RenewedAt, f.task.LeaseUntil = &now, &now, &lease
	return f, bot, principal
}

func (f fixture) outcome(t *testing.T, task string) model.AssistantTaskRecord {
	t.Helper()
	var saved model.AssistantTaskRecord
	f.write(t, func(d store.AssistantTaskDAO) error {
		var err error
		saved, err = d.InsertRecord(t.Context(), model.AssistantTaskRecord{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: task, Author: "bot", Kind: "outcome", Text: "Worked", Refs: json.RawMessage(`[]`), Outcome: ptr("effective"), ActionRecordID: ptr(uuid.NewString()), RequestFingerprint: "outcome"})
		return err
	})
	return saved
}

func ptr[T any](v T) *T { return &v }

func (f fixture) retrospectives(t *testing.T, task string) []model.AssistantTaskEvent {
	t.Helper()
	var events []model.AssistantTaskEvent
	f.write(t, func(d store.AssistantTaskDAO) error {
		page, err := d.Events(t.Context(), store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: task, Limit: 50})
		for _, event := range page {
			if event.Type == "retrospective" {
				events = append(events, event)
			}
		}
		return err
	})
	return events
}

func TestRetrospectiveCandidatesFollowWindowHolderAndOutcomes(t *testing.T) {
	f, bot, _ := heldTask(t)
	ctx := t.Context()
	f.create(t)
	quiet := f.task
	quiet.ID = uuid.NewString()
	paused := f.task
	paused.ID, paused.State = uuid.NewString(), "paused"
	unowned := f.task
	unowned.ID, unowned.HolderBotID = uuid.NewString(), nil
	orphaned := f.task
	deletedBot, _ := f.bot(t)
	orphaned.ID, orphaned.HolderBotID = uuid.NewString(), &deletedBot
	for _, task := range []model.AssistantTask{quiet, paused, unowned, orphaned} {
		g := f
		g.task = task
		g.create(t)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE bots SET deletion='{}' WHERE id=$1`, deletedBot); err != nil {
		t.Fatal(err)
	}
	for _, task := range []string{f.task.ID, paused.ID, unowned.ID, orphaned.ID} {
		f.outcome(t, task)
	}
	latest := f.outcome(t, f.task.ID)
	candidates := func(q store.AssistantTaskQuery, cutoff time.Time) []string {
		t.Helper()
		var ids []string
		f.write(t, func(d store.AssistantTaskDAO) error {
			var err error
			q.OwnerUserID, q.Limit = f.owner, 10
			ids, err = d.RetrospectiveTasks(ctx, q, cutoff)
			return err
		})
		return ids
	}
	cutoff := time.Now().UTC().Add(-retrospectiveWeek)
	if got := candidates(store.AssistantTaskQuery{}, cutoff); len(got) != 1 || got[0] != f.task.ID {
		t.Fatalf("due candidates: %v", got)
	}
	if got := candidates(store.AssistantTaskQuery{TargetBotID: bot, TaskID: f.task.ID}, cutoff); len(got) != 1 {
		t.Fatalf("scoped candidates: %v", got)
	}
	for _, q := range []store.AssistantTaskQuery{{TargetBotID: deletedBot}, {TaskID: quiet.ID}, {OwnerUserID: uuid.NewString()}} {
		q := q
		var ids []string
		f.write(t, func(d store.AssistantTaskDAO) error {
			owner := q.OwnerUserID
			if owner == "" {
				owner = f.owner
			}
			q.OwnerUserID, q.Limit = owner, 10
			var err error
			ids, err = d.RetrospectiveTasks(ctx, q, cutoff)
			return err
		})
		if len(ids) != 0 {
			t.Fatalf("filtered candidates %#v: %v", q, ids)
		}
	}
	if got := candidates(store.AssistantTaskQuery{}, f.task.CreatedAt.Add(-time.Second)); len(got) != 0 {
		t.Fatalf("window not elapsed: %v", got)
	}
	marked := time.Now().UTC().Truncate(time.Microsecond)
	f.write(t, func(d store.AssistantTaskDAO) error {
		at, err := d.LatestOutcomeAt(ctx, f.owner, f.task.ID)
		if err != nil || at == nil || !at.Equal(latest.CreatedAt) {
			t.Fatalf("latest outcome: %v %v", at, err)
		}
		if at, err = d.LatestOutcomeAt(ctx, f.owner, quiet.ID); err != nil || at != nil {
			t.Fatalf("task without outcomes: %v %v", at, err)
		}
		if at, err = d.LatestOutcomeAt(ctx, uuid.NewString(), f.task.ID); err != nil || at != nil {
			t.Fatalf("foreign owner outcome: %v %v", at, err)
		}
		for _, c := range []struct {
			owner, task string
			want        bool
		}{{f.owner, f.task.ID, true}, {f.owner, paused.ID, false}, {uuid.NewString(), quiet.ID, false}} {
			if ok, err := d.MarkRetrospective(ctx, c.owner, c.task, marked); err != nil || ok != c.want {
				t.Fatalf("mark %s: %v %v", c.task, ok, err)
			}
		}
		got, err := d.Task(ctx, f.owner, f.task.ID, false)
		if err != nil || got.LastRetrospectiveAt == nil || !got.LastRetrospectiveAt.Equal(marked) || got.Version != f.task.Version || !got.UpdatedAt.Equal(f.task.UpdatedAt) {
			t.Fatalf("marked task: %#v %v", got, err)
		}
		other, err := d.Task(ctx, f.owner, quiet.ID, false)
		if err != nil || other.LastRetrospectiveAt != nil {
			t.Fatalf("unmarked task: %#v %v", other, err)
		}
		return nil
	})
	// The moved window has no newer outcome even once its period elapses.
	if got := candidates(store.AssistantTaskQuery{}, marked.Add(retrospectiveWeek)); len(got) != 0 {
		t.Fatalf("candidates after mark: %v", got)
	}
}

func TestItemCloseRetrospectiveCommitsWithTheClosure(t *testing.T) {
	f, bot, principal := heldTask(t)
	f.create(t)
	ctx := t.Context()
	actor := core.Actor{Principal: principal, BotID: &bot}
	item := uuid.NewString()
	save := func(d store.AssistantTaskDAO, state string, version *int64) (model.AssistantTaskItem, error) {
		return core.New().SaveItem(ctx, d, actor, core.ItemInput{Mutation: core.Mutation{TaskID: f.task.ID, ID: item, ClaimGeneration: 1, ClaimToken: claimToken}, Key: "build", Episode: 2, State: state, ItemVersion: version, AppState: json.RawMessage(`{}`)})
	}
	f.write(t, func(d store.AssistantTaskDAO) error { _, err := save(d, "open", nil); return err })
	rejected := errors.New("rejected close")
	if _, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
		if _, err := save(s.AssistantTaskDAO(), "closed", ptr(int64(1))); err != nil {
			return err
		}
		return rejected
	}); !errors.Is(err, rejected) {
		t.Fatalf("rolled back close: %v", err)
	}
	if got := f.retrospectives(t, f.task.ID); len(got) != 0 {
		t.Fatalf("rolled back close left a retrospective: %#v", got)
	}
	f.write(t, func(d store.AssistantTaskDAO) error { _, err := save(d, "closed", ptr(int64(1))); return err })
	f.write(t, func(d store.AssistantTaskDAO) error { _, err := save(d, "closed", ptr(int64(2))); return err })
	got := f.retrospectives(t, f.task.ID)
	if len(got) != 1 || got[0].TargetBotID != bot || got[0].Attention || got[0].State != "pending" {
		t.Fatalf("item retrospective: %#v", got)
	}
	var payload struct {
		Reason, ItemID string
		Episode        int64
	}
	if err := json.Unmarshal(got[0].Payload, &payload); err != nil || payload.Reason != "item_closed" || payload.ItemID != item || payload.Episode != 2 {
		t.Fatalf("item retrospective payload: %s %v", got[0].Payload, err)
	}
	var closures int
	if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM assistant_task_item_closures WHERE task_id=$1`, f.task.ID).Scan(&closures); err != nil || closures != 1 {
		t.Fatalf("closures: %d %v", closures, err)
	}
}

func TestConcurrentEventPullsWriteOnePeriodicRetrospective(t *testing.T) {
	f, bot, principal := heldTask(t)
	f.create(t)
	f.outcome(t, f.task.ID)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	actor := core.Actor{Principal: principal}
	pulled, release := make(chan struct{}), make(chan struct{})
	pull := func(hold bool) error {
		_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
			if _, err := core.New().ListEvents(ctx, s.AssistantTaskDAO(), actor, f.task.ID, core.PageInput{TargetBotID: bot}); err != nil {
				return err
			}
			if hold {
				close(pulled)
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return nil
		})
		return err
	}
	first := asyncDatabase(t, ctx, func(context.Context) error { return pull(true) })
	select {
	case <-pulled:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	second := asyncDatabase(t, ctx, func(context.Context) error { return pull(false) })
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text FROM assistant_tasks WHERE owner_user_id")
	close(release)
	for _, result := range []<-chan error{first, second} {
		if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
			t.Fatal(err)
		}
	}
	got := f.retrospectives(t, f.task.ID)
	if len(got) != 1 || got[0].TargetBotID != bot || got[0].Attention {
		t.Fatalf("periodic retrospectives: %#v", got)
	}
	var payload struct{ Reason, Since string }
	if err := json.Unmarshal(got[0].Payload, &payload); err != nil || payload.Reason != "periodic" {
		t.Fatalf("payload: %s %v", got[0].Payload, err)
	}
	if since, err := time.Parse(time.RFC3339Nano, payload.Since); err != nil || !since.Equal(f.task.CreatedAt) {
		t.Fatalf("window start: %s %v", payload.Since, err)
	}
	// A later pull with no newer outcome keeps the single retrospective.
	if err := pull(false); err != nil {
		t.Fatal(err)
	}
	if again := f.retrospectives(t, f.task.ID); len(again) != 1 {
		t.Fatalf("repeated retrospective: %#v", again)
	}
}

func TestPausedTaskPullWritesNoPeriodicRetrospective(t *testing.T) {
	f, bot, principal := heldTask(t)
	f.task.State = "paused"
	f.create(t)
	f.outcome(t, f.task.ID)
	f.write(t, func(d store.AssistantTaskDAO) error {
		_, err := core.New().ListEvents(t.Context(), d, core.Actor{Principal: principal}, "", core.PageInput{TargetBotID: bot})
		return err
	})
	if got := f.retrospectives(t, f.task.ID); len(got) != 0 {
		t.Fatalf("paused retrospective: %#v", got)
	}
}
