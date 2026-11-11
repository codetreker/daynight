package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
)

type downloadTestReader struct {
	actor mcptransfer.Actor
	input mcpdownload.Input
	calls int
	err   error
}

func (s *downloadTestReader) Read(_ context.Context, actor mcptransfer.Actor, input mcpdownload.Input) (map[string]any, error) {
	s.actor, s.input = actor, input
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return map[string]any{"sizeBytes": "4", "contentIncluded": false, "contentRef": map[string]any{"projectId": input.ProjectID, "taskId": input.TaskID, "path": input.Path}}, nil
}
func (s *downloadTestReader) ReadAdmitted(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input, _ func(context.Context) error) (map[string]any, error) {
	return s.Read(ctx, actor, input)
}

type downloadTestOAuth struct{}

func (downloadTestOAuth) AuthenticateAccess(context.Context, string, string) (store.OAuthAccessIdentity, error) {
	return store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: testUserID, CredentialID: testTargetID}, GrantID: testTeamID}, nil
}

func TestDownloadToolContract(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.oauth = downloadTestOAuth{}
	reader := &downloadTestReader{}
	if err := RegisterDownloadTool(f.entry, reader); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	listing, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tool := range listing.Tools {
		if tool.Name == "task_attachment_read" {
			found = true
		}
	}
	if !found {
		t.Fatal("download tool was not discoverable")
	}
	call := func(args map[string]any, wantError bool) map[string]any {
		t.Helper()
		return invitationCall(t, client, "task_attachment_read", args, wantError)
	}
	valid := []struct {
		args map[string]any
		want mcpdownload.Input
	}{
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "a.txt"}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Path: "a.txt"}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "inspect", "path": "a.txt"}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Path: "a.txt", Action: "inspect"}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "inline", "path": "a.txt", "format": "text", "maxBytes": 13}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Path: "a.txt", Action: "inline", Format: "text", MaxBytes: 13}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "open", "path": "a.txt", "transferId": testTeamID}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Path: "a.txt", Action: "open", TransferID: testTeamID}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "chunk", "transferId": testTeamID, "offset": "9007199254740993", "maxBytes": 524288, "format": "base64"}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Action: "chunk", TransferID: testTeamID, Offset: "9007199254740993", Format: "base64", MaxBytes: 524288}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "close", "transferId": testTeamID}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Action: "close", TransferID: testTeamID}},
	}
	for _, tc := range valid {
		out := call(tc.args, false)
		if reader.input != tc.want {
			t.Fatalf("input lost or changed: got %+v, want %+v", reader.input, tc.want)
		}
		data, meta := object(t, out["data"]), object(t, out["meta"])
		if data["sizeBytes"] != "4" || data["contentIncluded"] != false || meta["requestId"] != "test-request" {
			t.Fatalf("response: %#v", out)
		}
		if reader.actor.Principal.UserID != "alice" || reader.actor.AuthorityKind != "pat" || reader.actor.AuthorityID != "credential-alice" {
			t.Fatalf("PAT actor: %+v", reader.actor)
		}
	}
	invalid := []map[string]any{
		{"projectId": testProjectID, "taskId": testTargetID},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "open", "path": "a.txt"},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "chunk", "transferId": testTeamID, "offset": "01"},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "chunk", "transferId": testTeamID, "offset": "0", "maxBytes": 524289},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "inline", "path": "a.txt", "format": "binary"},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "close", "transferId": testTeamID, "path": "a.txt"},
	}
	for _, args := range invalid {
		before := reader.calls
		out := call(args, true)
		if object(t, out["error"])["code"] != "invalid_input" || reader.calls != before {
			t.Fatalf("invalid input reached service: args=%v result=%v", args, out)
		}
	}
	reader.err = &model.Fault{Code: "forbidden", Message: "Access denied."}
	out := call(valid[4].args, true)
	failure := object(t, out["error"])
	refs := object(t, failure["refs"])
	if failure["code"] != "forbidden" || failure["requestId"] != "test-request" || failure["writeOutcome"] != nil || refs["transferId"] != testTeamID {
		t.Fatalf("error envelope: %#v", failure)
	}
	reader.err = nil
	oauth := f.client(t, "2025-11-25", model.OAuthAccessPrefix+"test")
	invitationCall(t, oauth, "task_attachment_read", valid[0].args, false)
	if reader.actor.Principal.CredentialID != testTargetID || reader.actor.AuthorityKind != "oauth" || reader.actor.AuthorityID != testTeamID {
		t.Fatalf("OAuth grant identity lost: %+v", reader.actor)
	}
}

