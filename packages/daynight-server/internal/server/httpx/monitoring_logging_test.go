package httpx

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestMonitoringFailureLogsSafeDependencyClassification(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	secret := errors.New("redis://secret:password@example.invalid/private")
	err := &model.Fault{Code: "monitoring_unavailable", Message: "Worker monitoring is unavailable.", Cause: &store.MonitoringError{Kind: "network", Cause: secret}}
	LogFailure(logger, context.Background(), "worker_monitoring", "read", err)
	if !strings.Contains(output.String(), `"dependency_cause":"network"`) || strings.Contains(output.String(), secret.Error()) || !errors.Is(err, secret) {
		t.Fatalf("unsafe or unclassified diagnostic: %s", output.String())
	}
}
