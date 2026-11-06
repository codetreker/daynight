package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type downloadBoundedAuthenticator struct{ principal model.Principal }

func (a downloadBoundedAuthenticator) Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error) {
	return a.principal, nil
}

func TestDownloadMetadataAndErrorsAreBounded(t *testing.T) {
	tasks, db, project, _, session := testsupport.TaskService(t)
	task := testsupport.CreateTask(t, tasks, session, project.ID, "bounded download")
	id := uuid.NewString()
	hash := sha256.Sum256([]byte(id))
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'test',now())`, id, session.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.PATCredential, UserID: session.UserID, CredentialID: id}
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
	attachments := attachment.NewAttachments(db, db, files)
	entry := newEntryFixture(t)
	entry.entry.auth = downloadBoundedAuthenticator{principal}
	if err := RegisterDownloadTool(entry.entry, mcpdownload.New(attachments, lifecycle, files)); err != nil {
		t.Fatal(err)
	}
	client := entry.client(t, "2026-07-28", "alice")
	largeRelease, err := entry.entry.budget.Acquire(t.Context(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	defer largeRelease()
	put := func(path, contentType string) {
		t.Helper()
		if _, _, err := attachments.Put(t.Context(), principal, project.ID, task.ID, path, contentType, strings.NewReader("x")); err != nil {
			t.Fatal(err)
		}
	}
	invoke := func(action, path string, wantError bool) map[string]any {
		t.Helper()
		args := map[string]any{"projectId": project.ID, "taskId": task.ID, "path": path}
		if action != "" {
			args["action"] = action
		}
		if action == "open" {
			args["transferId"] = uuid.NewString()
		}
		out := invitationCall(t, client, "task_attachment_read", args, wantError)
		encoded, err := json.Marshal(out)
		if err != nil || len(encoded) > 16<<10 {
			t.Fatalf("%s response exceeds encoded limit: %d %v", action, len(encoded), err)
		}
		return out
	}
	// Go's JSON encoding expands each '<' into six bytes; count the encoded
	// envelope, not only the database field's original byte length.
	put("file", `text/plain; name="`+strings.Repeat("<", 1300)+`"`)
	for _, action := range []string{"", "inspect", "open"} {
		out := invoke(action, "file", false)
		if action != "open" && object(t, out["data"])["contentIncluded"] != false {
			t.Fatalf("inspect included bytes: %#v", out)
		}
	}
	put("file", `text/plain; name="`+strings.Repeat("<", 6000)+`"`)
	for _, action := range []string{"", "inspect", "open"} {
		out := invoke(action, "file", true)
		if object(t, out["error"])["code"] != "resource_conflict" {
			t.Fatalf("oversized metadata needs an explicit refusal: %#v", out)
		}
	}
	longValidPath := strings.TrimSuffix(strings.Repeat(strings.Repeat("<", 90)+"/", 10), "/")
	put(longValidPath, `text/plain; name="`+strings.Repeat("<", 1900)+`"`)
	for _, action := range []string{"", "inspect", "open"} {
		out := invoke(action, longValidPath, true)
		if object(t, out["error"])["code"] != "payload_too_large" {
			t.Fatalf("encoded metadata limit: %#v", out)
		}
	}
	longPath := strings.Repeat("a/", 15000) + "marker"
	for _, action := range []string{"", "inspect", "open"} {
		out := invoke(action, longPath, true)
		if object(t, out["error"])["code"] != "invalid_input" {
			t.Fatalf("oversized path: %#v", out)
		}
		encoded, _ := json.Marshal(out)
		if strings.Contains(string(encoded), "marker") || strings.Contains(string(encoded), strings.Repeat("a/", 100)) {
			t.Fatal("error echoed oversized path")
		}
	}
}

type escapedMetadataReader struct{ count int }

func (s *escapedMetadataReader) Read(_ context.Context, _ mcptransfer.Actor, _ mcpdownload.Input) (map[string]any, error) {
	return map[string]any{"attachment": map[string]any{"path": "file", "contentType": strings.Repeat("<", s.count)}}, nil
}

func TestDownloadEncodedMetadataBudget(t *testing.T) {
	entry := newEntryFixture(t)
	reader := &escapedMetadataReader{}
	if err := RegisterDownloadTool(entry.entry, reader); err != nil {
		t.Fatal(err)
	}
	client := entry.client(t, "2026-07-28", "alice")
	for _, action := range []string{"", "inspect", "open"} {
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "file"}
		if action != "" {
			args["action"] = action
		}
		if action == "open" {
			args["transferId"] = testTeamID
		}
		reader.count = 2000
		out := invitationCall(t, client, "task_attachment_read", args, false)
		encoded, err := json.Marshal(out)
		if err != nil || len(encoded) > 16<<10 {
			t.Fatalf("%s valid output exceeds budget: %d %v", action, len(encoded), err)
		}
		reader.count = 3000
		out = invitationCall(t, client, "task_attachment_read", args, true)
		encoded, err = json.Marshal(out)
		if err != nil || len(encoded) > 16<<10 || object(t, out["error"])["code"] != "payload_too_large" {
			t.Fatalf("%s oversize result: %d %s %v", action, len(encoded), encoded, err)
		}
	}
}

func TestDownloadOverlongPathNeverReachesService(t *testing.T) {
	entry := newEntryFixture(t)
	reader := &downloadTestReader{}
	if err := RegisterDownloadTool(entry.entry, reader); err != nil {
		t.Fatal(err)
	}
	client := entry.client(t, "2026-07-28", "alice")
	for _, action := range []string{"", "inspect", "inline", "open"} {
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": strings.Repeat("界", 1366)}
		if action != "" {
			args["action"] = action
		}
		if action == "open" {
			args["transferId"] = testTeamID
		}
		out := invitationCall(t, client, "task_attachment_read", args, true)
		encoded, err := json.Marshal(out)
		if err != nil || len(encoded) > 16<<10 || object(t, out["error"])["code"] != "invalid_input" || reader.calls != 0 {
			t.Fatalf("%s: oversized path reached service or response: %s %v", action, encoded, err)
		}
	}
}
