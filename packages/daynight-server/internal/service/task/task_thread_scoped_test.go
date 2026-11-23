package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func threadAuthorization(t *testing.T, f *threadFailureFixture, kind scopepolicy.CredentialType, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(kind, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	profile := model.ScopedPATProfile
	f.principal.Kind = model.PATCredential
	if kind == scopepolicy.MCP {
		profile, f.principal.Kind = model.ScopedMCPProfile, model.OAuthCredential
	}
	return model.CredentialAuthorization{Principal: f.principal, Profile: profile, Policy: &policy}
}

func TestScopedThreadWriteOnlyReceiptAndReadDenial(t *testing.T) {
	f := newThreadFailureFixture(t)
	auth := threadAuthorization(t, f, scopepolicy.PAT, "thread:post")
	f.credential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
		return store.ThreadCredential{ScopePolicy: auth.Policy}, nil
	}
	f.readCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
		return store.ThreadCredential{ScopePolicy: auth.Policy}, nil
	}
	commitThreadCallback(f.database, f.scope)
	expectThreadAppend(t, f.thread, f.task, f.principal, uuid.NewString(), time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC), true)
	threads := service.NewScopedTaskThreads(f.service)
	doc, err := threads.Post(t.Context(), auth, f.project.ID, f.task.ID, service.CreateThreadMessage{Body: "new body", Receipt: true})
	if err != nil {
		t.Fatal(err)
	}
	var receipt map[string]string
	if err := json.Unmarshal(doc.JSON, &receipt); err != nil || len(receipt) != 3 || receipt["messageId"] != doc.Message.ID || receipt["projectId"] != f.project.ID || receipt["taskId"] != f.task.ID || strings.Contains(string(doc.JSON), "Existing message") {
		t.Fatalf("receipt: %s %v", doc.JSON, err)
	}
	f.taskRead.ThreadCandidatesFn = func(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error) {
		t.Fatal("read historical messages")
		return nil, nil
	}
	_, err = threads.List(t.Context(), auth, f.project.ID, f.task.ID, service.ThreadListRequest{})
	requireThreadFault(t, err, "insufficient_scope")
}

func TestScopedThreadReadUsesSnapshotPolicy(t *testing.T) {
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		t.Run(string(kind), func(t *testing.T) {
			f := newThreadFailureFixture(t)
			auth := threadAuthorization(t, f, kind, "thread:read")
			current, err := scopepolicy.NewPolicy(kind, []scopepolicy.ScopeID{"thread:post"}, 2)
			if err != nil {
				t.Fatal(err)
			}
			f.readCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
				return store.ThreadCredential{ScopePolicy: &current}, nil
			}
			f.taskRead.ThreadCandidatesFn = func(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error) {
				t.Fatal("read historical messages")
				return nil, nil
			}
			_, err = service.NewScopedTaskThreads(f.service).List(t.Context(), auth, f.project.ID, f.task.ID, service.ThreadListRequest{})
			requireThreadFault(t, err, "insufficient_scope")
		})
	}
	f := newThreadFailureFixture(t)
	f.principal.Kind = model.SessionCredential
	auth := model.CredentialAuthorization{Principal: f.principal, Profile: model.SessionProfile}
	result, err := service.NewScopedTaskThreads(f.service).List(t.Context(), auth, f.project.ID, f.task.ID, service.ThreadListRequest{})
	if err != nil || len(result.Page.Items) != 1 {
		t.Fatalf("fixed profile: %+v %v", result, err)
	}
}

