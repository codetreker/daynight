package attachment

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
)

type attachmentStorageOnly struct{ filestorage.Storage }
type attachmentTransferWithoutPublisher struct {
	filestorage.Storage
	filestorage.TransferStorage
}

func TestAdmitTransferRejectsInvalidInputsAndMissingStorage(t *testing.T) {
	attachments, _, database, files, task, principal := attachmentService(t)
	namespace := transferNamespace(t)
	for _, test := range []struct {
		name, project, taskID, path, contentType string
		principal                                model.Principal
		namespace                                filestorage.TransferNamespace
	}{
		{"missing principal", task.ProjectID, task.ID, "file", "text/plain", model.Principal{}, namespace},
		{"invalid project", "not-a-uuid", task.ID, "file", "text/plain", principal, namespace},
		{"invalid task", task.ProjectID, "not-a-uuid", "file", "text/plain", principal, namespace},
		{"invalid path", task.ProjectID, task.ID, "../escape", "text/plain", principal, namespace},
		{"oversized path", task.ProjectID, task.ID, strings.Repeat("a", 1025), "text/plain", principal, namespace},
		{"invalid content type", task.ProjectID, task.ID, "file", "bad type", principal, namespace},
		{"invalid namespace", task.ProjectID, task.ID, "file", "text/plain", principal, filestorage.TransferNamespace{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			admission, err := attachments.AdmitTransfer(t.Context(), test.principal, test.project, test.taskID, test.path, test.contentType, test.namespace)
			if err == nil || admission != nil || FileEffectPossible(err) {
				t.Fatalf("invalid admission = %v, error = %v", admission, err)
			}
		})
	}
	for _, storage := range []filestorage.Storage{
		attachmentStorageOnly{files},
		attachmentTransferWithoutPublisher{Storage: files, TransferStorage: files},
	} {
		subject := newAttachmentService(database, storage)
		admission, err := subject.AdmitTransfer(t.Context(), principal, task.ProjectID, task.ID, "file", "text/plain", namespace)
		if err == nil || admission != nil || FileEffectPossible(err) {
			t.Fatalf("unsupported storage admission = %v, error = %v", admission, err)
		}
	}
}

func TestAdmitTransferRejectsCancellationAuthorizationAndConflicts(t *testing.T) {
	attachments, _, database, files, task, owner := attachmentService(t)
	namespace := transferNamespace(t)
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	admission, err := attachments.AdmitTransfer(canceled, owner, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if admission != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled admission = %v, error = %v", admission, err)
	}
	stranger := testsupport.ServicePrincipal(t, database)
	admission, err = attachments.AdmitTransfer(t.Context(), stranger, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if admission != nil {
		t.Fatal("unauthorized principal was admitted")
	}
	requireFault(t, err, "not_found")
	putAttachment(t, attachments, owner, task, "parent", "existing")
	admission, err = attachments.AdmitTransfer(t.Context(), owner, task.ProjectID, task.ID, "parent/child", "text/plain", namespace)
	if admission != nil {
		t.Fatal("conflicting path was admitted")
	}
	requireFault(t, err, "path_conflict")
	// Rejection must release the target gate, so a subsequent call can retry.
	ctx, stop := context.WithTimeout(t.Context(), time.Second)
	defer stop()
	permit, err := files.AcquireGate(ctx, filestorage.TargetGate, attachmentTestStoragePath(task, "parent/child"))
	if err != nil {
		t.Fatalf("rejected admission retained target gate: %v", err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
}
