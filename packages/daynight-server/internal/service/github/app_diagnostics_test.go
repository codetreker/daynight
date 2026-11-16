package github

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAppDiagnosticsClassifiesAuthorizationAndCancellation(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{store.ErrGitHubAppWorkUnavailable, "github_authorization_changed"},
		{errLease, "github_authorization_changed"},
		{context.Canceled, "cancelled"},
		{context.DeadlineExceeded, "deadline_exceeded"},
	} {
		attrs := appErrorAttributes(tc.err)
		if len(attrs) != 2 || attrs[0] != "result_code" || attrs[1] != tc.code {
			t.Fatalf("diagnostics: %+v", attrs)
		}
	}
}