func TestDownloadToolBudget(t *testing.T) {
	f := newEntryFixture(t)
	reader := &downloadTestReader{}
	if err := RegisterDownloadTool(f.entry, reader); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	release, err := f.entry.budget.Acquire(t.Context(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for _, action := range []string{"inspect", "open", "close", "inline", "chunk"} {
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": action}
		switch action {
		case "inspect", "inline":
			args["path"] = "a.txt"
		case "open":
			args["path"], args["transferId"] = "a.txt", testTeamID
		case "close":
			args["transferId"] = testTeamID
		case "chunk":
			args["transferId"], args["offset"] = testTeamID, "0"
		}
		busy := action == "inline" || action == "chunk"
		before := reader.calls
		out := invitationCall(t, client, "task_attachment_read", args, busy)
		if busy && (object(t, out["error"])["code"] != "resource_busy" || reader.calls != before) {
			t.Fatalf("%s did not respect large budget: %#v", action, out)
		}
		if !busy && reader.calls != before+1 {
			t.Fatalf("%s did not use independent control budget", action)
		}
	}
}

func TestInspectUsesContentBudget(t *testing.T) {
	f := newEntryFixture(t)
	reader := &downloadTestReader{}
	if err := RegisterDownloadTool(f.entry, reader); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		release, err := f.entry.budget.Acquire(t.Context(), BudgetContent)
		if err != nil {
			t.Fatal(err)
		}
		defer release()
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, action := range []string{"", "inspect"} {
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "a.txt"}
		if action != "" {
			args["action"] = action
		}
		out := invitationCall(t, client, "task_attachment_read", args, true)
		if object(t, out["error"])["code"] != "resource_busy" || reader.calls != 0 {
			t.Fatalf("inspect admission: %#v", out)
		}
	}
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "close", "transferId": testTeamID}
	invitationCall(t, client, "task_attachment_read", args, false)
}

func TestDownloadToolRegistration(t *testing.T) {
	f := newEntryFixture(t)
	if err := RegisterDownloadTool(f.entry, nil); err == nil {
		t.Fatal("nil download service accepted")
	}
	original := downloadToolsJSON
	t.Cleanup(func() { downloadToolsJSON = original })
	for _, definition := range []string{"[", "[]", `[{"name":"other"}]`} {
		downloadToolsJSON = []byte(definition)
		if err := RegisterDownloadTool(f.entry, &downloadTestReader{}); err == nil {
			t.Fatalf("invalid definition accepted: %s", definition)
		}
	}
}

