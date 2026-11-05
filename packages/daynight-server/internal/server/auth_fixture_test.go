package server

import (
	"log/slog"
	"testing"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

type authHarness = testsupport.AuthHarness[*authhttp.Authentication]

func authTestHarness(t *testing.T) *authHarness {
	return testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, configpkg.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
}
