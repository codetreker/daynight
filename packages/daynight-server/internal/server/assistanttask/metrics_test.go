package assistanttask

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestMetricsResponseSerializesCountsWindowAndResolution(t *testing.T) {
	observed := time.Date(2026, 11, 19, 8, 0, 0, 0, time.FixedZone("UTC+8", 8*3600))
	start := observed.Add(-core.MetricsWindow)
	average := 90*time.Minute + 1500*time.Microsecond
	for _, test := range []struct {
		name    string
		average *time.Duration
		want    string
	}{
		{"timed", &average, `5400001`},
		{"untimed", nil, `null`},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := testHandler(t, func(context.Context, core.Actor, string, ...any) (any, error) {
				return model.AssistantTaskMetrics{ObservedAt: observed, WindowStart: start, WindowEnd: observed, ActionCount: 7, EffectiveCount: 3, IneffectiveCount: 2, InconclusiveCount: 1,
					EscalationCount: 4, ResultUnknownCount: 5, ClosureCount: 6, UntimedClosureCount: 2, RecurringItemCount: 1, AverageResolution: test.average}, nil
			}, io.Discard)
			response := request(h, http.MethodGet, taskPath+"/metrics", "", false)
			var body map[string]json.RawMessage
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &body) != nil {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			want := map[string]string{
				"observedAt": `"2026-11-19T00:00:00Z"`, "windowStart": `"2026-10-20T00:00:00Z"`, "windowEnd": `"2026-11-19T00:00:00Z"`,
				"actionCount": `7`, "outcomes": `{"effective":3,"ineffective":2,"inconclusive":1}`, "escalationCount": `4`, "resultUnknownCount": `5`,
				"closureCount": `6`, "untimedClosureCount": `2`, "recurringItemCount": `1`, "averageResolutionMs": test.want,
			}
			if len(body) != len(want) {
				t.Fatalf("unexpected fields: %s", response.Body)
			}
			for key, value := range want {
				if string(body[key]) != value {
					t.Fatalf("%s=%s want %s", key, body[key], value)
				}
			}
		})
	}
}
