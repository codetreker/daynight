package project

import (
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

// RepositoryEvidence contains observations made using the existing project connection.
type RepositoryEvidence struct {
	OldID, TargetID  *int64
	OldFullName      string
	TargetFullName   string
	TargetPrivate    bool
	UnverifiedReason string
}

type RepositoryPreview struct {
	ProjectID, ProjectName, CurrentRepoURL, RepoURL string
	RepositoryVersion, OwnershipVersion             int64
	Classification                                  string
	TargetGitHubRepositoryID                        *int64
	UnverifiedReason                                *string
	BindingsInvalidated                             bool
}

type RepositoryChange struct {
	RepoURL, ExpectedUserID, Classification string
	RepositoryVersion, OwnershipVersion     int64
	TargetGitHubRepositoryID                *int64
	TreatUnverifiedAsSwitch                 bool
}

type RepositoryReceipt struct {
	ProjectID, RepoURL           string
	RepositoryVersion            int64
	Changed, BindingsInvalidated bool
}

func ValidateRepositoryChange(p model.Principal, id, address, expectedUser string) (string, string, error) {
	if err := team.RequireActor(p, expectedUser); err != nil {
		return "", "", err
	}
	id, err := model.CanonicalID(id)
	if err != nil {
		return "", "", err
	}
	if err = validateRepoURL(address); err != nil {
		return "", "", err
	}
	identity, err := RepositoryIdentity(address)
	return id, identity, err
}

// ClassifyRepository gives stable IDs precedence over equivalent address spelling.
func ClassifyRepository(current, target, currentIdentity, targetIdentity string, evidence RepositoryEvidence) (string, *int64, *string) {
	if current == target {
		return "unchanged", nil, nil
	}
	if evidence.OldID != nil && evidence.TargetID != nil {
		if *evidence.OldID == *evidence.TargetID {
			return "same_repository", evidence.TargetID, nil
		}
		return "different_repository", evidence.TargetID, nil
	}
	if evidence.OldID != nil && evidence.OldFullName != "" && strings.EqualFold(targetIdentity, "github.com/"+evidence.OldFullName) {
		return "same_repository", evidence.OldID, nil
	}
	if currentIdentity == targetIdentity && currentIdentity != "" {
		return "same_repository", evidence.TargetID, nil
	}
	reason := evidence.UnverifiedReason
	if reason == "" {
		reason = "no_verified_repository"
	}
	return "unverified", evidence.TargetID, &reason
}

func SameRepositoryID(a, b *int64) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
