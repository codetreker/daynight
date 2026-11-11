package auth

import (
	"log/slog"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"

	"testing"
)

type authHarness = testsupport.AuthHarness[*Authentication]

func authTestHarness(t *testing.T) *authHarness {
	return testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*Authentication, error) {
		return NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
}