func TestScopedThreadAutomaticReceiptUsesLockedReadScope(t *testing.T) {
	for _, tc := range []struct {
		name    string
		current []scopepolicy.ScopeID
		minimal bool
	}{
		{"read removed", []scopepolicy.ScopeID{"thread:post"}, true},
		{"read added", []scopepolicy.ScopeID{"thread:post", "thread:read"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newThreadFailureFixture(t)
			initial := []scopepolicy.ScopeID{"thread:post", "thread:read"}
			if tc.name == "read added" {
				initial = []scopepolicy.ScopeID{"thread:post"}
			}
			auth := threadAuthorization(t, f, scopepolicy.MCP, initial...)
			current, err := scopepolicy.NewPolicy(scopepolicy.MCP, tc.current, 2)
			if err != nil {
				t.Fatal(err)
			}
			f.credential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
				return store.ThreadCredential{ScopePolicy: &current}, nil
			}
			commitThreadCallback(f.database, f.scope)
			expectThreadAppend(t, f.thread, f.task, f.principal, uuid.NewString(), time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC), true)
			doc, err := service.NewScopedTaskThreads(f.service).Post(t.Context(), auth, f.project.ID, f.task.ID, service.CreateThreadMessage{Body: "new", AutoReceipt: true})
			if err != nil {
				t.Fatal(err)
			}
			var response map[string]any
			if err := json.Unmarshal(doc.JSON, &response); err != nil {
				t.Fatal(err)
			}
			if tc.minimal && (len(response) != 3 || response["messageId"] != doc.Message.ID) || !tc.minimal && (response["id"] != doc.Message.ID || response["body"] != "new") {
				t.Fatalf("response: %s", doc.JSON)
			}
		})
	}
}

func TestScopedThreadFullResponseRequiresReadBeforeWrite(t *testing.T) {
	f := newThreadFailureFixture(t)
	auth := threadAuthorization(t, f, scopepolicy.PAT, "thread:post")
	f.credential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
		return store.ThreadCredential{ScopePolicy: auth.Policy}, nil
	}
	f.thread.InsertMessageFn = func(context.Context, model.ThreadMessage) (model.ThreadMessage, error) {
		t.Fatal("write before full response admission")
		return model.ThreadMessage{}, nil
	}
	_, err := service.NewScopedTaskThreads(f.service).Post(t.Context(), auth, f.project.ID, f.task.ID, service.CreateThreadMessage{Body: "new"})
	requireThreadFault(t, err, "insufficient_scope")
}

func TestScopedThreadPreservesClaimOwnership(t *testing.T) {
	f := newThreadFailureFixture(t)
	auth := threadAuthorization(t, f, scopepolicy.PAT, "thread:post")
	f.credential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
		return store.ThreadCredential{ScopePolicy: auth.Policy}, nil
	}
	active, claim := threadActiveTask(t, f.task, uuid.NewString())
	f.taskWrite.SourceTaskFn = func(context.Context, string, string) (model.Task, error) { return active, nil }
	f.thread.InsertMessageFn = func(context.Context, model.ThreadMessage) (model.ThreadMessage, error) {
		t.Fatal("foreign claim wrote message")
		return model.ThreadMessage{}, nil
	}
	_, err := service.NewScopedTaskThreads(f.service).Post(t.Context(), auth, f.project.ID, f.task.ID, service.CreateThreadMessage{Body: "new", ClaimID: &claim.ClaimID, Receipt: true})
	requireThreadFault(t, err, "forbidden")
}

func TestScopedThreadUsesLockedPolicyAndPreservesResourceAuthorization(t *testing.T) {
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		t.Run(string(kind), func(t *testing.T) {
			f := newThreadFailureFixture(t)
			auth := threadAuthorization(t, f, kind, "thread:post")
			changed, err := scopepolicy.NewPolicy(kind, []scopepolicy.ScopeID{"thread:read"}, 2)
			if err != nil {
				t.Fatal(err)
			}
			f.credential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
				return store.ThreadCredential{ScopePolicy: &changed}, nil
			}
			f.thread.InsertMessageFn = func(context.Context, model.ThreadMessage) (model.ThreadMessage, error) {
				t.Fatal("write after scope refusal")
				return model.ThreadMessage{}, nil
			}
			threads := service.NewScopedTaskThreads(f.service)
			_, err = threads.Post(t.Context(), auth, f.project.ID, f.task.ID, service.CreateThreadMessage{Body: "body"})
			requireThreadFault(t, err, "insufficient_scope")
			var failure *service.ThreadMessageError
			if !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted {
				t.Fatalf("outcome: %v", err)
			}
			f.projectWrite.LockProjectAuthorizationFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
				return model.ProjectAccess{}, model.ErrNotFound
			}
			_, err = threads.Post(t.Context(), auth, f.project.ID, f.task.ID, service.CreateThreadMessage{Body: "body"})
			requireThreadFault(t, err, "forbidden")
		})
	}
}
