package github

import (
	"context"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type configOps struct {
	t      *testing.T
	update func(context.Context, model.Principal, string, core.UpdateAppInput) (core.AppMetadata, error)
	remove func(context.Context, model.Principal, string, core.RemoveAppInput) error
}

func (o configOps) UpdateApp(ctx context.Context, p model.Principal, id string, in core.UpdateAppInput) (core.AppMetadata, error) {
	if o.update == nil {
		o.t.Fatal("unexpected update")
	}
	return o.update(ctx, p, id, in)
}
func (o configOps) RemoveApp(ctx context.Context, p model.Principal, id string, in core.RemoveAppInput) error {
	if o.remove == nil {
		o.t.Fatal("unexpected remove")
	}
	return o.remove(ctx, p, id, in)
}

func TestAppConfigProtocol(t *testing.T) {
	calls := 0
	ops := configOps{t: t, update: func(ctx context.Context, p model.Principal, id string, in core.UpdateAppInput) (core.AppMetadata, error) {
		calls++
		d, ok := ctx.Deadline()
		if !ok || time.Until(d) > appWriteBudget || p.UserID != userID || id != appID || in.Version != 4 || in.ExpectedUserID != userID || in.Name == nil || *in.Name != " Example " || in.PrivateKeyPEM != nil || in.WebhookSecret == nil || *in.WebhookSecret != " secret " {
			t.Fatalf("input=%+v id=%s", in, id)
		}
		return appMetadata(), nil
	}, remove: func(ctx context.Context, p model.Principal, id string, in core.RemoveAppInput) error {
		calls++
		d, ok := ctx.Deadline()
		if !ok || time.Until(d) > core.OperationTimeout || p.UserID != userID || id != appID || in.Version != 4 || in.ImpactVersion != 9 || in.ExpectedUserID != userID {
			t.Fatalf("input=%+v id=%s", in, id)
		}
		return nil
	}}
	h := appMux(t, appOps{t: t}, io.Discard, ops)
	for _, tc := range []struct{ method, path, body, want string }{
		{"PATCH", appPath + "/" + strings.ToUpper(appID), `{"version":"4","expectedUserId":"` + userID + `","name":" Example ","webhookSecret":" secret "}`, `"githubAppId":"9007199254740993"`},
		{"POST", appPath + "/" + appID + "/remove", `{"version":"4","impactVersion":"9","expectedUserId":"` + userID + `"}`, `"removed":true`},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest(tc.method, tc.path, tc.body))
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), tc.want) || strings.Contains(w.Body.String(), " secret ") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body)
		}
	}
	if calls != 2 {
		t.Fatal(calls)
	}
}

func TestAppConfigRefusals(t *testing.T) {
	h := appMux(t, appOps{t: t}, io.Discard, configOps{t: t})
	valid := `{"version":"1","expectedUserId":"` + userID + `"`
	for _, body := range []string{valid + `}`, valid + `,"name":null}`, valid + `,"name":"\u2003"}`, valid + `,"name":"\u0000"}`, valid + `,"privateKeyPem":""}`, valid + `,"webhookSecret":null}`, valid + `,"webhookSecret":""}`, valid + `,"webhookSecret":"` + strings.Repeat("a", 4097) + `"}`, valid + `,"githubAppId":"1"}`, valid + `,"name":"x","name":"y"}`, valid + `,"name":"\ud800"}`, `{"version":"01","expectedUserId":"` + userID + `","name":"x"}`} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest("PATCH", appPath+"/"+appID, body))
		if w.Code != 400 {
			t.Fatalf("status=%d body=%s request=%s", w.Code, w.Body, body)
		}
	}
	for _, body := range []string{`{"version":"1","expectedUserId":"` + userID + `"}`, `{"version":"1","impactVersion":null,"expectedUserId":"` + userID + `"}`, `{"version":"1","impactVersion":"1","expectedUserId":"` + userID + `","other":1}`} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest("POST", appPath+"/"+appID+"/remove", body))
		if w.Code != 400 {
			t.Fatalf("status=%d body=%s", w.Code, w.Body)
		}
	}
}

func TestAppConfigFailureOutcomes(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		want   string
	}{
		{&model.Fault{Code: "github_admin_changed", Message: "changed"}, 409, `"github_admin_changed"`},
		{&model.Fault{Code: "impact_changed", Message: "changed"}, 409, `"impact_changed"`},
		{&service.ManagementError{Code: "github_write_outcome_unknown", Message: "unknown", Cause: errors.New("lost")}, 503, `"writeOutcome":"unknown"`},
	} {
		calls := 0
		h := appMux(t, appOps{t: t}, io.Discard, configOps{t: t, remove: func(context.Context, model.Principal, string, core.RemoveAppInput) error { calls++; return tc.err }})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest("POST", appPath+"/"+appID+"/remove", `{"version":"1","impactVersion":"1","expectedUserId":"`+userID+`"}`))
		if calls != 1 || w.Code != tc.status || !strings.Contains(w.Body.String(), tc.want) {
			t.Fatalf("calls=%d status=%d body=%s", calls, w.Code, w.Body)
		}
	}
}
