package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type ancestorAdmissionDAO struct {
	store.TaskWriteDAO
	terminal bool
	err      error
	parent   string
}

func (d *ancestorAdmissionDAO) HasTerminalAncestorGoal(_ context.Context, parent string) (bool, error) {
	d.parent = parent
	return d.terminal, d.err
}

func TestClaimAncestorGoalAdmission(t *testing.T) {
	for _, terminal := range []bool{false, true} {
		dao := &ancestorAdmissionDAO{terminal: terminal}
		err := ClaimParentAdmission(t.Context(), dao, model.Task{ParentID: ptr(childID)})
		if terminal {
			faultCode(t, err, "invalid_transition")
		} else if err != nil {
			t.Fatal(err)
		}
		if dao.parent != childID {
			t.Fatalf("ancestor traversal started from %s", dao.parent)
		}
	}
	cause := errors.New("ancestor read failed")
	dao := &ancestorAdmissionDAO{err: cause}
	if err := ClaimParentAdmission(t.Context(), dao, model.Task{ParentID: ptr(childID)}); !errors.Is(err, cause) {
		t.Fatalf("lost ancestor read error: %v", err)
	}
}
