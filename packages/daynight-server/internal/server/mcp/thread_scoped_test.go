package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type scopedThreadTestOps struct {
	t            *testing.T
	posts, reads int
}

func (s *scopedThreadTestOps) List(ctx context.Context, a model.CredentialAuthorization, project, task string, _ service.ThreadListRequest) (service.ThreadPageDocument, error) {
	s.reads++
	return service.ThreadPageDocument{}, scopeadmission.Require(a, scopepolicy.ThreadRead)
}
func (s *scopedThreadTestOps) Post(ctx context.Context, a model.CredentialAuthorization, project, task string, input service.CreateThreadMessage) (service.ThreadMessageDocument, error) {
	s.posts++
	if err := scopeadmission.Require(a, scopepolicy.ThreadPost); err != nil {
		return service.ThreadMessageDocument{}, err
	}
	if !input.AutoReceipt || input.Body != "new" || project != testProjectID || task != testTargetID {
		s.t.Fatal("post input changed")
	}
	data := `{"projectId":"` + project + `","taskId":"` + task + `","messageId":"` + testUserID + `"}`
	if scopeadmission.Require(a, scopepolicy.ThreadRead) == nil {
		data = `{"id":"` + testUserID + `","body":"new"}`
	}
	return service.ThreadMessageDocument{Message: model.ThreadMessage{ID: testUserID}, JSON: []byte(data)}, nil
}

func TestScopedThreadMCPWriteOnlyReceipt(t *testing.T) {
	f := newEntryFixture(t)
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"post": scopedTestAuthorization(t, "thread:post"), "both": scopedTestAuthorization(t, "thread:post", "thread:read")}}); err != nil {
		t.Fatal(err)
	}
	ops := &scopedThreadTestOps{t: t}
	if err := RegisterScopedThreadTools(f.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := &structClient{t: t, client: f.client(t, "2026-07-28", "post")}
	v := client.call("task_thread_post", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "body": "new"}, false)
	data := object(t, v["data"])
	if len(data) != 3 || data["messageId"] != testUserID || object(t, v["meta"])["writeOutcome"] != "confirmed" {
		raw, _ := json.Marshal(v)
		t.Fatal(string(raw))
	}
	v = client.call("task_thread_read", map[string]any{"projectId": testProjectID, "taskId": testTargetID}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" || v["data"] != nil || ops.posts != 1 || ops.reads != 1 {
		t.Fatalf("read: %#v", v)
	}
	both := &structClient{t: t, client: f.client(t, "2026-07-28", "both")}
	v = both.call("task_thread_post", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "body": "new"}, false)
	if data := object(t, v["data"]); data["id"] != testUserID || data["body"] != "new" {
		t.Fatalf("legacy post response: %#v", v)
	}
}
