package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"testing"
)

type operationRejectedOAuth struct{ t *testing.T }

func (r *operationRejectedOAuth) AuthenticateAccess(context.Context, string, string) (store.OAuthAccessIdentity, error) {
	r.t.Errorf("unexpected OAuth.AuthenticateAccess call")
	var result0 store.OAuthAccessIdentity
	return result0, errors.New("unexpected OAuth.AuthenticateAccess")
}
