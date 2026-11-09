package attachment

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type attachmentStorageOnly struct{ filestorage.Storage }
type attachmentTransferWithoutPublisher struct {
	filestorage.Storage
	filestorage.TransferStorage
}

func TestAdmitTransferRejectsInvalidInputsAndMissingStorage(t *testing.T) {
	attachments, m, files, task, p := attachmentUnit(t)
	namespace := transferNamespace(t)
	for _, test := range []struct {
		name, project, taskID, path, contentType string
		principal                                model.Principal
		namespace                                filestorage.TransferNamespace
	}{
		{"missing principal", task.ProjectID, task.ID, "file", "text/plain", model.Principal{}, namespace},
		{"invalid project", "not-a-uuid", task.ID, "file", "text/plain", p, namespace},
		{"invalid task", task.ProjectID, "not-a-uuid", "file", "text/plain", p, namespace},
		{"invalid path", task.ProjectID, task.ID, "../escape", "text/plain", p, namespace},
		{"oversized path", task.ProjectID, task.ID, strings.Repeat("a", 1025), "text/plain", p, namespace},
		{"invalid content type", task.ProjectID, task.ID, "file", "bad type", p, namespace},
		{"invalid namespace", task.ProjectID, task.ID, "file", "text/plain", p, filestorage.TransferNamespace{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			admission, err := attachments.AdmitTransfer(t.Context(), test.principal, test.project, test.taskID, test.path, test.contentType, test.namespace)
			if err == nil || admission != nil || FileEffectPossible(err) {
				t.Fatalf("invalid admission: %v %v", admission, err)
			}
		})
	}
	for _, storage := range []filestorage.Storage{attachmentStorageOnly{files}, attachmentTransferWithoutPublisher{Storage: files, TransferStorage: files}} {
		subject := NewAttachments(m, m, storage)
		admission, err := subject.AdmitTransfer(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", namespace)
		if err == nil || admission != nil || FileEffectPossible(err) {
			t.Fatalf("unsupported storage admission: %v %v", admission, err)
		}
	}
}

func TestAdmitTransferRejectsCancellationAuthorizationAndConflicts(t *testing.T) {
	attachments, m, files, task, owner := attachmentUnit(t)
	namespace := transferNamespace(t)
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	admission, err := attachments.AdmitTransfer(canceled, owner, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if admission != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled admission: %v %v", admission, err)
	}
	stranger := owner
	stranger.UserID = "ef000000-0000-4000-8000-000000000003"
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("authorize", stranger, task.ProjectID).err = model.ErrNotFound
	admission, err = attachments.AdmitTransfer(t.Context(), stranger, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if admission != nil {
		t.Fatal("unauthorized principal admitted")
	}
	requireFault(t, err, "not_found")
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("authorize", owner, task.ProjectID).result = model.ProjectAccess{}
	m.conflict(task, "parent/child", true)
	admission, err = attachments.AdmitTransfer(t.Context(), owner, task.ProjectID, task.ID, "parent/child", "text/plain", namespace)
	if admission != nil {
		t.Fatal("conflicting path admitted")
	}
	requireFault(t, err, "path_conflict")
	ctx, stop := context.WithTimeout(t.Context(), time.Second)
	defer stop()
	permit, err := files.AcquireGate(ctx, filestorage.TargetGate, attachmentTestStoragePath(task, "parent/child"))
	if err != nil {
		t.Fatalf("rejected admission retained gate: %v", err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
}
