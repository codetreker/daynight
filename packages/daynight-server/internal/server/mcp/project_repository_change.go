package mcp

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

type repositoryChangeServiceOperations interface {
	RepositoryPreview(context.Context, model.Principal, string, string, string) (coreproject.RepositoryPreview, error)
	SetRepository(context.Context, model.Principal, string, coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error)
}

type projectRepositoryPreviewInput struct {
	ProjectID string `json:"projectId"`
	RepoURL   string `json:"repoUrl"`
}

type projectRepositoryChangeInput struct {
	ProjectID                string  `json:"projectId"`
	RepoURL                  string  `json:"repoUrl"`
	RepositoryVersion        string  `json:"repositoryVersion"`
	OwnershipVersion         string  `json:"ownershipVersion"`
	Classification           string  `json:"classification"`
	TargetGitHubRepositoryID *string `json:"targetGitHubRepositoryId"`
	TreatUnverifiedAsSwitch  bool    `json:"treatUnverifiedAsSwitch"`
	Confirm                  bool    `json:"confirm"`
}

func (h *projectTools) previewRepository(ctx context.Context, actor RequestActor, in projectRepositoryPreviewInput) (ToolResult, error) {
	ops, ok := h.projects.(repositoryChangeServiceOperations)
	if !ok {
		return ToolResult{}, errors.New("repository operations unavailable")
	}
	preview, err := ops.RepositoryPreview(ctx, actor.Principal, in.ProjectID, in.RepoURL, actor.Principal.UserID)
	if err != nil {
		return ToolResult{}, err
	}
	var target *string
	if preview.TargetGitHubRepositoryID != nil {
		value := Decimal(*preview.TargetGitHubRepositoryID)
		target = &value
	}
	return ToolResult{Data: map[string]any{
		"projectId": preview.ProjectID, "projectName": preview.ProjectName,
		"currentRepoUrl": preview.CurrentRepoURL, "repoUrl": preview.RepoURL,
		"repositoryVersion": Decimal(preview.RepositoryVersion), "ownershipVersion": Decimal(preview.OwnershipVersion),
		"classification": preview.Classification, "targetGitHubRepositoryId": target,
		"unverifiedReason": preview.UnverifiedReason, "bindingsInvalidated": preview.BindingsInvalidated,
	}}, nil
}

func (h *projectTools) setRepository(ctx context.Context, actor RequestActor, in projectRepositoryChangeInput) (ToolResult, error) {
	refs := map[string]any{"projectId": in.ProjectID}
	if !in.Confirm {
		return ToolResult{Refs: refs}, &model.Fault{Code: "invalid_input", Message: "Explicit confirmation is required."}
	}
	repositoryVersion, err := ParseVersion(in.RepositoryVersion)
	if err != nil {
		return ToolResult{Refs: refs}, err
	}
	ownershipVersion, err := ParseVersion(in.OwnershipVersion)
	if err != nil {
		return ToolResult{Refs: refs}, err
	}
	var target *int64
	if in.TargetGitHubRepositoryID != nil {
		value, err := ParseVersion(*in.TargetGitHubRepositoryID)
		if err != nil {
			return ToolResult{Refs: refs}, err
		}
		target = &value
	}
	ops, ok := h.projects.(repositoryChangeServiceOperations)
	if !ok {
		return ToolResult{Refs: refs}, errors.New("repository operations unavailable")
	}
	receipt, err := ops.SetRepository(ctx, actor.Principal, in.ProjectID, coreproject.RepositoryChange{
		RepoURL: in.RepoURL, ExpectedUserID: actor.Principal.UserID,
		RepositoryVersion: repositoryVersion, OwnershipVersion: ownershipVersion,
		Classification: in.Classification, TargetGitHubRepositoryID: target,
		TreatUnverifiedAsSwitch: in.TreatUnverifiedAsSwitch,
	})
	if err != nil {
		return ToolResult{Refs: refs}, err
	}
	outcome := "unchanged"
	if receipt.Changed {
		outcome = "changed"
	}
	return ToolResult{SuccessMetadata: true, Data: map[string]any{
		"projectId": receipt.ProjectID, "repoUrl": receipt.RepoURL,
		"repositoryVersion": Decimal(receipt.RepositoryVersion), "changed": receipt.Changed,
		"bindingsInvalidated": receipt.BindingsInvalidated,
	}, Outcome: outcome, WriteOutcome: "confirmed", Refs: map[string]any{"projectId": receipt.ProjectID}}, nil
}
