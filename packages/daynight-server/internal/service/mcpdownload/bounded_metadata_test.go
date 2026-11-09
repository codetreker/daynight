package mcpdownload

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
)

type concurrentOpenDuringPrecheck struct {
	Opener
	lifecycle       *mcptransfer.Lifecycle
	actor           mcptransfer.Actor
	id, bindingPath string
}

func (o concurrentOpenDuringPrecheck) OpenBounded(ctx context.Context, _ model.Principal, project, task, path string, _ int) (model.Attachment, filestorage.Object, error) {
	_, _, err := o.lifecycle.OpenRecord(ctx, o.actor, mcptransfer.Binding{ID: o.id, Direction: "download", ProjectID: project, TaskID: task, Path: o.bindingPath})
	if err != nil {
		return model.Attachment{}, filestorage.Object{}, err
	}
	return model.Attachment{}, filestorage.Object{}, &model.Fault{Code: "resource_conflict", Message: "Source changed while opening."}
}
func TestConcurrentOpenAppearingDuringFailedPrecheck(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(fmt.Sprintf("same_binding=%v", same), func(t *testing.T) {
			f := newFixture(t)
			in := f.input
			in.Action = "open"
			in.TransferID = uuid.NewString()
			path := in.Path
			if !same {
				path = "other"
			}
			f.service.attachments = concurrentOpenDuringPrecheck{Opener: f.service.attachments, lifecycle: f.lifecycle, actor: f.actor, id: in.TransferID, bindingPath: path}
			r, err := f.service.Read(t.Context(), f.actor, in)
			if same {
				if err != nil || r["state"] != "preparing" || r["transferId"] != in.TransferID {
					t.Fatalf("existing result: %#v %v", r, err)
				}
			} else if !errors.Is(err, mcptransfer.ErrConflict) {
				t.Fatalf("binding conflict: %#v %v", r, err)
			}
		})
	}
}

type changedAfterPrecheck struct {
	Opener
	db    *postgres.Store
	calls atomic.Int32
}

func (o *changedAfterPrecheck) OpenBounded(ctx context.Context, p model.Principal, project, task, path string, limit int) (model.Attachment, filestorage.Object, error) {
	if o.calls.Add(1) == 2 {
		_, err := o.db.Pool.Exec(ctx, `UPDATE task_attachments SET content_type=$3 WHERE project_id=$1 AND task_id=$2`, project, task, "text/plain; x="+strings.Repeat("a", limit))
		if err != nil {
			return model.Attachment{}, filestorage.Object{}, err
		}
	}
	return o.Opener.OpenBounded(ctx, p, project, task, path, limit)
}

func TestMetadataChangeAfterPrecheckIsRejectedAndReclaimed(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("content"))
	f.service.attachments = &changedAfterPrecheck{Opener: f.service.attachments, db: f.db}
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	result, err := f.service.Read(t.Context(), f.actor, in)
	var fault *model.Fault
	if result != nil || !errors.As(err, &fault) || fault.Code != "resource_conflict" {
		t.Fatalf("metadata race: %#v %v", result, err)
	}
	observed, err := f.lifecycle.LookupBound(t.Context(), f.actor, in.TransferID)
	if err != nil || observed.State != "closed" || observed.ReservedBytes != 0 {
		t.Fatalf("cleanup: %+v %v", observed, err)
	}
}

func TestMetadataLimitRejectsBeforeAllocatingTransfer(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("content"))
	oversized := "text/plain; x=" + strings.Repeat("a", 128<<10)
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE task_attachments SET content_type=$3 WHERE project_id=$1 AND task_id=$2`, f.input.ProjectID, f.input.TaskID, oversized); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"inspect", "inline", "open"} {
		in := f.input
		in.Action = action
		in.TransferID = uuid.NewString()
		result, err := f.service.Read(t.Context(), f.actor, in)
		var fault *model.Fault
		if result != nil || !errors.As(err, &fault) || fault.Code != "resource_conflict" || strings.Contains(err.Error(), oversized) {
			t.Fatalf("%s: %#v %v", action, result, err)
		}
	}
	var count int
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM private_transfers`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed opens allocated slots: %d %v", count, err)
	}
}
func TestMetadataLimitBoundaryAndRepeatedOpen(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("content"))
	prefix := "text/plain; x="
	allowed := prefix + strings.Repeat("a", MaxContentTypeBytes-len(prefix))
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE task_attachments SET content_type=$3 WHERE project_id=$1 AND task_id=$2`, f.input.ProjectID, f.input.TaskID, allowed); err != nil {
		t.Fatal(err)
	}
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	first := f.read(t, in)
	attachment := first["attachment"].(map[string]any)
	if attachment["contentType"] != allowed {
		t.Fatal("boundary MIME not preserved")
	}
	oversized := allowed + "a"
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE task_attachments SET content_type=$3 WHERE project_id=$1 AND task_id=$2`, f.input.ProjectID, f.input.TaskID, oversized); err != nil {
		t.Fatal(err)
	}
	again := f.read(t, in)
	if again["sha256"] != first["sha256"] || again["attachment"].(map[string]any)["contentType"] != allowed {
		t.Fatalf("repeat open did not retain snapshot: %#v", again)
	}
	in.Action = "chunk"
	in.Offset = "0"
	if got := f.read(t, in)["text"]; got != "content" {
		t.Fatalf("snapshot content: %v", got)
	}
}
func TestLegacyLongPathWithBoundedMetadata(t *testing.T) {
	f := newFixture(t)
	path := strings.Repeat("dir/", 300) + "file"
	f.input.Path = path
	address, err := attachmentcore.NewAddress(f.input.ProjectID, f.input.TaskID, path)
	if err != nil {
		t.Fatal(err)
	}
	files := f.service.files.(filestorage.Storage)
	if _, err = files.Put(context.Background(), attachmentcore.Bucket, address.StoragePath, strings.NewReader("legacy")); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(t.Context(), `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes,created_at,updated_at) VALUES($1,$2,$3,'text/plain',6,now(),now())`, f.input.ProjectID, f.input.TaskID, path); err != nil {
		t.Fatal(err)
	}
	result := f.read(t, f.input)
	if result["attachment"].(map[string]any)["path"] != path {
		t.Fatal("legacy path changed")
	}
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	f.read(t, in)
	in.Action = "chunk"
	in.Offset = "0"
	if got := f.read(t, in)["text"]; got != "legacy" {
		t.Fatalf("legacy content: %v", got)
	}
}

func TestPathReadLimitCountsUTF8Bytes(t *testing.T) {
	f := newFixture(t)
	in := f.input
	in.Action, in.TransferID = "open", uuid.NewString()
	in.Path = strings.Repeat("界", MaxPathBytes/3+1)
	result, err := f.service.Read(t.Context(), f.actor, in)
	var fault *model.Fault
	if result != nil || !errors.As(err, &fault) || fault.Code != "resource_conflict" || strings.Contains(err.Error(), in.Path) {
		t.Fatalf("oversized path: %#v %v", result, err)
	}
	var count int
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM private_transfers`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("oversized path allocated a slot: %d %v", count, err)
	}
	in.Path = strings.Repeat("a/", 2047) + "ab"
	_, err = f.service.Read(t.Context(), f.actor, in)
	if !errors.As(err, &fault) || fault.Code == "resource_conflict" {
		t.Fatalf("boundary rejected as oversized: %v", err)
	}
}
