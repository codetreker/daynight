package tag

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
)

type scopedAuthentication struct{ authorization model.CredentialAuthorization }

func (a scopedAuthentication) RequireAuthorization(next AuthorizedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.authorization) }
}

type scopedOperations struct {
	ScopedOperations
	t             *testing.T
	authorization model.CredentialAuthorization
	seen          string
	err           error
	result        service.WriteResult
}

func (o *scopedOperations) check(ctx context.Context, a model.CredentialAuthorization, project, operation string) {
	o.t.Helper()
	if ctx.Value(marker{}) != o || a != o.authorization || project != projectID {
		o.t.Fatalf("authorization/context/project changed: %+v %q", a, project)
	}
	if o.seen != "" {
		o.t.Fatal("business operation repeated")
	}
	o.seen = operation
}
func (o *scopedOperations) List(ctx context.Context, a model.CredentialAuthorization, project string, in service.ListInput) (service.Page, error) {
	o.check(ctx, a, project, "list")
	return service.Page{Items: []service.Item{}, CatalogEpoch: projectID}, o.err
}
func (o *scopedOperations) Get(ctx context.Context, a model.CredentialAuthorization, project, id string) (service.Item, error) {
	o.check(ctx, a, project, "get")
	if id != tagID {
		o.t.Fatal(id)
	}
	return service.Item{}, o.err
}
func (o *scopedOperations) Create(ctx context.Context, a model.CredentialAuthorization, project, name string, color *string) (service.WriteResult, error) {
	o.check(ctx, a, project, "create")
	if name != "Alpha" || color == nil || *color != "#123456" {
		o.t.Fatal("create input changed")
	}
	return o.result, o.err
}
func (o *scopedOperations) Update(ctx context.Context, a model.CredentialAuthorization, project, id string, v int64, name, color *string) (service.WriteResult, error) {
	o.check(ctx, a, project, "update")
	if id != tagID || v != 9007199254740993 || name == nil || *name != "Alpha" || color == nil || *color != "#123456" {
		o.t.Fatal("update input changed")
	}
	return o.result, o.err
}
func (o *scopedOperations) Delete(ctx context.Context, a model.CredentialAuthorization, project, id string, v int64, confirm bool) (service.WriteResult, error) {
	o.check(ctx, a, project, "delete")
	if id != tagID || v != 9007199254740993 || !confirm {
		o.t.Fatal("delete input changed")
	}
	return o.result, o.err
}
func (o *scopedOperations) Resolve(ctx context.Context, a model.CredentialAuthorization, project string, ids []string) ([]model.TagReference, error) {
	o.check(ctx, a, project, "resolve")
	if len(ids) != 1 || ids[0] != tagID {
		o.t.Fatal(ids)
	}
	return []model.TagReference{}, o.err
}
func (o *scopedOperations) ResolveColors(ctx context.Context, a model.CredentialAuthorization, project string, ids []string, epoch *string) (service.ColorPage, error) {
	o.check(ctx, a, project, "colors")
	if len(ids) != 1 || ids[0] != tagID || epoch == nil || *epoch != projectID {
		o.t.Fatal("color input changed")
	}
	return service.ColorPage{CatalogEpoch: projectID, Items: []service.ColorItem{}}, o.err
}
func scopedAuthorization(t *testing.T) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"tag:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: projectID, CredentialID: tagID}, Profile: model.ScopedPATProfile, Policy: &policy}
}
func scopedRequest(t *testing.T, o *scopedOperations, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	RegisterScopedRoutes(mux, o, scopedAuthentication{o.authorization}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), marker{}, o))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w
}
func TestScopedRoutesPreserveAuthorizationAndInput(t *testing.T) {
	for _, tc := range []struct{ method, path, body, operation string }{
		{"GET", collection, "", "list"},
		{"HEAD", collection, "", "list"},
		{"GET", collection + "/" + tagID, "", "get"},
		{"HEAD", collection + "/" + tagID, "", "get"},
		{"POST", collection, `{"name":"Alpha","color":"#123456"}`, "create"},
		{"PATCH", collection + "/" + tagID, `{"version":9007199254740993,"name":"Alpha","color":"#123456"}`, "update"},
		{"DELETE", collection + "/" + tagID, `{"version":9007199254740993,"confirm":true}`, "delete"},
		{"POST", collection + "/resolve", `{"tagIds":["` + tagID + `"]}`, "resolve"},
		{"POST", collection + "/colors/resolve", `{"tagIds":["` + tagID + `"],"catalogEpoch":"` + projectID + `"}`, "colors"},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			o := &scopedOperations{t: t, authorization: scopedAuthorization(t), err: &model.Fault{Code: "insufficient_scope", Message: "Tag scope is insufficient."}, result: service.WriteResult{Outcome: store.TransactionNotCommitted}}
			w := scopedRequest(t, o, tc.method, tc.path, tc.body)
			if o.seen != tc.operation || w.Code != 403 || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" {
				t.Fatalf("operation=%q status=%d headers=%v body=%s", o.seen, w.Code, w.Header(), w.Body.String())
			}
			if tc.method != "HEAD" && (!strings.Contains(w.Body.String(), `"code":"forbidden"`) || strings.Contains(w.Body.String(), `"data"`)) {
				t.Fatal(w.Body.String())
			}
		})
	}
}
func TestScopedRoutesRejectInvalidAuthorizationBeforeBusiness(t *testing.T) {
	o := &scopedOperations{t: t, authorization: scopedAuthorization(t)}
	o.authorization.Policy = nil
	w := scopedRequest(t, o, "GET", collection, "")
	if w.Code != 500 || o.seen != "" || w.Header().Get("Daynight-Scope-Status") != "" {
		t.Fatalf("%d %q %v", w.Code, o.seen, w.Header())
	}
}
func TestScopeRefusalDoesNotHideUnsafeCompletion(t *testing.T) {
	refusal := &model.Fault{Code: "insufficient_scope", Message: "Tag scope is insufficient."}
	for _, tc := range []struct {
		name   string
		err    error
		result service.WriteResult
		status int
	}{
		{"unknown", refusal, service.WriteResult{Outcome: store.TransactionUnknown}, 503},
		{"rollback failure", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: refusal}, service.WriteResult{Outcome: store.TransactionNotCommitted, CleanupFailed: true}, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := &scopedOperations{t: t, authorization: scopedAuthorization(t), err: tc.err, result: tc.result}
			w := scopedRequest(t, o, "DELETE", collection+"/"+tagID, `{"version":9007199254740993,"confirm":true}`)
			if w.Code != tc.status || w.Header().Get("Daynight-Scope-Status") != "" || strings.Contains(w.Body.String(), `"code":"forbidden"`) {
				t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body.String())
			}
		})
	}
}
