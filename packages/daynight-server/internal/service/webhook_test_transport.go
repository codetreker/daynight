//go:build webhooktest

package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

// SetControlledWebhookTestTransport is excluded from production builds.
func (a *App) SetControlledWebhookTestTransport(client *httpoutbound.Client) error {
	if a.webhookRuntime == nil {
		return errors.New("webhook runtime unavailable")
	}
	return a.webhookRuntime.runner.SetControlledTestTransport(client)
}

// PrestartControlledTestRetention causes the later app Start to fail after the
// delivery runner has started; only webhooktest builds expose this fault.
func (a *App) PrestartControlledTestRetention(ctx context.Context) error {
	return a.webhookRuntime.retention.Start(ctx)
}

func (a *App) ControlledTestRunnerDone() <-chan struct{} {
	return a.webhookRuntime.runner.ControlledTestDone()
}
