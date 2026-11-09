package attachment

import (
	"context"
	"errors"
	"reflect"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestMissingAttachmentTaskRefusalWaitsForSnapshotCompletion(t *testing.T) {
	for _, failed := range []bool{false, true} {
		name := "confirmed refusal"
		if failed {
			name = "unknown completion"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
			projectID, taskID := "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"
			reader := newAttachmentMock(t)
			snapshot := reader.expect("snapshot")
			snapshot.ctx, snapshot.callback = ctx, true
			var failure *store.TransactionError
			if failed {
				failure = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}
				snapshot.err = failure
			}
			access := reader.expect("access", principal, projectID)
			access.ctx, access.result = ctx, model.ProjectAccess{ProjectID: projectID}
			presence := reader.expect("presence", projectID, taskID)
			presence.ctx, presence.result = ctx, store.TaskPresence{Found: false}
			result, err := NewAttachments(reader, nil, nil).List(ctx, principal, projectID, taskID, model.PageRequest{Limit: 10})
			if !reflect.DeepEqual(result, attachmentcore.Page{}) {
				t.Fatalf("missing attachment Task exposed a result: %+v", result)
			}
			if !failed {
				requireFault(t, err, "not_found")
				return
			}
			var completion *store.TransactionError
			var refusal *model.Fault
			if !errors.Is(err, failure) || !errors.Is(err, context.Canceled) || !errors.As(err, &completion) || completion != failure || completion.Outcome != store.TransactionUnknown || !completion.CommitAttempted || errors.As(err, &refusal) {
				t.Fatalf("completion was replaced by the staged refusal: %v", err)
			}
		})
	}
}
