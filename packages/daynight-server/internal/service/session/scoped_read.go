package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// SessionReadAuthorization locks and reads the current authority for the
// original credential in the supplied transaction. OAuth implementations lock
// the grant before its access token and preserve its original resource binding.
type SessionReadAuthorization func(context.Context, store.SessionScope, model.CredentialAuthorization) (model.CredentialAuthorization, error)

// ScopedReadChecker rechecks Session read authority and existing resource
// access at a delivery boundary. It does not retain transaction locks for I/O.
type ScopedReadChecker struct {
	service *Service
	current SessionReadAuthorization
}

func NewScopedReadChecker(service *Service, current SessionReadAuthorization) *ScopedReadChecker {
	return &ScopedReadChecker{service: service, current: current}
}

func (s *ScopedReadChecker) currentCheck(ctx context.Context, expected model.CredentialAuthorization, scope store.SessionScope) (func() error, error) {
	current, err := s.current(ctx, scope, expected)
	if err != nil {
		return nil, err
	}
	if current.Principal != expected.Principal || current.Profile != expected.Profile {
		return nil, model.Unauthenticated(errors.New("credential authorization identity changed"))
	}
	return func() error { return scopeadmission.Require(current, scopepolicy.SessionRead) }, nil
}

// CheckSessionRead verifies the current authorization and existing Session
// resource access. An empty id checks Task-level visibility for directory
// reads, whose individual rows retain their existing resource checks. A
// nonempty id uses the existing live browser binding, including Test ownership.
func (s *ScopedReadChecker) CheckSessionRead(ctx context.Context, auth model.CredentialAuthorization, project, task, id string) error {
	if s == nil || s.service == nil || s.current == nil {
		return errors.New("session read authorization is unavailable")
	}
	if err := auth.Validate(); err != nil {
		return err
	}
	p := auth.Principal
	if id != "" {
		return s.service.browserForReadCheck(ctx, p, project, task, id, core.BrowserAccess, func(scope store.SessionScope) (func() error, error) {
			return s.currentCheck(ctx, auth, scope)
		}, func(*core.Access) error { return nil })
	}
	if project == "" || task == "" {
		return &model.Fault{Code: "forbidden", Message: "Task history requires a Task scope."}
	}
	op, err := s.service.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.service.write(ctx, op.Finish, func(scope store.SessionScope) error {
		if _, err := op.LockTask(ctx, scope, project, task); err != nil {
			return err
		}
		check, err := s.currentCheck(ctx, auth, scope)
		if err != nil {
			return err
		}
		if err := op.LockTaskReadCredential(ctx, scope, p); err != nil {
			return err
		}
		if err := op.CheckProjectAccess(ctx, scope, p, project); err != nil {
			return err
		}
		return check()
	})
}

// SessionSnapshotAuthorization reads the original credential's current policy
// from the supplied consistent snapshot, preserving its resource binding.
type SessionSnapshotAuthorization func(context.Context, store.SnapshotScope, model.CredentialAuthorization) (model.CredentialAuthorization, error)

type scopedReadKey struct{}
type scopedReadContext struct {
	auth     model.CredentialAuthorization
	current  SessionReadAuthorization
	snapshot SessionSnapshotAuthorization
}

// WithScopedSessionRead marks a read-only Session operation for scoped
// admission. It must not be used for Session write or producer operations.
func WithScopedSessionRead(ctx context.Context, auth model.CredentialAuthorization, current SessionReadAuthorization, snapshot SessionSnapshotAuthorization) context.Context {
	return context.WithValue(ctx, scopedReadKey{}, scopedReadContext{auth: auth, current: current, snapshot: snapshot})
}

func readCheck(ctx context.Context, scope store.SessionScope, principal model.Principal) (func() error, error) {
	admission, ok := ctx.Value(scopedReadKey{}).(scopedReadContext)
	if !ok {
		return func() error { return nil }, nil
	}
	if err := admission.auth.Validate(); err != nil {
		return nil, err
	}
	if admission.current == nil || admission.auth.Principal != principal {
		return nil, model.Unauthenticated(errors.New("session read authorization is unavailable or mismatched"))
	}
	checker := ScopedReadChecker{current: admission.current}
	return checker.currentCheck(ctx, admission.auth, scope)
}

func snapshotReadCheck(ctx context.Context, scope store.SnapshotScope, principal model.Principal) (func() error, error) {
	admission, ok := ctx.Value(scopedReadKey{}).(scopedReadContext)
	if !ok {
		return func() error { return nil }, nil
	}
	if err := admission.auth.Validate(); err != nil {
		return nil, err
	}
	if admission.snapshot == nil || admission.auth.Principal != principal {
		return nil, model.Unauthenticated(errors.New("session snapshot authorization is unavailable or mismatched"))
	}
	current, err := admission.snapshot(ctx, scope, admission.auth)
	if err != nil {
		return nil, err
	}
	if current.Principal != principal || current.Profile != admission.auth.Profile {
		return nil, model.Unauthenticated(errors.New("credential authorization identity changed"))
	}
	return func() error { return scopeadmission.Require(current, scopepolicy.SessionRead) }, nil
}
