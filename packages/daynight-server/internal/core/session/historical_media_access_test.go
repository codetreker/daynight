package session

import (
	"bytes"
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func historicalMediaAccess(t *testing.T, f imageRuleFixture) (string, string, *int) {
	t.Helper()
	project, taskID := uuid.NewString(), uuid.NewString()
	f.r.Snapshot.TestExecutionID = ""
	f.r.Snapshot.ClaimID = uuid.NewString()
	f.r.Snapshot.Identity.ProjectID, f.r.Snapshot.Identity.TaskID = project, taskID
	f.r.Snapshot.Lifecycle = "archived"
	for id, resource := range f.d.resources {
		path, err := BlobAddress(project, f.r.Owner, f.r.Snapshot.SessionID, resource.BlobID)
		if err != nil {
			t.Fatal(err)
		}
		object, err := f.files.Open(t.Context(), sessionresource.Bucket, resource.BlobPath)
		if err != nil {
			t.Fatal(err)
		}
		_, putErr := f.files.Put(t.Context(), sessionresource.Bucket, path, object.Body)
		closeErr := object.Body.Close()
		if putErr != nil || closeErr != nil {
			t.Fatal(putErr, closeErr)
		}
		resource.BlobPath = path
		f.d.resources[id] = resource
	}
	current := &TaskAccess{task: task{Worker: &model.WorkerClaim{ClaimID: uuid.NewString(), AgentControlMode: model.AgentControlModeWeb}}}
	calls := new(int)
	f.s.browserRun = func(context.Context, model.Principal, string, string, string, BrowserPurpose, func(*Access) error) error {
		t.Fatal("historical read required current-claim browser admission")
		return nil
	}
	f.s.archiveRun = func(ctx context.Context, p model.Principal, requestedProject, requestedTask, id string, finalize bool, work func(*Access) error) error {
		if finalize || id != f.r.Snapshot.SessionID {
			t.Fatal("historical read changed Session or requested owner finalization", finalize, id)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		*calls++
		op := &Operation{engine: f.s.Engine}
		access := &Access{tx: &operationTx{dao: f.d, op: op}, record: f.r}
		if err := op.BindArchive(access, current, p, requestedProject, requestedTask, false); err != nil {
			return err
		}
		return work(access)
	}
	return project, taskID, calls
}

func TestSavedOriginalUsesHistoricalAccessBeforeAndAfterReading(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	receipt, err := f.complete(t)
	if err != nil {
		t.Fatal(err)
	}
	id := f.r.Snapshot.SessionID
	project, taskID, calls := historicalMediaAccess(t, f)
	// The original upload grants private access to its actor; current execution
	// identity is deliberately different and cannot authorize this saved object.
	data, _, err := f.s.savedResource(t.Context(), f.p, project, taskID, id, receipt.Resource.ResourceID)
	if err != nil || !bytes.Equal(data, raw) || *calls != 2 {
		t.Fatal("historical original lost its two authorization checks", data, *calls, err)
	}
	if _, _, err = f.s.savedResource(t.Context(), f.p, project, uuid.NewString(), id, receipt.Resource.ResourceID); err == nil {
		t.Fatal("historical resource crossed Task identity")
	}
	if len(f.d.leases) != 0 {
		t.Fatal("historical resource leaked its lease")
	}
}

func TestUploadReceiptUsesHistoricalAccessWithoutCurrentExecutionAuthority(t *testing.T) {
	f, original := completedReclaimFixture(t)
	project, taskID, calls := historicalMediaAccess(t, f)
	receipt, err := f.s.GetUpload(t.Context(), f.p, project, taskID, f.r.Snapshot.SessionID, f.spec.UploadID)
	if err != nil || receipt.State != "complete" || receipt.Resource == nil || receipt.Resource.ResourceID != original.Resource.ResourceID || *calls != 1 {
		t.Fatal("historical receipt required a current claim", receipt, *calls, err)
	}
}

func TestHistoricalOperationQueryRetainsUnknownReceiptWithoutCurrentClaim(t *testing.T) {
	f, snapshot := connectFixture(t)
	f.data.Task.Worker.ClaimID = uuid.NewString()
	f.data.Session.Snapshot.Lifecycle = "archived"
	unknown := sp.Operation{Fence: snapshot.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", State: "unknown"}
	f.data.Operation = &store.SessionOperation{SessionID: snapshot.SessionID, OperationID: unknown.OperationID, Receipt: unknown, Hash: []byte("original"), Actor: f.p}
	for range 2 {
		receipt, err := permissionOperation(f, t.Context(), f.p, snapshot, unknown.OperationID)
		if err != nil || receipt.Fence != unknown.Fence || receipt.OperationID != unknown.OperationID || receipt.State != "unknown" {
			t.Fatal("historical query changed the original operation", receipt, err)
		}
	}
	if f.data.Operation.Receipt.State != "unknown" || string(f.data.Operation.Hash) != "original" {
		t.Fatal("historical observation mutated the original operation")
	}
}
