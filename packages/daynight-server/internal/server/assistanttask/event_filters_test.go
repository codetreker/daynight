package assistanttask

import (
	"context"
	"io"
	"reflect"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
)

func TestEventRoutesPassTypeFilters(t *testing.T) {
	for _, test := range []struct {
		path string
		args []any
		bot  bool
	}{
		{taskPath + "/events?type=inbound", []any{testTask, core.PageInput{Limit: 50, Type: "inbound"}}, false},
		{taskPath + "/events?excludeType=inbound&state=pending", []any{testTask, core.PageInput{Limit: 50, State: "pending", ExcludeType: "inbound"}}, false},
		{"/api/v1/assistant-task-events?type=inbound&limit=5", []any{"", core.PageInput{Limit: 5, TargetBotID: testBot, Type: "inbound"}}, true},
		{"/api/v1/assistant-task-events?excludeType=inbound&cursor=opaque", []any{"", core.PageInput{Limit: 50, Cursor: "opaque", TargetBotID: testBot, ExcludeType: "inbound"}}, true},
	} {
		t.Run(test.path, func(t *testing.T) {
			calls := 0
			h := testHandler(t, func(_ context.Context, _ core.Actor, name string, args ...any) (any, error) {
				calls++
				if name != "ListEvents" || !reflect.DeepEqual(args, test.args) {
					t.Fatalf("read %s %+v", name, args)
				}
				return nil, nil
			}, io.Discard)
			response := request(h, "GET", test.path, "", test.bot)
			if response.Code != 200 || calls != 1 {
				t.Fatalf("response=%s calls=%d", response.Body, calls)
			}
		})
	}
}

func TestEventTypeFiltersAreRefusedBeforeOperations(t *testing.T) {
	h := testHandler(t, func(context.Context, core.Actor, string, ...any) (any, error) {
		t.Fatal("refused request reached business operation")
		return nil, nil
	}, io.Discard)
	for _, path := range []string{
		taskPath + "/events?type=",
		taskPath + "/events?excludeType=",
		taskPath + "/events?type=inbound&type=report",
		taskPath + "/records?type=inbound",
		taskPath + "/inquiries?excludeType=inbound",
		"/api/v1/assistant-tasks?type=inbound",
	} {
		assertError(t, request(h, "GET", path, "", false), 400, "invalid_input")
	}
}
