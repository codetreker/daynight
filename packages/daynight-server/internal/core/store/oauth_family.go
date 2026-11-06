package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// CredentialFamilyWriter binds family operations to the caller's transaction.
// A scope and its DAO are valid only during the callback.
type CredentialFamilyWriter interface {
	WriteCredentialFamily(context.Context, func(CredentialFamilyScope) error) (Completion, error)
}

type CredentialFamilyScope interface {
	CredentialFamilyDAO() CredentialFamilyDAO
}

// OAuthGrant is the durable authorization and the frozen validated client facts.
type OAuthGrant struct {
	ID, UserID, ClientID, Resource, Scope string
	ClientSnapshot                        json.RawMessage
	CreatedAt, ExpiresAt                  time.Time
	RevokedAt                             *time.Time
}

// OAuthFamilyIssue contains hashes only. Access and refresh belong to Grant;
// refresh expires with the grant and is retained after consumption for replay detection.
type OAuthFamilyIssue struct {
	Grant                   OAuthGrant
	AccessID                string
	AccessHash, RefreshHash []byte
	AccessExpiresAt         time.Time
}

type OAuthAccessIdentity struct {
	Principal model.Principal
	GrantID   string
}

// CredentialFamilyDAO is transaction-bound. IssueFamily never commits. The
// caller must lock any client row before issuing a DCR grant. For an existing
// family, callers lock the grant before refresh/code rows and access changes.
// RevokeFamily takes the grant lock and deletes access rows before returning;
// its boolean reports whether the grant changed from unrevoked to revoked.
// InspectGrant with lock=true obtains that lock for composed operations.
// DCR cleanup must lock the client row first, then call ActiveClientReferences
// with a fresh READ COMMITTED statement snapshot or an equivalent fresh read;
// a REPEATABLE READ snapshot taken before waiting on that lock is insufficient.
// DCR issuance holds the same client row lock through grant insertion and commit.
type CredentialFamilyDAO interface {
	IssueFamily(context.Context, OAuthFamilyIssue) error
	RevokeFamily(context.Context, string, time.Time) (bool, error)
	AuthenticateAccess(context.Context, []byte, string, string, time.Time) (OAuthAccessIdentity, error)
	InspectGrant(context.Context, string, bool) (OAuthGrant, error)
	ActiveClientReferences(context.Context, string, time.Time) (bool, error)
}
