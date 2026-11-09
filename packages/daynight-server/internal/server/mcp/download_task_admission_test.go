package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type downloadAdmissionProbe struct {
	store.SnapshotReader
	full, presence atomic.Int64
}

func (s *downloadAdmissionProbe) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	return s.SnapshotReader.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		return fn(downloadAdmissionScope{SnapshotScope: scope, probe: s})
	})
}

type downloadAdmissionScope struct {
	store.SnapshotScope
	probe *downloadAdmissionProbe
}

func (s downloadAdmissionScope) TaskDAO() store.TaskReader {
	return downloadAdmissionTaskReader{TaskReader: s.SnapshotScope.TaskDAO(), probe: s.probe}
}

type downloadAdmissionTaskReader struct {
	store.TaskReader
	probe *downloadAdmissionProbe
}

func (s downloadAdmissionTaskReader) Task(context.Context, string, string) (model.Task, error) {
	s.probe.full.Add(1)
	return model.Task{}, errors.New("full Task read is not permitted in download admission")
}

func (s downloadAdmissionTaskReader) TaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	s.probe.presence.Add(1)
	return s.TaskReader.TaskPresence(ctx, project, task)
}

func TestDownloadAdmissionDoesNotMaterializeTask(t *testing.T) {
	tasks, db, project, _, session := testsupport.TaskService(t)
	task := testsupport.CreateTask(t, tasks, session, project.ID, "large parent")
	id := uuid.NewString()
	hash := sha256.Sum256([]byte(id))
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'test',now())`, id, session.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.PATCredential, UserID: session.UserID, CredentialID: id}
	properties, err := json.Marshal([]any{map[string]any{"url": "https://example.test/", "title": strings.Repeat("p", 2<<20)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(t.Context(), `UPDATE tasks SET description=$2 WHERE id=$1`, task.ID, strings.Repeat("d", 2<<20)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2) ON CONFLICT(task_id,name) DO UPDATE SET value=EXCLUDED.value`, task.ID, string(properties)); err != nil {
		t.Fatal(err)
	}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	lifecycle, err := mcptransfer.New(db, files, files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := lifecycle.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	probe := &downloadAdmissionProbe{SnapshotReader: db}
	attachments := attachment.NewAttachments(probe, db, files)
	if _, _, err := attachments.Put(t.Context(), principal, project.ID, task.ID, "file", "text/plain", strings.NewReader("snapshot")); err != nil {
		t.Fatal(err)
	}
	entry := newEntryFixture(t)
	entry.entry.auth = downloadAuthenticator{principal}
	if err := RegisterDownloadTool(entry.entry, mcpdownload.New(attachments, lifecycle, files)); err != nil {
		t.Fatal(err)
	}
	client := entry.client(t, "2026-07-28", "alice")
	release, err := entry.entry.budget.Acquire(t.Context(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for _, action := range []string{"", "inspect", "open"} {
		input := map[string]any{"projectId": project.ID, "taskId": task.ID, "path": "file"}
		if action != "" {
			input["action"] = action
		}
		if action == "open" {
			input["transferId"] = uuid.NewString()
		}
		out := invitationCall(t, client, "task_attachment_read", input, false)
		encoded, err := json.Marshal(out)
		if err != nil || len(encoded) > 16<<10 {
			t.Fatalf("%s result size=%d err=%v", action, len(encoded), err)
		}
	}
	if probe.full.Load() != 0 || probe.presence.Load() < 3 {
		t.Fatalf("Task reads: full=%d presence=%d", probe.full.Load(), probe.presence.Load())
	}
}
