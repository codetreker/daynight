package oauth

import (
	"context"
	"net/url"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type clientOperations struct {
	take                func(context.Context, string, string, string) (bool, error)
	parseMetadata       func([]byte, string) (core.ClientMetadata, error)
	parseStoredMetadata func([]byte, string) (core.ClientMetadata, error)
	freezeClient        func(string, string, core.ClientMetadata, time.Time, string) (core.ValidatedClient, error)
}

type authorizationOperations struct {
	take             func(context.Context, string, string, string) (bool, error)
	resolveClient    func(context.Context, string, string) (core.ValidatedClient, error)
	validStart       func(string, string, string, string, string, string, string) bool
	callbackURI      func(string, url.Values) (string, error)
	newAuthorization func(core.AuthorizationRequest, time.Time) store.OAuthAuthorization
	validBinding     func(string) bool
	bound            func(store.OAuthAuthorization, string) bool
	status           func(store.OAuthAuthorization, time.Time) (string, bool)
	validDecision    func(string) bool
	decide           func(*store.OAuthAuthorization, string, string, string, string, time.Time) (string, error)
	validCodeInput   func(string, string, string, string, string) bool
	checkBinding     func(store.OAuthAuthorization, core.CodeBinding) error
	checkCode        func(store.OAuthAuthorization, core.CodeBinding, time.Time) (bool, error)
	checkExpiry      func(store.OAuthAuthorization, time.Time) error
	issueFamily      func(context.Context, store.CredentialFamilyDAO, core.IssueInput, time.Time) (core.IssuedFamily, error)
	consume          func(*store.OAuthAuthorization, string, time.Time)
	prune            func(context.Context, store.AuthorizationDAO, time.Time, int) (int, error)
}
