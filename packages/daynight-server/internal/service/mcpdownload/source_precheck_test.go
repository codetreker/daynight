package mcpdownload

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
)

type concurrentOpenDuringPrecheck struct {
	Opener
	lifecycle       *mcptransfer.Lifecycle
	actor           mcptransfer.Actor
	id, bindingPath string
}

func (o concurrentOpenDuringPrecheck) Open(ctx context.Context, _ model.Principal, project, task, path string) (model.Attachment, filestorage.Object, error) {
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
