package mcp

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

type scopedDownloadFixture struct {
	auth  model.CredentialAuthorization
	calls int
}

type unscopedDownloadFixture struct{ scopedDownloadFixture }

func (*unscopedDownloadFixture) Scoped() bool { return false }

func (s *scopedDownloadFixture) Scoped() bool { return true }
func (s *scopedDownloadFixture) Read(_ context.Context, actor mcptransfer.Actor, _ mcpdownload.Input) (map[string]any, error) {
	s.calls++
	if actor.Principal != s.auth.Principal {
		return nil, model.Unauthenticated(nil)
	}
	if err := scopeadmission.Require(s.auth, scopepolicy.AttachmentRead); err != nil {
		return nil, err
	}
	return map[string]any{"contentIncluded": false}, nil
}
func (s *scopedDownloadFixture) ReadAdmitted(ctx context.Context, actor mcptransfer.Actor, in mcpdownload.Input, _ func(context.Context) error) (map[string]any, error) {
	return s.Read(ctx, actor, in)
}

func TestScopedDownloadToolPreservesDiscoveryAndRefusal(t *testing.T) {
	legacy := newEntryFixture(t)
	ops := &scopedDownloadFixture{auth: scopedTestAuthorization(t, "attachment:read")}
	if err := RegisterDownloadTool(legacy.entry, ops); err != nil {
		t.Fatal(err)
	}
	baseline, err := legacy.client(t, "2026-07-28", "alice").ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	f := newEntryFixture(t)
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"read": ops.auth}}); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedDownloadTool(f.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "read")
	listing, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(baseline)
	after, _ := json.Marshal(listing)
	if !reflect.DeepEqual(before, after) || ops.calls != 0 {
		t.Fatal("download discovery changed or invoked business")
	}
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "file", "action": "inspect"}
	if result := tagTestCall(t, client, "task_attachment_read", args); result.IsError {
		t.Fatal(structured(t, result))
	}
	ops.auth = scopedTestAuthorization(t, "attachment:upload")
	result := tagTestCall(t, client, "task_attachment_read", args)
	env := structured(t, result)
	if !result.IsError || object(t, env["error"])["code"] != "insufficient_scope" || env["data"] != nil {
		t.Fatal(env)
	}
}

func TestScopedDownloadToolRequiresScopedServiceAndAuthorization(t *testing.T) {
	fixture := newEntryFixture(t)
	if err := RegisterScopedDownloadTool(fixture.entry, nil); err == nil {
		t.Fatal("nil download service was registered")
	}
	if err := RegisterScopedDownloadTool(fixture.entry, &unscopedDownloadFixture{}); err == nil {
		t.Fatal("legacy download service was registered as scoped")
	}
	if err := RegisterScopedDownloadTool(nil, &scopedDownloadFixture{}); err == nil {
		t.Fatal("nil entry was accepted")
	}
	ops := &scopedDownloadFixture{auth: scopedTestAuthorization(t, "attachment:read")}
	if err := RegisterScopedDownloadTool(fixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	// Legacy authentication supplies no policy snapshot to the scoped tool.
	result := tagTestCall(t, fixture.client(t, "2026-07-28", "alice"), "task_attachment_read", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "file", "action": "inspect"})
	env := structured(t, result)
	if !result.IsError || object(t, env["error"])["code"] != "internal_error" || env["data"] != nil || ops.calls != 0 {
		t.Fatalf("missing authorization reached download: %v calls=%d", env, ops.calls)
	}
}
