package session

import (
	"log/slog"
	"time"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

func NewRoutesWithPingIntervalForTest(service *sessionservice.Service, auth *authhttp.Authentication, logger *slog.Logger, interval time.Duration) *Routes {
	routes := NewRoutes(service, auth, logger)
	routes.pingInterval = interval
	return routes
}
