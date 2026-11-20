package session

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

// ReadContextBinder attaches the authenticated credential's read authorization
// to the request context. It must preserve the principal and credential profile.
type ReadContextBinder func(*http.Request, model.Principal) (context.Context, error)

// ReadAuthorization resolves the authenticated request without replacing its
// original principal or profile.
type ReadAuthorization func(*http.Request, model.Principal) (model.CredentialAuthorization, error)

type ScopedReadChecker interface {
	CheckSessionRead(context.Context, model.CredentialAuthorization, string, string, string) error
}

// NewScopedReadContextBinder prepares transaction-bound read authorization.
func NewScopedReadContextBinder(resolve ReadAuthorization, current ss.SessionReadAuthorization, snapshot ss.SessionSnapshotAuthorization) (ReadContextBinder, error) {
	if resolve == nil || current == nil || snapshot == nil {
		return nil, errors.New("scoped Session read dependencies are required")
	}
	return func(r *http.Request, p model.Principal) (context.Context, error) {
		a, err := resolve(r, p)
		if err != nil {
			return nil, err
		}
		if a.Principal != p {
			return nil, model.Unauthenticated(errors.New("Session credential identity changed"))
		}
		if err := a.Validate(); err != nil {
			return nil, err
		}
		return ss.WithScopedSessionRead(r.Context(), a, current, snapshot), nil
	}, nil
}

// NewScopedUserChannelAdmission retains the handshake identity and obtains the
// current policy and resource authorization for every later delivery.
func NewScopedUserChannelAdmission(resolve ReadAuthorization, checker ScopedReadChecker) (UserChannelAdmission, error) {
	if resolve == nil || checker == nil {
		return nil, errors.New("scoped Session channel dependencies are required")
	}
	return func(r *http.Request, p model.Principal) (func(context.Context, string, string, string) error, error) {
		a, err := resolve(r, p)
		if err != nil {
			return nil, err
		}
		if a.Principal != p {
			return nil, model.Unauthenticated(errors.New("Session credential identity changed"))
		}
		if err := a.Validate(); err != nil {
			return nil, err
		}
		return func(ctx context.Context, project, task, id string) error {
			return checker.CheckSessionRead(ctx, a, project, task, id)
		}, nil
	}, nil
}

// EnableScopedSessionReads installs the read context before routes are served.
// Producer and command routes do not receive this context.
func (h *Routes) EnableScopedSessionReads(bind ReadContextBinder, admission UserChannelAdmission) error {
	if bind == nil || admission == nil {
		return errors.New("Session read context and channel admission are required")
	}
	h.mutex.Lock()
	defer h.mutex.Unlock()
	if h.closing || h.reserved != 0 || h.readContext != nil || h.userChannelAdmission != nil {
		return errors.New("Session read context cannot be changed")
	}
	h.readContext = bind
	h.userChannelAdmission = admission
	return nil
}

func bindSessionRead(r *http.Request, p model.Principal, bind ReadContextBinder) (*http.Request, error) {
	if bind == nil {
		return r, nil
	}
	ctx, err := bind(r, p)
	if err != nil {
		return r, err
	}
	if ctx == nil {
		return r, errors.New("Session read context is unavailable")
	}
	return r.WithContext(ctx), nil
}

func (h *Routes) bindReadContext(r *http.Request, p model.Principal) (*http.Request, error) {
	h.mutex.Lock()
	bind := h.readContext
	h.mutex.Unlock()
	return bindSessionRead(r, p, bind)
}

type scopedReadAuthentication struct {
	base   inspectionAuthentication
	bind   ReadContextBinder
	logger *slog.Logger
}

func (a scopedReadAuthentication) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return a.base.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			next(w, r, p)
			return
		}
		bound, err := bindSessionRead(r, p, a.bind)
		if err != nil {
			httpx.WriteError(w, r, a.logger, "session", "read admission", err)
			return
		}
		next(w, bound, p)
	})
}

// RegisterScopedHistoryRoutes configures authorization for the history routes.
func RegisterScopedHistoryRoutes(mux httpx.RouteRegistrar, reader HistoryReader, auth inspectionAuthentication, bind ReadContextBinder, logger *slog.Logger) error {
	if mux == nil || reader == nil || auth == nil || bind == nil {
		return errors.New("scoped Session history dependencies are required")
	}
	RegisterHistoryRoutes(mux, reader, scopedReadAuthentication{auth, bind, logger}, logger)
	return nil
}

// RegisterScopedInspectionRoutes configures authorization for inspection.
func RegisterScopedInspectionRoutes(mux httpx.RouteRegistrar, reader inspectionReader, auth inspectionAuthentication, bind ReadContextBinder, logger *slog.Logger) error {
	if mux == nil || reader == nil || auth == nil || bind == nil {
		return errors.New("scoped Session inspection dependencies are required")
	}
	RegisterInspectionRoutes(mux, reader, scopedReadAuthentication{auth, bind, logger}, logger)
	return nil
}

// RegisterScopedGroupDirectoryRoutes configures authorization for grouped history.
func RegisterScopedGroupDirectoryRoutes(mux httpx.RouteRegistrar, reader groupDirectoryReader, auth inspectionAuthentication, bind ReadContextBinder, logger *slog.Logger) error {
	if mux == nil || reader == nil || auth == nil || bind == nil {
		return errors.New("scoped Session directory dependencies are required")
	}
	RegisterGroupDirectoryRoutes(mux, reader, scopedReadAuthentication{auth, bind, logger}, logger)
	return nil
}