// TestMCPDownloadSnapshotWithRealServices exercises the file lifecycle through
// the MCP adapter and the attachment and transfer services.
func TestMCPDownloadSnapshotWithRealServices(t *testing.T) {
	database := newTransferTestStore(t)
	files := attachmentTestFiles(t)
	principals := []model.Principal{defaultHTTPPrincipal(), {UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}}
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	server := newTransferAdapterHost(t, database, files, map[string]model.Principal{tokens[0]: principals[0], tokens[1]: principals[1]}, "upload", "download")
	alice, bob := mcpPATClient(t, server.URL, tokens[0]), mcpPATClient(t, server.URL, tokens[1])
	projectID := "f6666666-6666-4666-8666-666666666666"
	taskID := "b8888888-8888-4888-8888-888888888888"
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	uploadMetadata := model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "upload.txt", ContentType: "text/plain", SizeBytes: 5, CreatedAt: at, UpdatedAt: at}
	mcpIsolationInline(t, database, principals[0], uploadMetadata, true)
	upload := invitationCall(t, alice, "task_attachment_put", map[string]any{"projectId": projectID, "taskId": taskID, "action": "inline", "path": "upload.txt", "contentType": "text/plain", "contentBase64": "aGVsbG8="}, false)
	data := object(t, upload["data"])
	if data["writeOutcome"] != "confirmed" || data["created"] != true {
		t.Fatalf("upload receipt: %#v", upload)
	}
	address, err := attachmentcore.NewAddress(projectID, taskID, "upload.txt")
	if err != nil {
		t.Fatal(err)
	}
	file, err := files.Open(t.Context(), attachmentcore.Bucket, address.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(file.Body)
	closeErr := file.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != "hello" || file.Info.Size != 5 {
		t.Fatalf("uploaded content=%q info=%#v read=%v close=%v", content, file.Info, readErr, closeErr)
	}
	attachments := attachmentservice.NewAttachments(database, database, files)
	sample := model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "sample.txt", ContentType: "text/plain", SizeBytes: 13, CreatedAt: at, UpdatedAt: at}
	put := func(content string) {
		t.Helper()
		item := sample
		item.SizeBytes = int64(len(content))
		isNew := content == "first content"
		if !isNew {
			item.UpdatedAt = item.UpdatedAt.Add(time.Second)
		}
		mcpIsolationInline(t, database, principals[0], item, isNew)
		if _, _, err := attachments.Put(t.Context(), principals[0], projectID, taskID, "sample.txt", "text/plain", strings.NewReader(content)); err != nil {
			t.Fatal(err)
		}
	}
	put("first content")
	base := map[string]any{"projectId": projectID, "taskId": taskID, "path": "sample.txt"}
	mcpIsolationSource(t, database, principals[0], sample, 1)
	mcpTransferPlan(t, database, mcpIsolationAuthorize(t, principals[0], projectID, taskID, 1), mcpIsolationAuthorize(t, principals[0], projectID, taskID, 1))
	inspect := object(t, invitationCall(t, alice, "task_attachment_read", base, false)["data"])
	if inspect["contentIncluded"] != false || inspect["sizeBytes"] != "13" || inspect["contentRef"] == nil {
		t.Fatalf("attachment inspect: %#v", inspect)
	}
	transferID := uuid.NewString()
	open := map[string]any{"projectId": projectID, "taskId": taskID, "path": "sample.txt", "action": "open", "transferId": transferID}
	readable := mcpIsolationDownloadOpen(t, database, principals[0], sample, transferID, time.Now().UTC())
	opened := object(t, invitationCall(t, alice, "task_attachment_read", open, false)["data"])
	if opened["transferId"] != transferID || opened["state"] != "readable" || opened["totalBytes"] != "13" || opened["sha256"] == nil {
		t.Fatalf("attachment open: %#v", opened)
	}
	put("replacement")
	chunk := map[string]any{"projectId": projectID, "taskId": taskID, "action": "chunk", "transferId": transferID, "offset": "0", "format": "base64"}
	touched := mcpIsolationDownloadChunk(t, database, principals[0], readable)
	downloadData := object(t, invitationCall(t, alice, "task_attachment_read", chunk, false)["data"])
	if downloadData["contentBase64"] != base64.StdEncoding.EncodeToString([]byte("first content")) || downloadData["nextOffset"] != "13" || downloadData["eof"] != true {
		t.Fatalf("attachment snapshot: %#v", downloadData)
	}
	mcpTransferPlan(t, database, mcpTransferRead(t, principals[1], 0, 0, mcpTransferRow(touched)))
	if value := invitationCall(t, bob, "task_attachment_read", chunk, true); value["error"] == nil {
		t.Fatalf("unauthorized snapshot: %#v", value)
	}
	closeInput := map[string]any{"projectId": projectID, "taskId": taskID, "action": "close", "transferId": transferID}
	mcpIsolationDownloadClose(t, database, principals[0], touched)
	closed := object(t, invitationCall(t, alice, "task_attachment_read", closeInput, false)["data"])
	if closed["state"] != "cleanup_pending" || closed["cleanupState"] != "pending" {
		t.Fatalf("attachment close: %#v", closed)
	}
}

