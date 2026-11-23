package session

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func enableTestScopedChannels(h *Routes, admission UserChannelAdmission) error {
	return h.EnableScopedSessionReads(func(r *http.Request, _ model.Principal) (context.Context, error) { return r.Context(), nil }, admission)
}

func TestScopedUserChannelRejectsBeforePoll(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	if err := enableTestScopedChannels(f.routes, func(_ *http.Request, p model.Principal) (func(context.Context, string, string, string) error, error) {
		if p != f.native {
			t.Errorf("unexpected handshake principal: %+v", p)
		}
		return func(_ context.Context, project, task, session string) error {
			if project != f.project || task != f.task || session != f.session {
				t.Errorf("unexpected resource: %s %s %s", project, task, session)
			}
			return &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
		}, nil
	}); err != nil {
		t.Fatal(err)
	}
	conn, response, err := f.dial(f.path(sp.Protocol, false), []string{sp.Protocol}, http.Header{"Authorization": {"Bearer native-secret"}})
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden || response.Header.Get("Daynight-Scope-Status") != "insufficient_scope" {
		t.Fatalf("expected scope refusal before upgrade: response=%v err=%v", response, err)
	}
	defer response.Body.Close()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body.Error.Code != "forbidden" {
		t.Fatalf("unexpected legacy refusal: %+v %v", body, err)
	}
	if f.polls.Load() != 0 || f.routes.ActiveConnections() != 0 {
		t.Fatal("refused channel read data or retained a connection")
	}
}

func TestScopedUserChannelRechecksEveryDeliveryAndCloses(t *testing.T) {
	for _, application := range []bool{false, true} {
		t.Run(map[bool]string{false: "pat", true: "api"}[application], func(t *testing.T) {
			f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
			var checks atomic.Int32
			want := f.native
			if application {
				want = f.identity.Principal
			}
			if err := enableTestScopedChannels(f.routes, func(_ *http.Request, p model.Principal) (func(context.Context, string, string, string) error, error) {
				if p != want {
					t.Errorf("handshake identity: %+v", p)
				}
				return func(_ context.Context, project, task, session string) error {
					if project != f.project || task != f.task || session != f.session {
						t.Error("resource identity changed")
					}
					if checks.Add(1) >= 5 {
						return &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
					}
					return nil
				}, nil
			}); err != nil {
				t.Fatal(err)
			}
			f.routes.service.BrowserPoll = func(_ context.Context, _ model.Principal, _, _, _, _ string) (sp.Snapshot, []map[string]any, string, error) {
				if f.polls.Add(1) == 1 {
					return f.snapshot, nil, "initial", nil
				}
				return f.snapshot, []map[string]any{{"eventSeq": "1", "payload": "allowed"}, {"eventSeq": "2", "payload": "private"}}, "next", nil
			}
			protocols := []string{sp.Protocol}
			headers := http.Header{"Authorization": {"Bearer native-secret"}}
			if application {
				protocols = append(protocols, "daynight.authorization."+f.token)
				headers = http.Header{"Origin": {apiChannelOrigin}}
			}
			conn, _, err := f.dial(f.path(sp.Protocol, false), protocols, headers)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			frame, err := readAPIChannel(t, conn)
			if err != nil || frame["type"] != "snapshot" {
				t.Fatalf("snapshot: %v %v", frame, err)
			}
			frame, err = readAPIChannel(t, conn)
			if err != nil || frame["type"] != "event" {
				t.Fatalf("first event: %v %v", frame, err)
			}
			frame, err = readAPIChannel(t, conn)
			if err == nil || websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Fatalf("expected scope close without second event: %v %v", frame, err)
			}
			if checks.Load() != 5 {
				t.Fatalf("rechecks = %d", checks.Load())
			}
			f.shutdown()
		})
	}
}

func TestScopedUserChannelConfigurationRejectsMissingAdmission(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	if err := enableTestScopedChannels(f.routes, nil); err == nil {
		t.Fatal("nil admission accepted")
	}
	admission := func(*http.Request, model.Principal) (func(context.Context, string, string, string) error, error) {
		return nil, nil
	}
	if err := enableTestScopedChannels(f.routes, admission); err != nil {
		t.Fatal(err)
	}
	if err := enableTestScopedChannels(f.routes, admission); err == nil {
		t.Fatal("admission replacement accepted")
	}
}

func TestScopedUserChannelRevokedAfterPollStopsInitialSnapshot(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	var checks atomic.Int32
	if err := enableTestScopedChannels(f.routes, func(_ *http.Request, _ model.Principal) (func(context.Context, string, string, string) error, error) {
		return func(_ context.Context, _, _, _ string) error {
			if checks.Add(1) > 1 {
				return &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
			}
			return nil
		}, nil
	}); err != nil {
		t.Fatal(err)
	}
	conn, _, err := f.dial(f.path(sp.Protocol, false), []string{sp.Protocol}, http.Header{"Authorization": {"Bearer native-secret"}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	frame, err := readAPIChannel(t, conn)
	if err == nil || websocket.CloseStatus(err) != websocket.StatusPolicyViolation || frame != nil {
		t.Fatalf("initial content escaped scope refusal: %v %v", frame, err)
	}
	if f.polls.Load() != 1 || checks.Load() != 2 {
		t.Fatalf("polls=%d checks=%d", f.polls.Load(), checks.Load())
	}
	f.shutdown()
}
