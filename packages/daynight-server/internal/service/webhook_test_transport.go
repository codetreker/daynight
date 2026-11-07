//go:build webhooktest

package service

import (
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
