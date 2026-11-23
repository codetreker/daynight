package assistanttask_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestApplicationUniquenessExcludesDeletedTaskAndListsRespectKeysets(t *testing.T) {
	f := setup(t)
	ctx := t.Context()
	bot, _ := f.bot(t)
	f.task.Application = "watchdog"
	f.task.HolderBotID = &bot
	f.create(t)
	duplicate := f.task
	duplicate.ID = uuid.NewString()
	f.write(t, func(d store.AssistantTaskDAO) error {
		if err := d.LockCreation(ctx, duplicate.ID); err != nil {
			return err
		}
		ok, err := d.InsertTask(ctx, duplicate)
		if err != nil {
			return err
		}
		if ok {
			return errors.New("duplicate active application inserted")
		}
		deleted := f.task
		deleted.State = "deleted"
		deleted.Version = 2
		ok, err = d.SaveTask(ctx, deleted, store.AssistantTaskCondition{Version: 1})
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("delete transition refused")
		}
		ok, err = d.InsertTask(ctx, duplicate)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("tombstone prevented application recreation")
		}
		return nil
	})
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"}
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, id := range ids {
			v := f.task
			v.ID = id
			v.Application = ""
			v.State = "paused"
			ok, err := d.InsertTask(ctx, v)
			if err != nil {
				return err
			}
			if !ok {
				return errors.New("empty application incorrectly unique")
			}
		}
		return nil
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		q := store.AssistantTaskQuery{OwnerUserID: f.owner, State: "paused", TargetBotID: bot, Limit: 1, After: &store.AssistantTaskPosition{CreatedAt: f.task.CreatedAt, ID: ids[0]}}
		got, err := d.Tasks(ctx, q)
		if err != nil {
			return err
		}
		if len(got) != 2 || got[0].ID != ids[1] || got[1].ID != ids[2] || got[0].ObservedAt.IsZero() {
			return fmt.Errorf("task keyset/filter: %#v", got)
		}
		q.State = "active"
		q.After = nil
		got, err = d.Tasks(ctx, q)
		if err != nil {
			return err
		}
		if len(got) != 1 || got[0].ID != duplicate.ID {
			return fmt.Errorf("deleted task returned: %#v", got)
		}
		foreign := duplicate
		foreign.OwnerUserID = uuid.NewString()
		ok, err := d.SaveTask(ctx, foreign, store.AssistantTaskCondition{Version: 1})
		if err != nil {
			return err
		}
		if ok {
			return errors.New("foreign owner changed task")
		}
		_, err = d.Task(ctx, f.owner, uuid.NewString(), true)
		if !errors.Is(err, model.ErrNotFound) {
			return fmt.Errorf("missing identity: %v", err)
		}
		return nil
	})
}
