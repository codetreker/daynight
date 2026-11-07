package webhook_test

import (
	"strings"
	"testing"
)

func TestHistoryHTTPMissingEventIsInternalButSQLFailureUnavailable(t *testing.T) {
	for _, tc := range []struct {
		name, mutation string
		status         int
		code           string
	}{
		{"missing event", `DELETE FROM webhook_events`, 500, "internal_error"},
		{"unavailable event table", `DROP TABLE webhook_events`, 503, "dependency_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRetentionHTTP(t, false)
			if _, err := r.f.db.Pool.Exec(r.f.ctx, tc.mutation); err != nil {
				t.Fatal(err)
			}
			select {
			case reply := <-r.call("GET", "", ""):
				if reply.err != nil || reply.status != tc.status || !strings.Contains(reply.body, `"code":"`+tc.code+`"`) {
					t.Fatalf("status=%d body=%s err=%v", reply.status, reply.body, reply.err)
				}
			case <-r.f.ctx.Done():
				t.Fatal(r.f.ctx.Err())
			}
		})
	}
}
