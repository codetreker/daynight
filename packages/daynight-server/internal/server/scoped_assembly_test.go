package server

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func TestScopedAssemblyRejectsIncompleteDependencies(t *testing.T) {
	failure := errors.New("controlled assembly failure")
	for _, tc := range []struct {
		name    string
		change  func(*service.App)
		message string
		cause   error
	}{
		{"scope construction", func(a *service.App) { a.ScopeError = failure }, "controlled assembly failure", failure},
		{"scope source", func(a *service.App) { a.Scoped = nil }, "credential scope assembly is unavailable", nil},
		{"preview construction", func(a *service.App) { a.PreviewSSOError = failure }, "controlled assembly failure", failure},
		{"usage construction", func(a *service.App) { a.UsageError = failure }, "controlled assembly failure", failure},
		{"usage recorder", func(a *service.App) { a.CredentialUsage = nil }, "credential usage recorder is unavailable", nil},
		{"OAuth profile", func(a *service.App) { a.OAuthProfile = nil; a.OAuthError = failure }, "OAuth public profile is unavailable", failure},
		{"Bot authorization", func(a *service.App) { a.Bots = nil }, "scoped Bot services are required", nil},
		{"download authorization", func(a *service.App) { a.Downloads = nil }, "scoped download service is required", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := configuredTestConfig()
			client, err := service.NewIdentityClient(cfg.UniAuth)
			if err != nil {
				t.Fatal(err)
			}
			app := service.NewModules(cfg, newHTTPTestStore(t), nil, attachmentTestFiles(t), client)
			app.CredentialUsage = unusedUsageRecorder(testLogger())
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := app.Engine.Stop(ctx); err != nil {
					t.Error(err)
				}
			})
			tc.change(app)
			handler, err := New(app, cfg, testLogger())
			if handler != nil || err == nil || !strings.Contains(err.Error(), tc.message) || tc.cause != nil && !errors.Is(err, tc.cause) {
				t.Fatalf("incomplete assembly published handler=%v error=%v; want %q cause=%v", handler, err, tc.message, tc.cause)
			}
		})
	}
}
