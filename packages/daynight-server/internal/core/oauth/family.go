// Package oauth implements transaction-bound OAuth credential family operations.
package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const (
	Scope          = "daynight:mcp"
	RefreshPrefix  = "dnmcr_"
	GrantLifetime  = 30 * 24 * time.Hour
	AccessLifetime = time.Hour
)

// IssueInput contains client facts already validated by the authorization flow.
// ClientSnapshot must contain the immutable client metadata needed by consumers.
type IssueInput struct {
	UserID, ClientID, Resource string
	ClientSnapshot             json.RawMessage
}

// IssuedFamily contains secrets returned only from a successful DAO operation.
// They become usable only if the caller's enclosing transaction commits.
type IssuedFamily struct {
	Grant                               store.OAuthGrant
	AccessID, AccessToken, RefreshToken string
	AccessExpiresAt                     time.Time
}

func invalidInput() error {
	return &model.Fault{Code: "invalid_input", Message: "Invalid OAuth credential family input."}
}

// IssueFamily inserts the grant and both initial token hashes through the
// supplied transaction-bound DAO. The caller owns commit, rollback, and any
// prerequisite client-row lock; secrets must not be delivered before commit.
func IssueFamily(ctx context.Context, dao store.CredentialFamilyDAO, input IssueInput, now time.Time) (IssuedFamily, error) {
	return issueFamily(ctx, dao, input, mcpProfile, now)
}

// IssueAPIFamily issues the fixed application family without an authorization-code client.
// The caller owns the transaction and may deliver secrets only after confirmed commit.
func IssueAPIFamily(ctx context.Context, dao store.CredentialFamilyDAO, userID, resource string, now time.Time) (IssuedFamily, error) {
	return issueFamily(ctx, dao, IssueInput{UserID: userID, ClientID: APIClientID, Resource: resource, ClientSnapshot: json.RawMessage(`{"clientId":"` + APIClientID + `","clientName":"` + APIClientName + `"}`)}, apiProfile, now)
}

func issueFamily(ctx context.Context, dao store.CredentialFamilyDAO, input IssueInput, profile credentialProfile, now time.Time) (IssuedFamily, error) {
	user, err := model.CanonicalID(input.UserID)
	if err != nil || user == uuid.Nil.String() || input.ClientID == "" || !utf8.ValidString(input.ClientID) || strings.ContainsRune(input.ClientID, 0) || !profile.validResource(input.Resource) || !json.Valid(input.ClientSnapshot) || len(input.ClientSnapshot) == 0 || strings.TrimSpace(string(input.ClientSnapshot))[0] != '{' || now.IsZero() {
		return IssuedFamily{}, invalidInput()
	}
	now = now.UTC().Truncate(time.Microsecond)
	grant := store.OAuthGrant{ID: uuid.NewString(), UserID: user, ClientID: input.ClientID, Resource: input.Resource, Scope: profile.scope, ClientSnapshot: append(json.RawMessage(nil), input.ClientSnapshot...), CreatedAt: now, ExpiresAt: now.Add(GrantLifetime)}
	issued := IssuedFamily{Grant: grant, AccessID: uuid.NewString(), AccessToken: secret.Random(profile.accessPrefix), RefreshToken: secret.Random(profile.refreshPrefix), AccessExpiresAt: now.Add(AccessLifetime)}
	issue := store.OAuthFamilyIssue{Grant: grant, AccessID: issued.AccessID, AccessHash: secret.Hash(issued.AccessToken), RefreshHash: secret.Hash(issued.RefreshToken), AccessExpiresAt: issued.AccessExpiresAt}
	if err := dao.IssueFamily(ctx, issue); err != nil {
		return IssuedFamily{}, err
	}
	return issued, nil
}

// AuthenticateAccess validates the access format and exact configured resource
// in the transaction-bound DAO. Resource must come from the server configuration,
// not the request. A missing, expired or revoked token is unauthenticated.
func AuthenticateAccess(ctx context.Context, dao store.CredentialFamilyDAO, token, resource string, now time.Time) (store.OAuthAccessIdentity, error) {
	profile, valid := profileForResource(resource)
	if !valid || !secret.Valid(token, profile.accessPrefix) || now.IsZero() {
		return store.OAuthAccessIdentity{}, model.Unauthenticated(nil)
	}
	identity, err := dao.AuthenticateAccess(ctx, secret.Hash(token), []store.OAuthBinding{profile.binding(resource)}, now.UTC().Truncate(time.Microsecond))
	if errors.Is(err, model.ErrNotFound) {
		return store.OAuthAccessIdentity{}, model.Unauthenticated(err)
	}
	if err != nil {
		return store.OAuthAccessIdentity{}, err
	}
	grant, err := model.CanonicalID(identity.GrantID)
	if err != nil || grant == uuid.Nil.String() || identity.Principal.Kind != model.OAuthCredential || model.RequirePrincipal(identity.Principal) != nil || identity.Principal.UserID == uuid.Nil.String() || identity.Principal.CredentialID == uuid.Nil.String() || !identity.ExpiresAt.After(now) {
		return store.OAuthAccessIdentity{}, model.Unauthenticated(nil)
	}
	return identity, nil
}
