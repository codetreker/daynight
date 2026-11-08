// Package webhook coordinates private webhook configuration transactions.
package webhook

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"io"
)

type Destination struct{ Kind, AdapterVersion, URL string }
type Mutation struct {
	Kind, EndpointID, OperationID, IssuedAt, ExpectedUserID string
	IfVersion                                               int64
	RequestSHA256                                           string
	Name                                                    *string
	Enabled                                                 *bool
	Destination                                             *Destination
	HasSubscriptions                                        bool
	Subscriptions                                           []core.SubscriptionInput
	ConfirmProjectIDs                                       []string
	Mode                                                    string
}
type ListQuery struct {
	Query   string
	Enabled *bool
	Limit   int
	Cursor  *string
}
type Result struct {
	Body   any
	Replay bool
}
type Service struct {
	DB                              store.WebhookTransactions
	Random                          io.Reader
	ConfigurationExpansionAvailable bool
	DispatchEnabled                 bool
}
type Owner = wm.Owner
