package bot

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type recoveryHTTP struct {
	t                              *testing.T
	principal                      model.Principal
	worker, bot, operation, method string
	input                          any
	context                        context.Context
	calls                          int
	err                            error
	result                         sessioncore.BotRecoveryResult
	botResult                      model.Bot
	block                          bool
	entered                        chan struct{}
}

func (f *recoveryHTTP) call(ctx context.Context, p model.Principal, worker, bot, method string, input any) {
	f.calls++
	if f.calls != 1 || p != f.principal || worker != f.worker || bot != f.bot || method != f.method || !reflect.DeepEqual(input, f.input) || ctx != f.context {
		f.t.Errorf("recovery dispatch differs: method=%s, input=%#v", method, input)
	}
	if f.block {
		close(f.entered)
		<-ctx.Done()
		f.err = ctx.Err()
	}
}
func (f *recoveryHTTP) RegisterBotRecovery(c context.Context, p model.Principal, w, b string, in sessioncore.BotRecoveryRegistration) (sessioncore.BotRecoveryResult, error) {
	f.call(c, p, w, b, "register", in)
	return f.result, f.err
}
func (f *recoveryHTTP) TakeoverBot(c context.Context, p model.Principal, w, b string, in sessioncore.BotRecoveryGrant) (sessioncore.BotRecoveryResult, error) {
	f.call(c, p, w, b, "takeover", in)
	return f.result, f.err
}
func (f *recoveryHTTP) GrantBotRecovery(c context.Context, p model.Principal, w, b string, in sessioncore.BotRecoveryGrant) (sessioncore.BotRecoveryResult, error) {
	f.call(c, p, w, b, "grant", in)
	return f.result, f.err
}
func (f *recoveryHTTP) ReportBotRecovery(c context.Context, p model.Principal, w, b string, in sessioncore.BotRecoveryReport) (model.Bot, error) {
	f.call(c, p, w, b, "report", in)
	return f.botResult, f.err
}
func (f *recoveryHTTP) BotRecoveryOperation(c context.Context, p model.Principal, w, b, o string, in sessioncore.BotRecoveryIdentity) (sessioncore.BotRecoveryResult, error) {
	if o != f.operation {
		f.t.Error("operation ID differs")
	}
	f.call(c, p, w, b, "query", in)
	return f.result, f.err
}

