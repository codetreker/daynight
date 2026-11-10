package session

import (
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"log/slog"
	"time"
)

type ServiceCallsForTest = Operations
type ArchiveOperationForTest = ArchiveOperation
type ArchiveContentForTest = ArchiveContent

func NewRoutesForTest(service ServiceCallsForTest, auth *authhttp.RequestAuthentication, logger *slog.Logger) *Routes {
	return newRoutes(service, auth, logger)
}

func NewRoutesWithPingIntervalForTest(service ServiceCallsForTest, auth *authhttp.RequestAuthentication, logger *slog.Logger, interval time.Duration) *Routes {
	routes := newRoutes(service, auth, logger)
	routes.pingInterval = interval
	return routes
}
