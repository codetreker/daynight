package assistanttask

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestBotAttentionSeenRoute(t *testing.T) {
	const path = "/api/v1/bots/" + testTarget + "/attention/seen"
	calls := 0
	h := testHandler(t, func(ctx context.Context, actor core.Actor, name string, args ...any) (any, error) {
		calls++
		if name != "ClearAttention" || actor.Principal != testPrincipal || !reflect.DeepEqual(args, []any{testTarget}) {
			t.Fatalf("unexpected operation: %s %#v %#v", name, actor, args)
		}
		if actor.BotID != nil {
			return nil, &model.Fault{Code: "forbidden", Message: "Only the user can see attention."}
		}
		return nil, nil
	}, io.Discard)
	response := request(h, "POST", path, `{}`, false)
	var value struct {
		TargetBotID string `json:"targetBotId"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &value) != nil || value.TargetBotID != testTarget || calls != 1 {
		t.Fatalf("seen result: calls=%d status=%d body=%s", calls, response.Code, response.Body)
	}
	assertError(t, request(h, "POST", path, `{}`, true), http.StatusForbidden, "forbidden")
	if calls != 2 {
		t.Fatalf("Bot identity did not reach core: %d", calls)
	}
	for _, tc := range []struct{ path, body string }{
		{path, `{"targetBotId":"` + testBot + `"}`}, {path, ``}, {path, `[]`},
		{path + "?extra=true", `{}`}, {"/api/v1/bots/invalid/attention/seen", `{}`},
	} {
		assertError(t, request(h, "POST", tc.path, tc.body, false), http.StatusBadRequest, "invalid_input")
	}
	response = request(h, "GET", path, "", false)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "POST" || calls != 2 {
		t.Fatalf("invalid protocol reached operation: calls=%d status=%d", calls, response.Code)
	}
}