func newRecoveryHTTP(t *testing.T) (*recoveryHTTP, http.Handler) {
	f := &recoveryHTTP{t: t, principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, worker: uuid.NewString(), bot: uuid.NewString(), operation: uuid.NewString()}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := authhttp.NewRequestAuthentication(func(_ context.Context, k model.CredentialKind, token string) (model.Principal, error) {
		if k != model.PATCredential || token != "dnpat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" {
			return model.Principal{}, authhttp.Failure()
		}
		return f.principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.test"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	auth := &authhttp.Authentication{RequestAuthentication: a}
	mux := http.NewServeMux()
	RegisterRecoveryRoutes(mux, f, auth, sessionhttp.NewRoutes(nil, auth, logger), logger)
	return f, mux
}
func (f *recoveryHTTP) request(handler http.Handler, method, path string, raw []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/api/v1/me/workers/"+f.worker+"/bots/"+f.bot+"/recovery/v1/"+path, bytes.NewReader(raw))
	r.Header.Set("Authorization", "Bearer dnpat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	r.Header.Set("Content-Type", "application/json")
	if f.context == nil {
		f.context = r.Context()
	} else {
		r = r.WithContext(f.context)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func recoveryInputs() (sessioncore.BotRecoveryRegistration, sessioncore.BotRecoveryGrant, sessioncore.BotRecoveryReport) {
	identity := sessioncore.BotRecoveryIdentity{BotRecoveryVersion: 1, ServiceOrigin: "https://daynight.test", RecoveryIdentity: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))}
	native := "native-original"
	binding := sessioncore.BotRecoveryBinding{SessionID: uuid.NewString(), TestExecutionID: uuid.NewString(), NativeSessionID: &native}
	registration := sessioncore.BotRecoveryRegistration{BotRecoveryIdentity: identity, BotRecoveryBinding: binding, OperationID: uuid.NewString(), BotVersion: 9223372036854775807}
	grant := sessioncore.BotRecoveryGrant{BotRecoveryIdentity: identity, BotRecoveryBinding: binding, OperationID: uuid.NewString(), ExpectedHostingGeneration: 9007199254740993, ControllerToken: "dncontroller_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{4}, 32)), Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: binding.TestExecutionID, ExecutionGeneration: "1", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Kind: "reconnect"}}
	code := "recovering"
	report := sessioncore.BotRecoveryReport{BotRecoveryIdentity: identity, HostingGeneration: 2, Report: sessioncore.BotReport{BotVersion: 3, Result: model.BotStartupResult{State: "failed", Code: &code}}}
	return registration, grant, report
}

func TestBotRecoveryHTTPDispatchAndSafeResponses(t *testing.T) {
	registration, grant, report := recoveryInputs()
	for _, action := range []string{"register", "takeover", "grant", "report", "query"} {
		t.Run(action, func(t *testing.T) {
			f, h := newRecoveryHTTP(t)
			f.method = action
			path := action
			switch action {
			case "register":
				f.input = registration
			case "takeover", "grant":
				f.input = grant
			case "report":
				f.input = report
			default:
				f.input = registration.BotRecoveryIdentity
				path = "operations/" + f.operation
			}
			expires := time.Date(2026, 11, 19, 1, 0, 0, 0, time.UTC)
			hash := strings.Repeat("a", 64)
			f.result = sessioncore.BotRecoveryResult{Current: false, Receipt: sessioncore.BotRecoveryReceipt{BotRecoveryVersion: 1, OperationID: f.operation, Kind: "takeover", WorkerID: f.worker, HostingGeneration: 9007199254740993, BotVersion: 9223372036854775807, BotRecoveryBinding: grant.BotRecoveryBinding, ExecutionGeneration: "1", ControllerID: grant.Grant.ControllerID, ControllerInstanceID: grant.Grant.ControllerInstanceID, GrantExpiresAt: &expires, ControllerTokenHash: &hash}}
			f.botResult = model.Bot{ID: f.bot, WorkerID: f.worker, Version: 3}
			raw, _ := json.Marshal(f.input)
			w := f.request(h, http.MethodPost, path, raw)
			if w.Code != 200 || f.calls != 1 {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, f.calls, w.Body.String())
			}
			if strings.Contains(w.Body.String(), registration.RecoveryIdentity) || strings.Contains(w.Body.String(), grant.ControllerToken) {
				t.Fatal("secret in response")
			}
			if action != "report" {
				var out api.BotRecoveryResult
				if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || !reflect.DeepEqual(out, recoveryResponse(f.result)) {
					t.Fatalf("response mismatch: %s %v", w.Body.String(), err)
				}
			}
		})
	}
}

func TestBotRecoveryHTTPPreservesInitializationEvidence(t *testing.T) {
	_, grant, _ := recoveryInputs()
	grant.NativeSessionID = nil
	grant.InitializationEvidence = &sessioncore.BotInitializationEvidence{Version: 1, State: "not_dispatched"}
	previous := "1"
	grant.Grant.PreviousGeneration, grant.Grant.ExecutionGeneration = &previous, "2"
	grant.Grant.StopProof = &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: uuid.NewString(), StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	for _, action := range []string{"grant", "takeover"} {
		f, h := newRecoveryHTTP(t)
		f.method, f.input = action, grant
		raw, _ := json.Marshal(grant)
		w := f.request(h, http.MethodPost, action, raw)
		if w.Code != 200 || f.calls != 1 {
			t.Fatalf("evidence request was not forwarded: status=%d calls=%d body=%s", w.Code, f.calls, w.Body.String())
		}
		grant.InitializationEvidence.State = "dispatching"
		raw, _ = json.Marshal(grant)
		w = f.request(h, http.MethodPost, action, raw)
		if w.Code != 400 || f.calls != 1 {
			t.Fatalf("invalid evidence reached business operation: status=%d calls=%d", w.Code, f.calls)
		}
		grant.InitializationEvidence.State = "not_dispatched"
	}
}

func TestBotRecoveryHTTPRejectsBeforeBusinessCall(t *testing.T) {
	registration, grant, report := recoveryInputs()
	for _, action := range []string{"register", "takeover", "grant", "report", "query"} {
		t.Run(action, func(t *testing.T) {
			var input any = registration
			switch action {
			case "takeover", "grant":
				input = grant
			case "report":
				input = report
			case "query":
				input = registration.BotRecoveryIdentity
			}
			raw, _ := json.Marshal(input)
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(raw, &fields)
			mutations := map[string][]byte{"malformed": []byte("{"), "unknown": append([]byte(`{"extra":true,`), raw[1:]...), "duplicate": append([]byte(`{"botRecoveryVersion":1,`), raw[1:]...)}
			for key := range fields {
				clone := make(map[string]json.RawMessage)
				for k, v := range fields {
					clone[k] = v
				}
				delete(clone, key)
				mutations["missing_"+key], _ = json.Marshal(clone)
			}
			for key := range fields {
				if key == "nativeSessionId" {
					continue
				}
				clone := make(map[string]json.RawMessage)
				for k, v := range fields {
					clone[k] = v
				}
				clone[key] = json.RawMessage(`null`)
				mutations["null_"+key], _ = json.Marshal(clone)
			}
			for key, values := range map[string][]string{"botRecoveryVersion": {"2"}, "recoveryIdentity": {`"bad"`, `"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="`}, "operationId": {`"00000000-0000-0000-0000-000000000000"`}, "botVersion": {"1", `"01"`, `"9223372036854775808"`}, "expectedHostingGeneration": {"1", `"0"`}, "controllerToken": {`"bad"`}, "nativeSessionId": {`" "`}} {
				if _, ok := fields[key]; !ok {
					continue
				}
				for i, value := range values {
					clone := make(map[string]json.RawMessage)
					for k, v := range fields {
						clone[k] = v
					}
					clone[key] = json.RawMessage(value)
					mutations[key+string(rune('a'+i))], _ = json.Marshal(clone)
				}
			}
			for name, body := range mutations {
				t.Run(name, func(t *testing.T) {
					f, h := newRecoveryHTTP(t)
					path := action
					if action == "query" {
						path = "operations/" + f.operation
					}
					w := f.request(h, "POST", path, body)
					if w.Code < 400 || f.calls != 0 {
						t.Fatalf("status=%d calls=%d body=%s", w.Code, f.calls, w.Body.String())
					}
				})
			}
		})
	}
}

func TestBotRecoveryHTTPFailureAndCancellation(t *testing.T) {
	registration, _, _ := recoveryInputs()
	raw, _ := json.Marshal(registration)
	for code, status := range map[string]int{"forbidden": 403, "resource_conflict": 409, "upgrade_required": 501, "unauthenticated": 401, "outcome_unknown": 503} {
		t.Run(code, func(t *testing.T) {
			f, h := newRecoveryHTTP(t)
			f.method = "register"
			f.input = registration
			f.err = &model.Fault{Code: code, Message: "Recovery refused."}
			w := f.request(h, "POST", "register", raw)
			if w.Code != status || f.calls != 1 {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), code) {
				t.Fatalf("missing error code: %s", w.Body.String())
			}
		})
	}
	f, h := newRecoveryHTTP(t)
	f.method = "register"
	f.input = registration
	f.block = true
	f.entered = make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	f.context = ctx
	done := make(chan struct{})
	go func() { defer close(done); f.request(h, "POST", "register", raw) }()
	<-f.entered
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled recovery did not exit")
	}
	if f.calls != 1 {
		t.Fatal("cancelled request repeated")
	}
}

func TestBotRecoveryHTTPReportFenceValidation(t *testing.T) {
	_, grant, report := recoveryInputs()
	report.Report.Fence = &sp.ControllerFence{Fence: sp.Fence{SessionID: grant.SessionID, TestExecutionID: grant.TestExecutionID, ExecutionGeneration: "2"}, ConnectionEpoch: "0"}
	report.Report.NativeSessionID = grant.NativeSessionID
	report.Report.ControllerID, report.Report.ControllerInstanceID = grant.Grant.ControllerID, grant.Grant.ControllerInstanceID
	for _, epoch := range []string{"0", "9007199254740993"} {
		f, h := newRecoveryHTTP(t)
		report.Report.Fence.ConnectionEpoch = epoch
		f.method, f.input = "report", report
		raw, _ := json.Marshal(report)
		if w := f.request(h, "POST", "report", raw); w.Code != 200 || f.calls != 1 {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
	raw, _ := json.Marshal(report)
	for _, change := range []struct{ from, to string }{
		{`"state":"failed"`, `"state":"unknown"`},
		{`"nativeSessionId":"native-original"`, `"nativeSessionId":" "`},
		{`"connectionEpoch":"9007199254740993"`, `"connectionEpoch":"-1"`},
		{`"executionGeneration":"2"`, `"executionGeneration":"01"`},
		{grant.SessionID, "00000000-0000-0000-0000-000000000000"},
	} {
		if !bytes.Contains(raw, []byte(change.from)) {
			continue
		}
		f, h := newRecoveryHTTP(t)
		body := bytes.Replace(raw, []byte(change.from), []byte(change.to), 1)
		if w := f.request(h, "POST", "report", body); w.Code != 400 || f.calls != 0 {
			t.Fatalf("change=%s status=%d body=%s", change.from, w.Code, w.Body.String())
		}
	}
}

func TestBotRecoveryHTTPRequiresAuthenticationAndPOST(t *testing.T) {
	f, h := newRecoveryHTTP(t)
	if w := f.request(h, "GET", "register", nil); w.Code != 405 || f.calls != 0 {
		t.Fatalf("status=%d calls=%d", w.Code, f.calls)
	}
	r := httptest.NewRequest("POST", "/api/v1/me/workers/"+f.worker+"/bots/"+f.bot+"/recovery/v1/register", strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 || f.calls != 0 {
		t.Fatalf("status=%d calls=%d", w.Code, f.calls)
	}
	r = httptest.NewRequest("POST", "/api/v1/me/workers/"+f.worker+"/bots/"+f.bot+"/recovery/v1/register", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer dnpat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	r.Header.Set("Content-Type", "text/plain")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 || f.calls != 0 {
		t.Fatalf("body rejection status=%d calls=%d", w.Code, f.calls)
	}
}
