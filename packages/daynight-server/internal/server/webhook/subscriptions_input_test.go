package webhook

import (
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestSubscriptionWireValidation(t *testing.T) {
	project := endpointID
	good := createBody("https://example.test/receiver")
	replacement := fmt.Sprintf(`"subscriptions":[{"id":null,"projectId":"%s","eventTypes":["task.created"]},{"id":null,"projectId":"%s","eventTypes":["task.created"]}]`, project, project)
	s := &fakeService{}
	w := request(fixture(s, io.Discard), "POST", "/api/v1/me/webhooks", strings.Replace(good, `"subscriptions":[]`, replacement, 1))
	if w.Code != 201 || len(s.input.Subscriptions) != 2 || s.input.Subscriptions[0].ID != nil {
		t.Fatalf("status %d input %#v", w.Code, s.input)
	}
	for _, invalid := range []string{
		fmt.Sprintf(`[{"projectId":"%s","eventTypes":["task.created"]}]`, project),
		fmt.Sprintf(`[{"id":null,"projectId":"%s","eventTypes":[]}]`, project),
		fmt.Sprintf(`[{"id":null,"projectId":"%s","eventTypes":["task.created","task.created"]}]`, project),
		fmt.Sprintf(`[{"id":null,"projectId":"%s","eventTypes":["task.unknown"]}]`, project),
		fmt.Sprintf(`[{"id":"%s","projectId":"%s","eventTypes":["task.created"]},{"id":"%s","projectId":"%s","eventTypes":["task.created"]}]`, operationID, project, operationID, project),
	} {
		fake := &fakeService{}
		w := request(fixture(fake, io.Discard), "POST", "/api/v1/me/webhooks", strings.Replace(good, `"subscriptions":[]`, `"subscriptions":`+invalid, 1))
		if w.Code != 400 || fake.calls != 0 {
			t.Errorf("invalid %s: %d calls %d", invalid, w.Code, fake.calls)
		}
	}
}
