package mcpdownload

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

type heldInlineSource struct {
	Opener
	entered, release chan struct{}
}

func (h *heldInlineSource) OpenBounded(ctx context.Context, p model.Principal, project, task, path string, limit int) (model.Attachment, filestorage.Object, error) {
	metadata, obj, err := h.Opener.OpenBounded(ctx, p, project, task, path, limit)
	if err == nil {
		obj.Body = &blockedRangeReader{ReadCloser: obj.Body, ctx: ctx, entered: h.entered, release: h.release}
	}
	return metadata, obj, err
}

func TestDownloadRejectsLateContentAfterProjectDeletion(t *testing.T) {
	for _, action := range []string{"inline", "open", "chunk"} {
		t.Run(action, func(t *testing.T) {
			f := newAcceptanceFixture(t)
			f.put(t, []byte("private content"))
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			input := f.input
			input.Action = action
			input.Format = "text"
			input.TransferID = uuid.NewString()
			var service *Service
			switch action {
			case "inline":
				service = New(&heldInlineSource{Opener: f.attachments, entered: entered, release: release}, f.lifecycle, f.files)
			case "open":
				service = New(&heldSource{Opener: f.attachments, opened: entered, release: release}, f.lifecycle, f.files)
			case "chunk":
				input.Action = "open"
				if _, err := f.service.Read(t.Context(), f.actor, input); err != nil {
					t.Fatal(err)
				}
				input.Action, input.Offset = "chunk", "0"
				service = New(f.attachments, f.lifecycle, blockingRange{TransferStorage: f.files, entered: entered, release: release})
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			type result struct {
				data map[string]any
				err  error
			}
			results := make(chan result, 1)
			go func() { data, err := service.Read(ctx, f.actor, input); results <- result{data, err} }()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("download did not reach content barrier")
			}
			receipt, err := projectservice.NewProjects(f.db).Delete(ctx, f.actor.Principal, f.input.ProjectID)
			if err != nil || !receipt.Deleted {
				t.Fatalf("delete: %+v %v", receipt, err)
			}
			once.Do(func() { close(release) })
			select {
			case got := <-results:
				fault, known := operation.KnownFault(got.err)
				if !known || fault.Code != "not_found" || got.data != nil {
					t.Fatalf("late %s returned data: %#v error=%v", action, got.data, got.err)
				}
			case <-ctx.Done():
				t.Fatal("download did not finish after release")
			}
		})
	}
}
