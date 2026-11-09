package mcp

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
)

func TestAttachmentRemoveCompletionFacts(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: testTeamID}
	actor := RequestActor{Principal: principal, RequestID: "completion-test"}
	input := attachmentInput{ProjectID: testProjectID, TaskID: testTargetID, Path: "file"}
	for _, tc := range []struct {
		name, want string
		cause      error
	}{
		{"file failure", "unknown", errors.New("file delete failed")},
		{"lost receipt", "unknown", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("cleanup failed")}},
		{"committed cleanup failure", "confirmed", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: errors.New("cleanup failed")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			failure := &attachmentservice.FileEffectError{Cause: tc.cause}
			subject := attachmentDeleteOperation{t: t, delete: func(ctx context.Context, actual model.Principal, project, task, path string) error {
				calls++
				if ctx != t.Context() || actual != principal || project != testProjectID || task != testTargetID || path != "file" {
					t.Errorf("incorrect remove call: principal=%+v project=%s task=%s path=%s", actual, project, task, path)
				}
				return failure
			}}
			result, err := removeAttachment(t.Context(), actor, subject, input)
			if !errors.Is(err, tc.cause) || result.WriteOutcome != tc.want || result.Refs["path"] != "file" || calls != 1 {
				t.Fatalf("outcome=%#v error=%v calls=%d", result, err, calls)
			}
		})
	}
}
