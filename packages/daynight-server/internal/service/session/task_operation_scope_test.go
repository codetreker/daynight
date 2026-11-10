package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type taskBrowserRules struct {
	browserOperation
	t         *testing.T
	ctx       context.Context
	scope     store.SessionScope
	principal model.Principal
	purpose   core.BrowserPurpose
	calls     []string
	access    *core.Access
	task      *core.TaskAccess
	fail      string
	failure   error
}

func (r *taskBrowserRules) call(ctx context.Context, scope store.SessionScope, name string) error {
	r.t.Helper()
	if ctx != r.ctx || scope != r.scope {
		r.t.Errorf("%s changed context/scope", name)
	}
	r.calls = append(r.calls, name)
	if name == r.fail {
		return r.failure
	}
	return nil
}
func (r *taskBrowserRules) LockTask(ctx context.Context, scope store.SessionScope, project, task string) (*core.TaskAccess, error) {
	if project != "project" || task != "task" {
		r.t.Error("task target changed")
	}
	return r.task, r.call(ctx, scope, "task")
}
func (r *taskBrowserRules) LockPurposeCredential(ctx context.Context, scope store.SessionScope, p model.Principal, purpose core.BrowserPurpose) error {
	if p != r.principal || purpose != r.purpose {
		r.t.Error("credential purpose changed")
	}
	return r.call(ctx, scope, "credential")
}
func (r *taskBrowserRules) CheckProjectAccess(ctx context.Context, scope store.SessionScope, p model.Principal, project string) error {
	if p != r.principal || project != "project" {
		r.t.Error("project actor changed")
	}
	return r.call(ctx, scope, "project")
}
func (r *taskBrowserRules) LoadTaskReceipt(ctx context.Context, scope store.SessionScope, project, task, id string) (*core.Access, error) {
	if id != "session" || project != "project" || task != "task" {
		r.t.Error("receipt Session changed")
	}
	return r.access, r.call(ctx, scope, "receipt")
}
func (r *taskBrowserRules) BindTaskPurpose(ctx context.Context, a *core.Access, task *core.TaskAccess, p model.Principal, project, id string, purpose core.BrowserPurpose) error {
	if a != r.access || task != r.task || p != r.principal || purpose != r.purpose || project != "project" || id != "task" {
		r.t.Error("binding input changed")
	}
	return r.call(ctx, r.scope, "bind")
}
func (r *taskBrowserRules) Finish(outcome store.TransactionOutcome) {
	r.calls = append(r.calls, "finish:"+string(outcome))
}
func (r *taskBrowserRules) Close() { r.calls = append(r.calls, "close") }

type taskScopeWriter struct {
	t               *testing.T
	ctx             context.Context
	scope           store.SessionScope
	outcome         store.TransactionOutcome
	completionError error
}

func (w taskScopeWriter) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	if ctx != w.ctx {
		w.t.Error("transaction context changed")
	}
	err := fn(w.scope)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: w.outcome}, w.completionError
}

type receiptScope struct{ store.SessionScope }

func TestTaskReceiptScopePreservesPurposeOrderingAndCompletion(t *testing.T) {
	for _, stop := range []string{"", "task", "credential", "project", "receipt", "bind", "work", "completion"} {
		t.Run(stop, func(t *testing.T) {
			ctx := context.WithValue(t.Context(), struct{}{}, "marker")
			scope := &receiptScope{}
			cause := errors.New("controlled " + stop)
			p := model.Principal{Kind: model.OAuthCredential, UserID: "owner", CredentialID: "original"}
			rules := &taskBrowserRules{t: t, ctx: ctx, scope: scope, principal: p, purpose: core.TaskReceiptAccess, access: &core.Access{}, task: &core.TaskAccess{}, fail: stop, failure: cause}
			writer := taskScopeWriter{t: t, ctx: ctx, scope: scope, outcome: store.TransactionCommitted}
			if stop == "completion" {
				writer.outcome = store.TransactionUnknown
				writer.completionError = &store.TransactionError{Outcome: store.TransactionUnknown, Phase: "commit", Cause: cause}
			}
			svc := &Service{writer: writer, beginBrowser: func() (browserOperation, error) { rules.calls = append(rules.calls, "begin"); return rules, nil }}
			err := svc.browserFor(ctx, p, "project", "task", "session", core.TaskReceiptAccess, func(a *core.Access) error {
				if a != rules.access {
					t.Error("work access changed")
				}
				rules.calls = append(rules.calls, "work")
				if stop == "work" {
					return cause
				}
				return nil
			})
			if stop == "" && err != nil || stop != "" && !errors.Is(err, cause) {
				t.Fatalf("error chain lost: %v", err)
			}
			want := []string{"begin"}
			for _, name := range []string{"task", "credential", "project", "receipt", "bind", "work"} {
				want = append(want, name)
				if name == stop {
					break
				}
			}
			outcome := store.TransactionCommitted
			if stop != "" {
				outcome = store.TransactionNotCommitted
			}
			if stop == "completion" {
				outcome = store.TransactionUnknown
			}
			want = append(want, "finish:"+string(outcome), "close")
			if !reflect.DeepEqual(rules.calls, want) {
				t.Fatalf("scope order got %v want %v", rules.calls, want)
			}
		})
	}
}
