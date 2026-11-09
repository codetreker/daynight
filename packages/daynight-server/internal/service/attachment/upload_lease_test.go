package attachment

import (
	"io"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestUploadLeaseCoordinatesInstancesAndOwners(t *testing.T) {
	root := t.TempDir()
	first, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	a := NewAttachments(nil, nil, first)
	b := NewAttachments(nil, nil, second)
	user := model.Principal{UserID: uuid.NewString()}
	other := model.Principal{UserID: uuid.NewString()}
	project, task1, task2, task3 := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	one, err := a.AcquireUploadLease(t.Context(), user, project, task1)
	if err != nil {
		t.Fatal(err)
	}
	two, err := b.AcquireUploadLease(t.Context(), user, project, task2)
	if err != nil {
		t.Fatal(err)
	}
	_, err = b.AcquireUploadLease(t.Context(), user, project, task3)
	requireFault(t, err, "resource_busy")
	_, err = b.AcquireUploadLease(t.Context(), other, project, task1)
	requireFault(t, err, "resource_busy")
	independent, err := b.AcquireUploadLease(t.Context(), other, project, task3)
	if err != nil {
		t.Fatal(err)
	}
	if err := independent.Close(); err != nil {
		t.Fatal(err)
	}
	if err := one.Close(); err != nil {
		t.Fatal(err)
	}
	reacquired, err := b.AcquireUploadLease(t.Context(), user, project, task1)
	if err != nil {
		t.Fatal(err)
	}
	if err := reacquired.Close(); err != nil {
		t.Fatal(err)
	}
	if err := two.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAdmittedPutFromRequiresLiveLeaseAndBoundsContent(t *testing.T) {
	attachments, m, files, task, p := attachmentUnit(t)
	namespace := transferNamespace(t)
	private, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer private.Close()
	expectTransferAdmission(m, p, task, "file")
	admission, err := attachments.AdmitTransfer(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	lease, err := attachments.AcquireUploadLease(t.Context(), p, task.ProjectID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	source := func(store.AttachmentMutationScope) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader(strings.Repeat("x", int(attachmentcore.MaxFileBytes)+1))), nil
	}
	if _, _, err := admission.PutFromWithLease(t.Context(), lease, source); err == nil {
		t.Fatal("closed lease accepted")
	}
	expectTransferMutation(m, task, "file", store.Completion{Outcome: store.TransactionNotCommitted})
	_, _, err = admission.PutFrom(t.Context(), source)
	requireFault(t, err, "payload_too_large")
	if FileEffectPossible(err) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatalf("wrong publication: %v", err)
	}
	requireTransferMissing(t, files, task, "file")
}

type poolCapacity struct {
	store.SnapshotReader
	max int
}

func (p poolCapacity) MaxConnections() int { return p.max }

func TestUploadInstanceCapacityFromPool(t *testing.T) {
	for _, test := range []struct{ max, want int }{{1, 1}, {2, 1}, {4, 2}, {8, 4}, {20, 4}} {
		a := NewAttachments(poolCapacity{max: test.max}, nil, nil)
		if got := cap(a.uploadSlots); got != test.want {
			t.Fatalf("pool %d: slots=%d", test.max, got)
		}
	}
}
