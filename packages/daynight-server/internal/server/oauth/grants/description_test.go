package grants

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

type descriptionLifecycle struct {
	items  []store.OAuthGrant
	update func(context.Context, model.Principal, string, string, *string, *string) (*string, error)
	calls  int
}

func (s *descriptionLifecycle) ListSessionGrants(context.Context, model.Principal) ([]store.OAuthGrant, time.Time, error) {
	s.calls++
	return s.items, time.Now(), nil
}
func (s *descriptionLifecycle) RevokeSessionGrant(context.Context, model.Principal, string) (bool, error) {
	panic("unexpected revoke")
}
func (s *descriptionLifecycle) UpdateSessionGrantDescription(ctx context.Context, p model.Principal, user, id string, expected, value *string) (*string, error) {
	s.calls++
	return s.update(ctx, p, user, id, expected, value)
}

func TestGrantDescriptionHTTP(t *testing.T) {
	user, id := uuid.NewString(), uuid.NewString()
	p := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: uuid.NewString()}
	description := "private description"
	now := time.Now().UTC()
	lifecycle := &descriptionLifecycle{items: []store.OAuthGrant{{ID: id, ClientID: "client", ClientSnapshot: []byte(`{"clientId":"client"}`), CreatedAt: now, ExpiresAt: now.Add(time.Hour), Description: &description}}}
	var logs bytes.Buffer
	h := routes{grants: lifecycle, logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	r := httptest.NewRequest("GET", "/api/v3/oauth/grants", nil)
	w := httptest.NewRecorder()
	h.listV3(w, r, p)
	var page struct {
		User   string                       `json:"userId"`
		Grants []map[string]json.RawMessage `json:"grants"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || page.User != user || len(page.Grants) != 1 || len(page.Grants[0]) != 11 || string(page.Grants[0]["description"]) != `"private description"` {
		t.Fatalf("v3: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	h.listV2(w, httptest.NewRequest("GET", "/api/v2/oauth/grants", nil), p)
	if strings.Contains(w.Body.String(), "description") {
		t.Fatalf("legacy shape: %s", w.Body)
	}
	lifecycle.update = func(ctx context.Context, got model.Principal, expectedUser, grant string, expected, value *string) (*string, error) {
		if got != p || expectedUser != user || grant != id || expected != nil || value == nil || *value != " private description " {
			t.Fatal("incorrect operation arguments")
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("missing operation deadline")
		}
		return &description, nil
	}
	send := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("PATCH", "/api/v3/oauth/grants/"+id+"/description", strings.NewReader(body))
		r = r.WithContext(httpx.WithRedactedOperationDiagnostics(r.Context()))
		r.SetPathValue("id", id)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.updateDescription(w, r, p)
		return w
	}
	body := `{"expectedUserId":"` + user + `","expectedDescription":null,"description":" private description "}`
	w = send(body)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"id":"`+id+`","description":"private description"}` {
		t.Fatalf("patch: %d %s", w.Code, w.Body)
	}
	before := lifecycle.calls
	for _, body := range []string{`{}`, `{"expectedUserId":"` + user + `","expectedDescription":null,"description":"\ud800"}`, `{"expectedUserId":"` + user + `","expectedDescription":null,"description":null,"description":null}`} {
		w = send(body)
		if w.Code != 400 || lifecycle.calls != before {
			t.Fatalf("invalid: %d %s", w.Code, w.Body)
		}
	}
	lifecycle.update = func(context.Context, model.Principal, string, string, *string, *string) (*string, error) {
		return nil, errors.Join(core.ErrAuthorizationUnknown, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private description")})
	}
	w = send(body)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "write_outcome_unknown") {
		t.Fatalf("unknown: %d %s", w.Code, w.Body)
	}
	if !strings.Contains(logs.String(), `"cleanup_failed":true`) || !strings.Contains(logs.String(), `"transaction_phase":"commit"`) || strings.Contains(logs.String(), description) {
		t.Fatalf("completion logs: %s", logs.String())
	}
	lifecycle.update = func(context.Context, model.Principal, string, string, *string, *string) (*string, error) {
		return nil, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: context.DeadlineExceeded}
	}
	w = send(body)
	if w.Code != 504 || !strings.Contains(w.Body.String(), `"timeout"`) {
		t.Fatalf("timeout: %d %s", w.Code, w.Body)
	}
	lifecycle.update = func(context.Context, model.Principal, string, string, *string, *string) (*string, error) {
		return nil, &model.Fault{Code: "version_conflict", Message: "The grant description has changed."}
	}
	w = send(body)
	if w.Code != 409 || !strings.Contains(logs.String(), `"error_code":"version_conflict"`) {
		t.Fatalf("conflict: %d %s %s", w.Code, w.Body, logs.String())
	}
	lifecycle.update = func(context.Context, model.Principal, string, string, *string, *string) (*string, error) {
		return nil, model.ErrNotFound
	}
	w = send(body)
	if w.Code != 404 {
		t.Fatalf("missing: %d %s", w.Code, w.Body)
	}
	lifecycle.update = func(context.Context, model.Principal, string, string, *string, *string) (*string, error) {
		return nil, errors.New("private description")
	}
	w = send(body)
	if w.Code != 500 || strings.Contains(w.Body.String(), description) {
		t.Fatalf("failure: %d %s", w.Code, w.Body)
	}
}