func mcpIsolationSource(t *testing.T, tx *transferTestStore, p model.Principal, item model.Attachment, n int) {
	counts := newHTTPCallPlan(t, map[string]int{"source snapshot": n, "source access": n, "source presence": n, "source metadata": n})
	scope := newTransferTestSnapshot(t)
	scope.Projects = mcpOrgProjectReader{t: t, ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		counts.Called("source access")
		mcpAttachmentCheck(t, actor, p)
		mcpAttachmentCheck(t, id, item.ProjectID)
		return model.ProjectAccess{ProjectID: item.ProjectID, UserID: p.UserID, Role: model.ProjectAdmin}, nil
	}}
	scope.Tasks = &mcpAttachmentTaskReader{t: t, PresenceCall: func(ctx context.Context, pid, id string) (store.TaskPresence, error) {
		counts.Called("source presence")
		mcpAttachmentCheck(t, []string{pid, id}, []string{item.ProjectID, item.TaskID})
		return store.TaskPresence{Found: true}, nil
	}}
	scope.Attachments = &mcpAttachmentDAO{t: t, AttachmentCall: func(ctx context.Context, pid, id, path string) (model.Attachment, error) {
		counts.Called("source metadata")
		mcpAttachmentCheck(t, []string{pid, id, path}, []string{item.ProjectID, item.TaskID, item.Path})
		return item, nil
	}}
	tx.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		counts.Called("source snapshot")
		return fn(scope)
	}
}
func mcpIsolationAuthorize(t *testing.T, p model.Principal, project, task string, n int) *mcpTransferDAO {
	counts := newHTTPCallPlan(t, map[string]int{"authority": n})
	return &mcpTransferDAO{t: t, AuthorizeCall: func(ctx context.Context, actual model.Principal, kind, id, pid, tid string) error {
		counts.Called("authority")
		mcpAttachmentCheck(t, actual, p)
		mcpAttachmentCheck(t, []string{kind, id, pid, tid}, []string{"pat", p.CredentialID, project, task})
		return nil
	}}
}
func mcpIsolationPut(t *testing.T, dao *mcpTransferDAO, before, after model.PrivateTransfer) {
	counts := newHTTPCallPlan(t, map[string]int{"put": 1})
	dao.PutCall = func(ctx context.Context, input model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
		counts.Called("put")
		mcpAttachmentCheck(t, version, before.Version)
		mcpAttachmentCheck(t, []string{input.ID, input.UserID, input.AuthorityKind, input.AuthorityID, input.Direction, input.ProjectID, input.TaskID, input.Path, input.ContentType, input.State}, []string{after.ID, after.UserID, after.AuthorityKind, after.AuthorityID, after.Direction, after.ProjectID, after.TaskID, after.Path, after.ContentType, after.State})
		mcpAttachmentCheck(t, []int64{input.ReservedBytes, input.OutstandingBytes, input.Version}, []int64{after.ReservedBytes, after.OutstandingBytes, before.Version})
		var got, want any
		if json.Unmarshal(input.Data, &got) != nil || json.Unmarshal(after.Data, &want) != nil {
			unexpectedHTTPCall(t, "private snapshot data JSON")
		}
		mcpAttachmentCheck(t, got, want)
		mcpAttachmentCheck(t, input.Binding, after.Binding)
		if input.UpdatedAt.IsZero() || input.UpdatedAt.Location() != time.UTC || input.ExpiresAt.Before(input.UpdatedAt) || input.HardExpiresAt != after.HardExpiresAt {
			unexpectedHTTPCall(t, "private snapshot time fields")
		}
		return mcpCloneFixture(after), nil
	}
}
func mcpIsolationRenew(t *testing.T, p model.Principal, before, after model.PrivateTransfer) *mcpTransferDAO {
	dao := mcpTransferRead(t, p, 1, 0, mcpTransferRow(before), mcpTransferRow(before))
	mcpIsolationPut(t, dao, before, after)
	return dao
}
func mcpIsolationDownloadRows(p model.Principal, item model.Attachment, id string, now time.Time) (model.PrivateTransfer, model.PrivateTransfer, model.PrivateTransfer, model.PrivateTransfer, model.PrivateTransfer) {
	initial := model.PrivateTransfer{ID: id, UserID: p.UserID, AuthorityKind: "pat", AuthorityID: p.CredentialID, Direction: "download", ProjectID: item.ProjectID, TaskID: item.TaskID, Path: item.Path, Binding: json.RawMessage(`{}`), Data: json.RawMessage(`{}`), State: "preparing", Version: 1, CreatedAt: now, UpdatedAt: now, ExpiresAt: now.Add(time.Hour), HardExpiresAt: now.Add(24 * time.Hour)}
	acquired := initial
	acquired.Version = 2
	reserved := acquired
	reserved.Version = 3
	reserved.ReservedBytes = 13
	reserved.OutstandingBytes = 13
	materialized := reserved
	materialized.Version = 4
	materialized.OutstandingBytes = 0
	digest := sha256.Sum256([]byte("first content"))
	data, _ := json.Marshal(struct {
		Attachment model.Attachment `json:"attachment"`
		ObjectID   string           `json:"objectId"`
		TotalBytes int64            `json:"totalBytes"`
		SHA256     string           `json:"sha256"`
		Text       bool             `json:"text"`
	}{item, id, 13, hex.EncodeToString(digest[:]), true})
	readable := materialized
	readable.Version = 5
	readable.State = "readable"
	readable.Data = data
	return initial, acquired, reserved, materialized, readable
}
func mcpIsolationDownloadOpen(t *testing.T, tx *transferTestStore, p model.Principal, item model.Attachment, id string, now time.Time) model.PrivateTransfer {
	mcpIsolationSource(t, tx, p, item, 2)
	initial, acquired, reserved, materialized, readable := mcpIsolationDownloadRows(p, item, id, now)
	creation := mcpTransferMissing(t, id)
	c := newHTTPCallPlan(t, map[string]int{"insert": 1, "ledger": 1, "active": 1, "authorize": 1})
	creation.AuthorizeCall = func(ctx context.Context, actual model.Principal, kind, cid, pid, tid string) error {
		c.Called("authorize")
		mcpAttachmentCheck(t, actual, p)
		mcpAttachmentCheck(t, []string{kind, cid, pid, tid}, []string{"pat", p.CredentialID, item.ProjectID, item.TaskID})
		return nil
	}
	creation.InsertCall = func(ctx context.Context, input model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
		c.Called("insert")
		mcpAttachmentCheck(t, []string{input.ID, input.UserID, input.AuthorityKind, input.AuthorityID, input.Direction, input.ProjectID, input.TaskID, input.Path, input.ContentType, input.State}, []string{id, p.UserID, "pat", p.CredentialID, "download", item.ProjectID, item.TaskID, item.Path, "", "preparing"})
		mcpAttachmentCheck(t, []int64{input.ReservedBytes, input.OutstandingBytes}, []int64{0, 0})
		mcpAttachmentCheck(t, input.Binding, json.RawMessage(`{}`))
		return mcpCloneFixture(initial), true, nil
	}
	creation.LockLedgerCall = func(context.Context) error { c.Called("ledger"); return nil }
	creation.CountActiveCall = func(ctx context.Context, owner string) (int, error) {
		c.Called("active")
		mcpAttachmentCheck(t, owner, p.UserID)
		return 1, nil
	}
	reservation := mcpTransferRead(t, p, 1, 0, mcpTransferRow(acquired), mcpTransferRow(acquired))
	rc := newHTTPCallPlan(t, map[string]int{"ledger": 2, "outstanding": 1, "reserved": 1, "add": 1})
	reservation.LockLedgerCall = func(context.Context) error { rc.Called("ledger"); return nil }
	reservation.OutstandingTotalCall = func(context.Context) (int64, error) { rc.Called("outstanding"); return 0, nil }
	reservation.ReservedTotalCall = func(context.Context) (int64, error) { rc.Called("reserved"); return 0, nil }
	reservation.AddReservationCall = func(ctx context.Context, got string, n int64) (model.PrivateTransfer, error) {
		rc.Called("add")
		mcpAttachmentCheck(t, got, id)
		mcpAttachmentCheck(t, n, int64(13))
		return mcpCloneFixture(reserved), nil
	}
	publication := mcpTransferRead(t, p, 1, 0, mcpTransferRow(reserved), mcpTransferRow(reserved), mcpTransferRow(materialized))
	pc := newHTTPCallPlan(t, map[string]int{"ledger": 1, "consume": 1})
	publication.LockLedgerCall = func(context.Context) error { pc.Called("ledger"); return nil }
	publication.SubtractOutstandingCall = func(ctx context.Context, got string, n int64) (model.PrivateTransfer, error) {
		pc.Called("consume")
		mcpAttachmentCheck(t, got, id)
		mcpAttachmentCheck(t, n, int64(13))
		return mcpCloneFixture(materialized), nil
	}
	mcpIsolationPut(t, publication, materialized, readable)
	mcpTransferPlan(t, tx, mcpTransferMissing(t, id), mcpIsolationAuthorize(t, p, item.ProjectID, item.TaskID, 1), creation, mcpIsolationRenew(t, p, initial, acquired), mcpIsolationAuthorize(t, p, item.ProjectID, item.TaskID, 1), reservation, publication)
	return readable
}
func mcpIsolationDownloadChunk(t *testing.T, tx *transferTestStore, p model.Principal, readable model.PrivateTransfer) model.PrivateTransfer {
	acquired := readable
	acquired.Version++
	touched := acquired
	touched.Version++
	mcpTransferPlan(t, tx, mcpTransferRead(t, p, 1, 0, mcpTransferRow(readable)), mcpIsolationRenew(t, p, readable, acquired), mcpTransferRead(t, p, 1, 0, mcpTransferRow(acquired)), mcpIsolationRenew(t, p, acquired, touched))
	return touched
}
func mcpIsolationDownloadClose(t *testing.T, tx *transferTestStore, p model.Principal, readable model.PrivateTransfer) {
	pending := readable
	pending.Version++
	pending.State = "cleanup_pending"
	previous := "readable"
	pending.CleanupFromState = &previous
	dao := mcpTransferRead(t, p, 1, 0, mcpTransferRow(readable), mcpTransferRow(readable))
	mcpIsolationPut(t, dao, readable, pending)
	mcpTransferPlan(t, tx, mcpTransferRead(t, p, 1, 0, mcpTransferRow(readable)), dao)
}

