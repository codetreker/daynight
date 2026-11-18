package github

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type projectWebhookOps struct {
	read  func(context.Context, model.Principal, string) (core.ProjectAppStatus, core.ProjectWebhook, error)
	write func(context.Context, model.Principal, string, core.ProjectWebhookInput) (core.ProjectWebhook, error)
}

func (o projectWebhookOps) GetWithProjectWebhook(ctx context.Context, p model.Principal, id string) (core.ProjectAppStatus, core.ProjectWebhook, error) {
	return o.read(ctx, p, id)
}
func (o projectWebhookOps) Update(ctx context.Context, p model.Principal, id string, input core.ProjectWebhookInput) (core.ProjectWebhook, error) {
	return o.write(ctx, p, id, input)
}

func webhookManagementMux(t *testing.T, ops projectWebhookOps, logs io.Writer) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	RegisterProjectAppRoutesWithWebhook(mux, projectAppOps{t: t}, ops, ops, authStub{}, "https://daynight.example", slog.New(slog.NewTextHandler(logs, nil)))
	return mux
}

func TestProjectWebhookHTTPReadAndWrite(t *testing.T) {
	const secret = "private-secret-value"
	version, repo := int64(9007199254740993), int64(42)
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.FixedZone("other", 3600))
	hook := core.ProjectWebhook{Version: &version, Enabled: true, RepositoryID: &repo, CurrentRepositoryID: &repo, LastReceivedAt: &at}
	reads, writes := 0, 0
	ops := projectWebhookOps{
		read: func(ctx context.Context, p model.Principal, id string) (core.ProjectAppStatus, core.ProjectWebhook, error) {
			reads++
			if p.UserID != userID || id != projectID {
				t.Fatalf("principal=%+v id=%s", p, id)
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Fatal("missing deadline")
			}
			return projectAppFixture(), hook, nil
		},
		write: func(ctx context.Context, p model.Principal, id string, in core.ProjectWebhookInput) (core.ProjectWebhook, error) {
			writes++
			if p.UserID != userID || id != projectID || in.ExpectedUserID != userID || in.Version != nil || !in.Enabled || in.RepositoryID == nil || *in.RepositoryID != repo || in.Secret == nil || *in.Secret != secret {
				t.Fatalf("unexpected input: %+v", in)
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Fatal("missing deadline")
			}
			return hook, nil
		},
	}
	var logs bytes.Buffer
	mux := webhookManagementMux(t, ops, &logs)
	base := "/api/v1/projects/" + projectID + "/github"
	for _, tc := range []struct{ method, path, body string }{
		{"GET", base, ""},
		{"PATCH", base + "/webhook", `{"expectedUserId":"` + userID + `","version":null,"enabled":true,"repositoryId":"42","secret":"` + secret + `"}`},
	} {
		w := managementCall(mux, tc.method, tc.path, tc.body)
		for _, want := range []string{`"version":"9007199254740993"`, `"repositoryId":"42"`, `"lastReceivedAt":"2026-01-02T02:04:05Z"`, `"state":"received"`, `"webhookUrl":"https://daynight.example/api/v1/github/projects/` + projectID + `/webhook"`} {
			if w.Code != 200 || !strings.Contains(w.Body.String(), want) {
				t.Fatalf("status=%d body=%s missing=%s", w.Code, w.Body, want)
			}
		}
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("secret in response")
		}
	}
	if reads != 1 || writes != 1 || strings.Contains(logs.String(), secret) {
		t.Fatalf("reads=%d writes=%d logs=%s", reads, writes, logs.String())
	}
}

