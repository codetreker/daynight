package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ProducerAuthorization reads and locks the original PAT and its current policy
// in the supplied transaction. It must not substitute request-time authority.
type ProducerAuthorization func(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error)

func (s *Service) requireProducer(ctx context.Context, scope store.SessionScope, p model.Principal) error {
	if s.producerAuthorization == nil {
		return nil
	}
	if p.Kind != model.PATCredential {
		return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
	}
	auth, err := s.producerAuthorization(ctx, scope, p)
	if err != nil {
		return err
	}
	if auth.Principal != p || auth.Profile != model.ScopedPATProfile {
		return errors.New("session producer authorization changed identity or profile")
	}
	return scopeadmission.Require(auth, scopepolicy.SessionProduce)
}
