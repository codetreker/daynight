package server

import (
	"bytes"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"slices"
)

func oauthHTTPClonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func oauthHTTPCloneAuthorization(a store.OAuthAuthorization) store.OAuthAuthorization {
	a.BindingHash = bytes.Clone(a.BindingHash)
	a.Client = bytes.Clone(a.Client)
	a.CodeHash = bytes.Clone(a.CodeHash)
	a.CodeExpiresAt = oauthHTTPClonePointer(a.CodeExpiresAt)
	return a
}
func oauthHTTPCloneGrant(g store.OAuthGrant) store.OAuthGrant {
	g.ClientSnapshot = bytes.Clone(g.ClientSnapshot)
	g.RevokedAt = oauthHTTPClonePointer(g.RevokedAt)
	return g
}
func oauthHTTPCloneIssue(i store.OAuthFamilyIssue) store.OAuthFamilyIssue {
	i.Grant = oauthHTTPCloneGrant(i.Grant)
	i.AccessHash = bytes.Clone(i.AccessHash)
	i.RefreshHash = bytes.Clone(i.RefreshHash)
	return i
}
func oauthHTTPCloneRotation(r store.OAuthRotation) store.OAuthRotation {
	r.Grant = oauthHTTPCloneGrant(r.Grant)
	r.OldHash = bytes.Clone(r.OldHash)
	r.AccessHash = bytes.Clone(r.AccessHash)
	r.RefreshHash = bytes.Clone(r.RefreshHash)
	return r
}
func oauthHTTPCloneBot(b model.Bot) model.Bot {
	b.ResolvedConfiguration.Args = slices.Clone(b.ResolvedConfiguration.Args)
	b.ResolvedConfiguration.Model = oauthHTTPClonePointer(b.ResolvedConfiguration.Model)
	b.ResolvedConfiguration.ReasoningEffort = oauthHTTPClonePointer(b.ResolvedConfiguration.ReasoningEffort)
	b.ResolvedConfiguration.Selection = oauthHTTPClonePointer(b.ResolvedConfiguration.Selection)
	b.RequestedOverrides.WorkerID = oauthHTTPClonePointer(b.RequestedOverrides.WorkerID)
	b.RequestedOverrides.Cwd = oauthHTTPClonePointer(b.RequestedOverrides.Cwd)
	b.RequestedOverrides.Provider = oauthHTTPClonePointer(b.RequestedOverrides.Provider)
	b.RequestedOverrides.Model = oauthHTTPClonePointer(b.RequestedOverrides.Model)
	b.RequestedOverrides.ReasoningEffort = oauthHTTPClonePointer(b.RequestedOverrides.ReasoningEffort)
	b.RoleConfiguration = oauthHTTPClonePointer(b.RoleConfiguration)
	b.SessionID = oauthHTTPClonePointer(b.SessionID)
	b.TestExecutionID = oauthHTTPClonePointer(b.TestExecutionID)
	b.StartupResult.Code = oauthHTTPClonePointer(b.StartupResult.Code)
	b.Deletion = oauthHTTPClonePointer(b.Deletion)
	if b.Deletion != nil {
		b.Deletion.WorkerCleanup.Code = oauthHTTPClonePointer(b.Deletion.WorkerCleanup.Code)
		b.Deletion.ServerCleanup.Code = oauthHTTPClonePointer(b.Deletion.ServerCleanup.Code)
	}
	return b
}