func TestProjectWebhookHTTPInputAndFailures(t *testing.T) {
	calls := 0
	ops := projectWebhookOps{write: func(_ context.Context, _ model.Principal, _ string, _ core.ProjectWebhookInput) (core.ProjectWebhook, error) {
		calls++
		return core.ProjectWebhook{}, &model.Fault{Code: "forbidden", Message: "Project administrator permission is required."}
	}}
	mux := webhookManagementMux(t, ops, io.Discard)
	base := "/api/v1/projects/" + projectID + "/github/webhook"
	prefix := `{"expectedUserId":"` + userID + `","version":null,"enabled":true`
	for _, body := range []string{
		`{"expectedUserId":"` + userID + `","enabled":true}`,
		prefix + `,"repositoryId":null}`,
		prefix + `,"repositoryId":"01"}`,
		prefix + `,"secret":null}`,
		prefix + `,"secret":""}`,
		prefix + `,"secret":"` + strings.Repeat("a", 4097) + `"}`,
		prefix + `,"secret":"\ud800"}`,
		prefix + `,"secret":"` + string([]byte{0xff}) + `"}`,
		prefix + `,"extra":1}`,
		prefix + `,"enabled":false}`,
		`{"expectedUserId":"` + userID + `","version":1,"enabled":true}`,
		`{"expectedUserId":"` + userID + `","version":"01","enabled":true}`,
		`{"expectedUserId":"` + userID + `","version":"9223372036854775808","enabled":true}`,
		`{"expectedUserId":"` + userID + `","version":null,"enabled":null}`,
	} {
		w := managementCall(mux, "PATCH", base, body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status=%d response=%s", body, w.Code, w.Body)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid input reached business operation %d times", calls)
	}
	w := managementCall(mux, "PATCH", base, prefix+`}`)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"forbidden"`) || calls != 1 {
		t.Fatalf("status=%d body=%s calls=%d", w.Code, w.Body, calls)
	}
	w = managementCall(mux, "POST", base, "")
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "PATCH" {
		t.Fatalf("status=%d headers=%v", w.Code, w.Header())
	}
}

func TestProjectWebhookExistingVersionAndDomainErrors(t *testing.T) {
	base := "/api/v1/projects/" + projectID + "/github/webhook"
	for _, tc := range []struct {
		code   string
		status int
	}{
		{"version_conflict", 409}, {"identity_mismatch", 409}, {"github_repository_mismatch", 409}, {"version_exhausted", 409}, {"github_write_outcome_unknown", 503},
	} {
		t.Run(tc.code, func(t *testing.T) {
			calls := 0
			ops := projectWebhookOps{write: func(_ context.Context, _ model.Principal, _ string, in core.ProjectWebhookInput) (core.ProjectWebhook, error) {
				calls++
				if in.Version == nil || *in.Version != 9223372036854775807 || in.RepositoryID != nil || in.Secret != nil || in.Enabled {
					t.Fatalf("input=%+v", in)
				}
				if tc.code == "github_write_outcome_unknown" {
					return core.ProjectWebhook{}, &service.ManagementError{Code: tc.code, Message: "unknown"}
				}
				return core.ProjectWebhook{}, &model.Fault{Code: tc.code, Message: "refused"}
			}}
			w := managementCall(webhookManagementMux(t, ops, io.Discard), "PATCH", base, `{"expectedUserId":"`+userID+`","version":"9223372036854775807","enabled":false}`)
			if w.Code != tc.status || !strings.Contains(w.Body.String(), `"`+tc.code+`"`) || calls != 1 {
				t.Fatalf("status=%d body=%s calls=%d", w.Code, w.Body, calls)
			}
		})
	}
}

func TestProjectWebhookNullProjectionAndDisable(t *testing.T) {
	version, repo := int64(9007199254740993), int64(9007199254740995)
	ops := projectWebhookOps{
		read: func(context.Context, model.Principal, string) (core.ProjectAppStatus, core.ProjectWebhook, error) {
			return projectAppFixture(), core.ProjectWebhook{}, nil
		},
		write: func(_ context.Context, _ model.Principal, _ string, in core.ProjectWebhookInput) (core.ProjectWebhook, error) {
			if in.Version == nil || *in.Version != version || in.RepositoryID == nil || *in.RepositoryID != repo || in.Enabled || in.Secret != nil {
				t.Fatalf("input=%+v", in)
			}
			return core.ProjectWebhook{Version: &version, RepositoryID: &repo}, nil
		},
	}
	mux := webhookManagementMux(t, ops, io.Discard)
	base := "/api/v1/projects/" + projectID + "/github"
	w := managementCall(mux, "GET", base, "")
	var body struct {
		ProjectWebhook map[string]any `json:"projectWebhook"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || len(body.ProjectWebhook) != 6 || body.ProjectWebhook["version"] != nil || body.ProjectWebhook["repositoryId"] != nil || body.ProjectWebhook["lastReceivedAt"] != nil || body.ProjectWebhook["enabled"] != false || body.ProjectWebhook["state"] != "unconfigured" {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	w = managementCall(mux, "PATCH", base+"/webhook", `{"expectedUserId":"`+userID+`","version":"9007199254740993","enabled":false,"repositoryId":"9007199254740995"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"state":"disabled"`) || !strings.Contains(w.Body.String(), `"repositoryId":"9007199254740995"`) {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
}

func TestProjectWebhookErrorDiagnosticsRedacted(t *testing.T) {
	const private = "secret-in-diagnostic"
	var logs bytes.Buffer
	ops := projectWebhookOps{write: func(context.Context, model.Principal, string, core.ProjectWebhookInput) (core.ProjectWebhook, error) {
		return core.ProjectWebhook{}, &model.Fault{Code: "invalid_input", Message: private}
	}}
	w := managementCall(webhookManagementMux(t, ops, &logs), "PATCH", "/api/v1/projects/"+projectID+"/github/webhook", `{"expectedUserId":"`+userID+`","version":null,"enabled":true,"secret":"`+private+`"}`)
	if w.Code != 400 || strings.Contains(logs.String(), private) {
		t.Fatalf("status=%d logs=%s", w.Code, logs.String())
	}
}

func TestProjectWebhookStatePrecedenceAndLegacyProjection(t *testing.T) {
	version, repo, other := int64(1), int64(2), int64(3)
	at := time.Now()
	h := projectAppHandler{webhookOrigin: "https://daynight.example"}
	for _, tc := range []struct {
		name string
		hook core.ProjectWebhook
		want string
	}{
		{"missing", core.ProjectWebhook{}, "unconfigured"},
		{"disabled", core.ProjectWebhook{Version: &version, RepositoryID: &repo, CurrentRepositoryID: &other, LastReceivedAt: &at}, "disabled"},
		{"mismatch", core.ProjectWebhook{Version: &version, Enabled: true, RepositoryID: &repo, CurrentRepositoryID: &other, LastReceivedAt: &at}, "repository_mismatch"},
		{"waiting", core.ProjectWebhook{Version: &version, Enabled: true, RepositoryID: &repo}, "waiting"},
		{"received", core.ProjectWebhook{Version: &version, Enabled: true, RepositoryID: &repo, LastReceivedAt: &at}, "received"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := h.webhookResponse(projectID, tc.hook).State; got != tc.want {
				t.Fatalf("state=%s", got)
			}
		})
	}
	mux := projectAppMux(projectAppOps{t: t, get: func(context.Context, model.Principal, string) (core.ProjectAppStatus, error) {
		return projectAppFixture(), nil
	}})
	w := managementCall(mux, "GET", "/api/v1/projects/"+projectID+"/github", "")
	if w.Code != 200 || strings.Contains(w.Body.String(), "projectWebhook") {
		t.Fatalf("legacy status=%d body=%s", w.Code, w.Body)
	}
}
