package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

type GitHubAppAdminPage struct {
	Items   []githubpr.AdminProfile
	HasMore bool
}

type GitHubAppInvitationRecord struct {
	Invitation                     githubpr.AppInvitation
	CurrentIssuerMembershipVersion *int64
}

type GitHubAppInvitationPage struct {
	Items   []GitHubAppInvitationRecord
	HasMore bool
}

type GitHubAppAdminReader interface {
	App(context.Context, string) (githubpr.AppIdentity, error)
	Membership(context.Context, string, string) (githubpr.AdminMembership, error)
	AdminPage(context.Context, string, Page) (GitHubAppAdminPage, error)
	Invitation(context.Context, string, string) (githubpr.AppInvitation, error)
	InvitationByHash(context.Context, []byte) (githubpr.AppInvitation, error)
	InvitationPage(context.Context, string, Page) (GitHubAppInvitationPage, error)
	ObservedAt(context.Context) (time.Time, error)
}

// GitHubAppAdminWriter is bound to the live App root locked by its scope.
// Membership and invitation mutations use the same root before member or
// invitation rows, keeping last-admin and issuer eligibility checks atomic.
type GitHubAppAdminWriter interface {
	GitHubAppAdminReader
	CreateInvitation(context.Context, githubpr.AppInvitation, []byte) error
	RevokeInvitation(context.Context, string, string, time.Time) error
	ConsumeInvitation(context.Context, string, string, string, time.Time) error
	AddAdmin(context.Context, string, string) (githubpr.AdminMembership, error)
	RemoveAdmin(context.Context, string, string, int64) error
	CountAdmins(context.Context, string) (int64, error)
}

type GitHubAppAdminStore interface {
	ReadGitHubAppAdmins(context.Context, func(GitHubAppAdminReader) error) error
	WriteGitHubAppAdmins(context.Context, string, func(GitHubAppAdminWriter) error) (Completion, error)
}
