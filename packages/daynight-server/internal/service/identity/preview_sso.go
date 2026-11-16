package identity

import (
	"context"
	"errors"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type previewOperations interface {
	Create(context.Context, store.PreviewSSODAO, string, time.Time) (model.PreviewSSOLogin, error)
	Start(context.Context, store.PreviewSSODAO, string, time.Time) (core.PreviewSSOStart, error)
	Authorize(context.Context, store.PreviewSSODAO, string, string, model.Principal, time.Time) (core.PreviewSSOAuthorization, error)
	Redeem(context.Context, store.PreviewSSODAO, string, string, string, time.Time) (core.PreviewSSORedemption, error)
	Complete(context.Context, store.PreviewSSODAO, string, string, time.Time) (string, error)
	Authenticate(context.Context, store.PreviewSSODAO, string, time.Time) (model.Principal, time.Time, error)
}

// PreviewSSO coordinates preview identity operations without an HTTP adapter.
type PreviewSSO struct {
	writer store.PreviewSSOWriter
	ops    previewOperations
	now    func() time.Time
}

// NewPreviewSSO binds a preview SSO module to transaction-scoped storage.
func NewPreviewSSO(writer store.PreviewSSOWriter, mainOrigin, previewOrigin, callbackURL string) (*PreviewSSO, error) {
	ops, err := core.NewPreviewSSO(mainOrigin, previewOrigin, callbackURL)
	if err != nil {
		return nil, err
	}
	return &PreviewSSO{writer: writer, ops: ops, now: time.Now}, nil
}

// run returns domain failures to the writer, so any preceding writes roll back.
// It exposes results only after an explicitly confirmed commit.
func (s *PreviewSSO) run(ctx context.Context, operation func(store.PreviewSSODAO) error) error {
	completion, err := s.writer.WritePreviewSSO(ctx, operation)
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return errors.New("preview SSO transaction did not confirm commit")
	}
	return nil
}

func (s *PreviewSSO) Create(ctx context.Context, returnURL string) (model.PreviewSSOLogin, error) {
	var result model.PreviewSSOLogin
	err := s.run(ctx, func(dao store.PreviewSSODAO) error {
		var err error
		result, err = s.ops.Create(ctx, dao, returnURL, s.now().UTC())
		return err
	})
	if err != nil {
		return model.PreviewSSOLogin{}, err
	}
	return result, nil
}

func (s *PreviewSSO) Start(ctx context.Context, id string) (core.PreviewSSOStart, error) {
	var result core.PreviewSSOStart
	err := s.run(ctx, func(dao store.PreviewSSODAO) error {
		var err error
		result, err = s.ops.Start(ctx, dao, id, s.now().UTC())
		return err
	})
	if err != nil {
		return core.PreviewSSOStart{}, err
	}
	return result, nil
}

func (s *PreviewSSO) Authorize(ctx context.Context, id, state string, principal model.Principal) (core.PreviewSSOAuthorization, error) {
	var result core.PreviewSSOAuthorization
	err := s.run(ctx, func(dao store.PreviewSSODAO) error {
		var err error
		result, err = s.ops.Authorize(ctx, dao, id, state, principal, s.now().UTC())
		return err
	})
	if err != nil {
		return core.PreviewSSOAuthorization{}, err
	}
	return result, nil
}

func (s *PreviewSSO) Redeem(ctx context.Context, code, state, binding string) (core.PreviewSSORedemption, error) {
	var result core.PreviewSSORedemption
	err := s.run(ctx, func(dao store.PreviewSSODAO) error {
		var err error
		result, err = s.ops.Redeem(ctx, dao, code, state, binding, s.now().UTC())
		return err
	})
	if err != nil {
		return core.PreviewSSORedemption{}, err
	}
	return result, nil
}

func (s *PreviewSSO) Complete(ctx context.Context, id, secret string) (string, error) {
	var result string
	err := s.run(ctx, func(dao store.PreviewSSODAO) error {
		var err error
		result, err = s.ops.Complete(ctx, dao, id, secret, s.now().UTC())
		return err
	})
	if err != nil {
		return "", err
	}
	return result, nil
}

func (s *PreviewSSO) Authenticate(ctx context.Context, secret string) (model.Principal, time.Time, error) {
	var principal model.Principal
	var expires time.Time
	err := s.run(ctx, func(dao store.PreviewSSODAO) error {
		var err error
		principal, expires, err = s.ops.Authenticate(ctx, dao, secret, s.now().UTC())
		return err
	})
	if err != nil {
		return model.Principal{}, time.Time{}, err
	}
	return principal, expires, nil
}
