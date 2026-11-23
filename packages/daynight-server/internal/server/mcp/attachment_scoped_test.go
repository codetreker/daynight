package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

type scopedAttachmentFixture struct {
	t     *testing.T
	calls int
}

func (s *scopedAttachmentFixture) List(ctx context.Context, a model.CredentialAuthorization, project, task string, request model.PageRequest) (attachmentcore.Page, error) {
	s.calls++
	if ctx.Err() != nil || project != testProjectID || task != testTargetID || request.Limit != 7 {
		s.t.Fatal("attachment list context or input changed")
	}
	if err := scopeadmission.Require(a, scopepolicy.AttachmentRead); err != nil {
		return attachmentcore.Page{}, err
	}
	return attachmentcore.Page{Items: []model.Attachment{{Path: "visible.txt", ContentType: "text/plain", SizeBytes: 4}}}, nil
}

func (s *scopedAttachmentFixture) Delete(ctx context.Context, a model.CredentialAuthorization, project, task, path string) error {
	s.calls++
	if ctx.Err() != nil || project != testProjectID || task != testTargetID || path != "visible.txt" {
		s.t.Fatal("attachment deletion context or input changed")
	}
	return scopeadmission.Require(a, scopepolicy.AttachmentDelete)
}

func TestScopedAttachmentToolsAuthenticationDiscoveryAndPermissions(t *testing.T) {
	legacy := newEntryFixture(t)
	if err := RegisterAttachmentTools(legacy.entry, &attachmentTestOperations{}); err != nil {
		t.Fatal(err)
	}
	baseline, err := legacy.client(t, "2026-07-28", "alice").ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	f := newEntryFixture(t)
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{
		"read":   scopedTestAuthorization(t, "attachment:read"),
		"delete": scopedTestAuthorization(t, "attachment:delete"),
		"upload": scopedTestAuthorization(t, "attachment:upload"),
	}}); err != nil {
		t.Fatal(err)
	}
	ops := &scopedAttachmentFixture{t: t}
	if err := RegisterScopedAttachmentTools(f.entry, ops, AttachmentAuthorizationFromActor); err != nil {
		t.Fatal(err)
	}
	listing, err := f.client(t, "2026-07-28", "read").ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(baseline)
	after, _ := json.Marshal(listing)
	if !reflect.DeepEqual(before, after) || ops.calls != 0 {
		t.Fatal("attachment discovery changed or invoked business")
	}
	for _, tc := range []struct {
		token, name string
		allowed     bool
	}{
		{"read", "task_attachment_list", true}, {"read", "task_attachment_remove", false},
		{"delete", "task_attachment_list", false}, {"delete", "task_attachment_remove", true},
		{"upload", "task_attachment_list", false}, {"upload", "task_attachment_remove", false},
	} {
		client := f.client(t, "2026-07-28", tc.token)
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID}
		if tc.name == "task_attachment_list" {
			args["limit"] = 7
		} else {
			args["path"] = "visible.txt"
		}
		result := tagTestCall(t, client, tc.name, args)
		env := structured(t, result)
		if tc.allowed {
			if result.IsError || env["data"] == nil {
				t.Fatalf("%s %s: %v", tc.token, tc.name, env)
			}
		} else {
			failure := object(t, env["error"])
			if !result.IsError || failure["code"] != "insufficient_scope" || env["data"] != nil {
				t.Fatal(env)
			}
			if tc.name == "task_attachment_remove" && failure["writeOutcome"] != "not_committed" {
				t.Fatal(env)
			}
		}
	}
	if ops.calls != 6 {
		t.Fatalf("business calls=%d", ops.calls)
	}
	t.Logf("unchanged attachment tools/list bytes=%d", len(after))
}

func TestScopedAttachmentAuthorizationFailuresDoNotInvokeOperations(t *testing.T) {
	for _, variant := range []string{"missing snapshot", "missing policy", "identity mismatch", "policy mismatch", "resolver failure"} {
		t.Run(variant, func(t *testing.T) {
			f := newEntryFixture(t)
			original := scopedTestAuthorization(t, "attachment:read")
			if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"token": original}}); err != nil {
				t.Fatal(err)
			}
			ops := &scopedAttachmentFixture{t: t}
			resolver := func(ctx context.Context, actor RequestActor) (model.CredentialAuthorization, error) {
				a, err := AttachmentAuthorizationFromActor(ctx, actor)
				if err != nil {
					return a, err
				}
				switch variant {
				case "missing snapshot":
					actor.Authorization = nil
					return AttachmentAuthorizationFromActor(ctx, actor)
				case "missing policy":
					a.Policy = nil
				case "identity mismatch":
					a.Principal.CredentialID = testProjectID
				case "policy mismatch":
					a = scopedTestAuthorization(t, "attachment:delete")
				case "resolver failure":
					return a, errors.New("private authorization failure")
				}
				return a, nil
			}
			if err := RegisterScopedAttachmentTools(f.entry, ops, resolver); err != nil {
				t.Fatal(err)
			}
			result := tagTestCall(t, f.client(t, "2026-07-28", "token"), "task_attachment_remove", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "visible.txt"})
			env := structured(t, result)
			failure := object(t, env["error"])
			encoded, _ := json.Marshal(env)
			if !result.IsError || failure["writeOutcome"] != "not_committed" || failure["code"] != "internal_error" || ops.calls != 0 || strings.Contains(string(encoded), "private authorization") {
				t.Fatal(string(encoded))
			}
		})
	}
	if err := RegisterScopedAttachmentTools(nil, &scopedAttachmentFixture{t: t}, nil); err == nil {
		t.Fatal("missing dependencies accepted")
	}
}
