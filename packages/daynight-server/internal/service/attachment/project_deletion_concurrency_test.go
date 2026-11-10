package attachment

import (
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProjectDeletionRefusesAttachmentMutations(t *testing.T) {
	for _, operation := range []string{"put", "overwrite", "delete"} {
		for _, taskDeleted := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/task_deleted=%t", operation, taskDeleted), func(t *testing.T) {
				_, m, files, task, p := attachmentUnit(t)
				presence := store.TaskPresence{Found: true}
				if taskDeleted {
					at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
					presence.DeletedAt = &at
				}
				if operation != "delete" {
					m.expect("snapshot").callback = true
					m.expect("projectRead", p, task.ProjectID).result = model.ProjectAccess{ProjectID: task.ProjectID}
					m.expect("presence", task.ProjectID, task.ID).result = presence
				}
				m.expect("mutation").callback = true
				m.expect("lock", task.ProjectID, task.ID).result = presence
				if operation == "delete" || taskDeleted {
					m.expect("authorize", p, task.ProjectID).err = model.ErrNotFound
				} else {
					m.expect("live", task.ProjectID).err = model.ErrNotFound
				}
				observed := &observedAttachmentStorage{Storage: files}
				err := attachmentMutation(t.Context(), m.service(m, observed), p, task, operation)
				requireFault(t, err, "not_found")
				if observed.calls.Load() != 0 {
					t.Fatal("deleted Project reached file storage")
				}
			})
		}
	}
}
