package webhook_test

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"time"
)

func newTestRunner(db store.WebhookDeliveryTransactions, svc *webhook.Service, enabled bool) *webhook.Runner {
	runner := webhook.NewRunner(db, svc, enabled)
	runner.SetTestPollInterval(20 * time.Millisecond)
	return runner
}
