package mcp

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

type scopedUploadFixture struct {
	t     *testing.T
	calls int
}

type refusedUploadRetry struct{ t *testing.T }

func (s refusedUploadRetry) ExecuteScoped(ctx context.Context, auth model.CredentialAuthorization, actor transfer.Actor, project, task string, input mcptransfer.UploadInput) (map[string]any, error) {
	if ctx.Err() != nil || actor.Principal != auth.Principal || project != testProjectID || task != testTargetID || input.Action != "commit" {
		s.t.Fatal("commit retry lost its context or authority")
	}
	return nil, scopeadmission.Require(auth, scopepolicy.AttachmentUpload)
}

func TestScopedUploadCommitRefusalDoesNotAssertUnknownPriorOutcome(t *testing.T) {
	f := newEntryFixture(t)
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"read": scopedTestAuthorization(t, "attachment:read")}}); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedUploadTools(f.entry, refusedUploadRetry{t}); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "commit", "transferId": testProjectID, "totalBytes": "1"}
	result := tagTestCall(t, f.client(t, "2026-07-28", "read"), "task_attachment_put", args)
	env := structured(t, result)
	failure := object(t, env["error"])
	encoded, err := json.Marshal(env)
	if err != nil || !result.IsError || failure["code"] != "insufficient_scope" || failure["writeOutcome"] != nil || env["data"] != nil || strings.Contains(string(encoded), "confirmed") || strings.Contains(string(encoded), "not_committed") {
		t.Fatalf("refusal disclosed or misclassified retry: %s (%v)", encoded, err)
	}
}

func (s *scopedUploadFixture) ExecuteScoped(ctx context.Context, auth model.CredentialAuthorization, actor transfer.Actor, project, task string, input mcptransfer.UploadInput) (map[string]any, error) {
	s.calls++
	if ctx.Err() != nil || actor.Principal != auth.Principal || actor.AuthorityKind != "pat" || actor.AuthorityID != auth.Principal.CredentialID || project != testProjectID || task != testTargetID || input.Action != "chunk" || input.ContentBase64 != "YQ==" {
		s.t.Fatal("upload actor, authority, input or context changed")
	}
	if err := scopeadmission.Require(auth, scopepolicy.AttachmentUpload); err != nil {
		return map[string]any{"writeOutcome": "not_committed"}, err
	}
	return map[string]any{"receipt": "accepted"}, nil
}

func TestScopedUploadToolPreservesDiscoveryAndDenialEnvelope(t *testing.T) {
	legacy := newEntryFixture(t)
	if err := RegisterUploadTools(legacy.entry, &uploadFixture{}); err != nil {
		t.Fatal(err)
	}
	baseline, err := legacy.client(t, "2026-07-28", "alice").ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	f := newEntryFixture(t)
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{
		"upload": scopedTestAuthorization(t, "attachment:upload"),
		"read":   scopedTestAuthorization(t, "attachment:read"),
	}}); err != nil {
		t.Fatal(err)
	}
	ops := &scopedUploadFixture{t: t}
	if err := RegisterScopedUploadTools(f.entry, ops); err != nil {
		t.Fatal(err)
	}
	list, err := f.client(t, "2026-07-28", "upload").ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(baseline)
	after, _ := json.Marshal(list)
	if !reflect.DeepEqual(before, after) || ops.calls != 0 {
		t.Fatal("upload discovery changed or executed business")
	}
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "chunk", "transferId": testProjectID, "chunkId": testTargetID, "offset": "0", "contentBase64": "YQ=="}
	scopedToolCall(t, f.client(t, "2026-07-28", "read"), "task_attachment_put", args, "insufficient_scope", "not_committed")
	scopedToolCall(t, f.client(t, "2026-07-28", "upload"), "task_attachment_put", args, "", "")
	if ops.calls != 2 {
		t.Fatalf("calls=%d", ops.calls)
	}
}

func TestScopedUploadToolRequiresDependenciesAndAuthorization(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := &scopedUploadFixture{t: t}
	if err := RegisterScopedUploadTools(nil, ops); err == nil {
		t.Fatal("nil entry was accepted")
	}
	if err := RegisterScopedUploadTools(fixture.entry, nil); err == nil {
		t.Fatal("nil upload service was registered")
	}
	if err := RegisterScopedUploadTools(fixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "chunk", "transferId": testProjectID, "chunkId": testTargetID, "offset": "0", "contentBase64": "YQ=="}
	scopedToolCall(t, fixture.client(t, "2026-07-28", "alice"), "task_attachment_put", args, "internal_error", "not_committed")
	if ops.calls != 0 {
		t.Fatalf("missing authorization reached upload: %d calls", ops.calls)
	}
}
