package mcptransfer

import (
	"context"
	"encoding/base64"
	"errors"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/google/uuid"
)

type unavailableProjectFiles struct {
	filestorage.Storage
	filestorage.TransferStorage
}

type unavailableProjectAttachments struct {
	store.ProjectReader
	t       *testing.T
	ctx     context.Context
	actor   model.Principal
	project string
	task    string
	active  string
	events  []string
}

type unavailableProjectSnapshot struct {
	store.SnapshotScope
	owner *unavailableProjectAttachments
}

func (s unavailableProjectSnapshot) ProjectDAO() store.ProjectReader {
	return s.owner.ProjectDAO()
}

type unavailableProjectMutation struct {
	store.AttachmentMutationScope
	owner *unavailableProjectAttachments
}

func (s unavailableProjectMutation) LockTaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	return s.owner.LockTaskPresence(ctx, project, task)
}

func (s unavailableProjectMutation) ProjectAuthorization(ctx context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
	return s.owner.ProjectAuthorization(ctx, principal, project)
}

func (d *unavailableProjectAttachments) called(ctx context.Context, active, event string) {
	d.t.Helper()
	if ctx != d.ctx || ctx.Err() != nil || d.active != active {
		d.t.Fatalf("%s context/scope: active=%s error=%v", event, d.active, ctx.Err())
	}
	d.events = append(d.events, event)
}

func (d *unavailableProjectAttachments) ReadSnapshot(ctx context.Context, work func(store.SnapshotScope) error) error {
	d.called(ctx, "", "snapshot")
	d.active = "snapshot"
	err := work(unavailableProjectSnapshot{owner: d})
	d.active = ""
	if err != nil {
		d.t.Fatalf("read refusal should be retained outside snapshot: %v", err)
	}
	return nil
}

func (d *unavailableProjectAttachments) ProjectDAO() store.ProjectReader {
	if d.active != "snapshot" {
		d.t.Fatal("project reader accessed outside snapshot")
	}
	return d
}

func (d *unavailableProjectAttachments) ProjectAccess(ctx context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
	d.called(ctx, "snapshot", "read authorization")
	if principal != d.actor || project != d.project {
		d.t.Fatalf("read authorization: %+v project=%s", principal, project)
	}
	return model.ProjectAccess{}, model.ErrNotFound
}

func (d *unavailableProjectAttachments) WriteAttachmentMutation(ctx context.Context, work func(store.AttachmentMutationScope) error) (store.Completion, error) {
	d.called(ctx, "", "mutation")
	d.active = "mutation"
	callbackError := work(unavailableProjectMutation{owner: d})
	d.active = ""
	var fault *model.Fault
	if !errors.Is(callbackError, model.ErrNotFound) || !errors.As(callbackError, &fault) || fault.Code != "not_found" {
		d.t.Fatalf("mutation callback refusal: %v", callbackError)
	}
	completion := store.Completion{Outcome: store.TransactionNotCommitted}
	finalError := &model.Fault{Code: "not_found", Message: "Project is unavailable.", Cause: model.ErrNotFound}
	return completion, finalError
}

func (d *unavailableProjectAttachments) LockTaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	d.called(ctx, "mutation", "presence")
	if project != d.project || task != d.task {
		d.t.Fatalf("mutation presence: %s/%s", project, task)
	}
	return store.TaskPresence{Found: true}, nil
}

func (d *unavailableProjectAttachments) ProjectAuthorization(ctx context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
	d.called(ctx, "mutation", "write authorization")
	if principal != d.actor || project != d.project {
		d.t.Fatalf("write authorization: %+v project=%s", principal, project)
	}
	return model.ProjectAccess{}, model.ErrNotFound
}

func TestUploadActionsRejectUnavailableProject(t *testing.T) {
	for _, action := range []string{"status", "abort", "chunk", "commit", "begin", "inline"} {
		t.Run(action, func(t *testing.T) {
			h := newUploadHarness(t)
			r := h.record("pending.bin", 0)
			r.ContentType = "application/octet-stream"
			files := &unavailableProjectFiles{}
			h.uploads.files, h.lifecycle.files, h.lifecycle.private = files, files, files
			attachmentDAO := &unavailableProjectAttachments{t: t, ctx: t.Context(), actor: h.actor.Principal, project: r.ProjectID, task: r.TaskID}
			h.uploads.attachments = attachmentservice.NewAttachments(attachmentDAO, attachmentDAO, files)
			input := UploadInput{Action: action, TransferID: r.ID}
			switch action {
			case "chunk":
				input.ChunkID, input.Offset, input.ContentBase64 = uuid.NewString(), "0", base64.StdEncoding.EncodeToString([]byte("x"))
			case "commit":
				input.TotalBytes = "0"
			case "begin":
				input.TransferID, input.Path, input.ContentType = uuid.NewString(), "new.bin", "text/plain"
			case "inline":
				input.TransferID = ""
				input.Path, input.ContentType, input.ContentBase64 = "new.bin", "text/plain", base64.StdEncoding.EncodeToString([]byte("x"))
			}
			if action != "inline" {
				first, deniedRecord := get(r), cloneTransfer(r)
				if action == "begin" {
					first, deniedRecord.ID = getMissing(input.TransferID), input.TransferID
				}
				plan := h.db.expect(store.Completion{Outcome: store.TransactionNotCommitted}, nil, first, auth(h.actor, deniedRecord, model.ErrNotFound))
				plan.callbackCheck = func(err error) {
					fault, known := operation.KnownFault(err)
					if !known || fault.Code != "not_found" || !errors.Is(err, model.ErrNotFound) {
						t.Fatalf("transfer callback refusal: %v", err)
					}
				}
			}
			result, err := h.execute(h.actor, input)
			fault, known := operation.KnownFault(err)
			if !known || fault.Code != "not_found" || !errors.Is(err, model.ErrNotFound) || result != nil && result["attachment"] != nil {
				t.Fatalf("unavailable Project %s: result=%+v error=%v", action, result, err)
			}
			if action == "inline" {
				if result["writeOutcome"] != "not_committed" || !slices.Equal(attachmentDAO.events, []string{"snapshot", "read authorization", "mutation", "presence", "write authorization"}) {
					t.Fatalf("inline admission: result=%+v calls=%v", result, attachmentDAO.events)
				}
			} else if len(attachmentDAO.events) != 0 {
				t.Fatalf("transfer refusal called Attachments: %v", attachmentDAO.events)
			}
		})
	}
}
