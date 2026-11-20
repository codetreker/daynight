package runtime

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ProducerAuthorization reads and locks the original PAT's current policy in
// the supplied Session transaction. It must preserve the principal identity.
type ProducerAuthorization func(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error)

func requireProducer(ctx context.Context, scope store.SessionScope, p model.Principal, source ProducerAuthorization) error {
	if source == nil {
		return nil
	}
	auth, err := source(ctx, scope, p)
	if err != nil {
		return err
	}
	if p.Kind != model.PATCredential || auth.Principal != p || auth.Profile != model.ScopedPATProfile {
		return errors.New("Bot producer authorization changed credential identity or profile")
	}
	return scopeadmission.Require(auth, scopepolicy.SessionProduce)
}
