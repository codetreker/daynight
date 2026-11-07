package webhook

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// Owner identifies a personal user or a shared team. Personal owners are always
// derived from the authenticated principal by the HTTP layer.
type Owner struct{ Kind, ID string }

type Destination struct{ Kind, AdapterVersion, URL string }

type ListQuery struct {
	Query   string
	Enabled *bool
	Limit   int
	Cursor  *string
}

// Mutation contains normalized request fields and the digest of the original
// request bytes. IssuedAt retains the exact accepted wire representation.
type Mutation struct {
	Kind, EndpointID, OperationID, IssuedAt, ExpectedUserID string
	IfVersion                                               int64
	RequestSHA256                                           string
	Name                                                    *string
	Enabled                                                 *bool
	Destination                                             *Destination
	HasSubscriptions                                        bool
	Mode                                                    string
}

type MutationResult struct {
	Body   any
	Replay bool
}

// Service supplies authorized current projections and transactional mutations.
// Mutation results must already reflect a fresh authorized snapshot after the
// write transaction has released its connection.
type Service interface {
	Catalog(context.Context, model.Principal) (any, error)
	List(context.Context, model.Principal, Owner, ListQuery) (any, error)
	Get(context.Context, model.Principal, Owner, string) (any, error)
	Operation(context.Context, model.Principal, Owner, string) (any, error)
	Secret(context.Context, model.Principal, Owner, string) (any, error)
	Mutate(context.Context, model.Principal, Owner, Mutation) (MutationResult, error)
}