func mcpIsolationInline(t *testing.T, tx *transferTestStore, p model.Principal, item model.Attachment, created bool) {
	mcpAttachmentRead(t, tx, p, item.ProjectID, item.TaskID, &mcpAttachmentDAO{t: t})
	calls := newHTTPCallPlan(t, map[string]int{"conflict": 1, "metadata": 1})
	dao := &mcpAttachmentDAO{t: t, ConflictCall: func(ctx context.Context, pid, tid string, q store.AttachmentConflictQuery) (bool, error) {
		calls.Called("conflict")
		mcpAttachmentCheck(t, []string{pid, tid}, []string{item.ProjectID, item.TaskID})
		mcpAttachmentCheck(t, q, store.AttachmentConflictQuery{Ancestors: []string{}, DescendantPrefix: item.Path + "/"})
		return false, nil
	}, PutCall: func(ctx context.Context, input model.Attachment) (model.Attachment, bool, error) {
		calls.Called("metadata")
		mcpAttachmentCheck(t, []string{input.ProjectID, input.TaskID, input.Path, input.ContentType}, []string{item.ProjectID, item.TaskID, item.Path, item.ContentType})
		mcpAttachmentCheck(t, input.SizeBytes, item.SizeBytes)
		return item, created, nil
	}}
	mcpAttachmentMutation(t, tx, p, item.ProjectID, item.TaskID, dao, false)
}
