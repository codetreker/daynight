package assistanttask_test

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"testing"
)

func TestApplicationTaskReadScopesOwnerAndExcludesDeletion(t *testing.T) {
	f := setup(t)
	f.task.Application = "watchdog"
	f.create(t)
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.ApplicationTask(t.Context(), f.owner, "watchdog")
		if err != nil {
			return err
		}
		if got.ID != f.task.ID || got.Application != "watchdog" || got.ObservedAt.IsZero() {
			t.Fatalf("wrong projection %#v", got)
		}
		for _, q := range [][2]string{{uuid.NewString(), "watchdog"}, {f.owner, "unknown"}} {
			if _, err = d.ApplicationTask(t.Context(), q[0], q[1]); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("wrong scope %v", err)
			}
		}
		got.State = "deleted"
		got.Version++
		if ok, err := d.SaveTask(t.Context(), got, store.AssistantTaskCondition{Version: f.task.Version}); err != nil {
			return err
		} else if !ok {
			t.Fatal("delete refused")
		}
		if _, err = d.ApplicationTask(t.Context(), f.owner, "watchdog"); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted singleton returned %v", err)
		}
		return nil
	})
}
