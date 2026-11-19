package project

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type repositoryOperations interface {
	RepositoryPreview(context.Context, model.Principal, string, string, string) (coreproject.RepositoryPreview, error)
	SetRepository(context.Context, model.Principal, string, coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error)
}

func repositoryString(fields map[string]json.RawMessage, key string) (string, error) {
	if raw, ok := fields[key]; ok && !jsonunicode.Valid(raw) {
		return "", httpx.InvalidInput(key + " must contain valid Unicode text")
	}
	return httpx.RequiredString(fields, key)
}

func repositoryDecimal(fields map[string]json.RawMessage, key string) (int64, error) {
	value, err := repositoryString(fields, key)
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != value {
		return 0, httpx.InvalidInput(key + " must be a positive decimal int64 string")
	}
	return n, nil
}

func repositoryTarget(fields map[string]json.RawMessage) (*int64, error) {
	raw, ok := fields["targetGitHubRepositoryId"]
	if !ok {
		return nil, httpx.InvalidInput("targetGitHubRepositoryId is required")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	n, err := repositoryDecimal(fields, "targetGitHubRepositoryId")
	if err != nil {
		return nil, err
	}
	return &n, nil
}

func repositoryInput(w http.ResponseWriter, r *http.Request, preview bool) (coreproject.RepositoryChange, error) {
	var input coreproject.RepositoryChange
	if _, err := httpx.QueryValues(r); err != nil {
		httpx.CloseUnreadBody(w, r)
		return input, err
	}
	allowed := []string{"repoUrl", "expectedUserId"}
	if !preview {
		allowed = append(allowed, "repositoryVersion", "ownershipVersion", "classification", "targetGitHubRepositoryId", "treatUnverifiedAsSwitch")
	}
	fields, err := httpx.DecodeObject(w, r, allowed...)
	if err != nil {
		return input, err
	}
	if input.RepoURL, err = repositoryString(fields, "repoUrl"); err != nil {
		return input, err
	}
	if input.ExpectedUserID, err = repositoryString(fields, "expectedUserId"); err != nil {
		return input, err
	}
	if preview {
		return input, nil
	}
	if input.RepositoryVersion, err = repositoryDecimal(fields, "repositoryVersion"); err != nil {
		return input, err
	}
	if input.OwnershipVersion, err = repositoryDecimal(fields, "ownershipVersion"); err != nil {
		return input, err
	}
	if input.Classification, err = repositoryString(fields, "classification"); err != nil {
		return input, err
	}
	if input.TargetGitHubRepositoryID, err = repositoryTarget(fields); err != nil {
		return input, err
	}
	choice, err := httpx.OptionalBool(fields, "treatUnverifiedAsSwitch")
	if err != nil {
		return input, err
	}
	if choice != nil {
		input.TreatUnverifiedAsSwitch = *choice
	}
	return input, nil
}

func repositoryError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, phase string, err error) {
	if phase == "save" {
		if fault, ok := team.WriteFault(err); ok {
			if fault.Code == "write_outcome_unknown" {
				logger = logger.With("write_outcome", "unknown")
				httpx.LogFailure(logger, r.Context(), "project_repository", "commit", fault)
				if r.Context().Err() == nil {
					httpx.WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
				}
				return
			}
			if fault.Code == "internal_error" {
				httpx.LogFailure(logger, r.Context(), "project_repository", "completion", fault)
				httpx.WriteJSON(w, r, logger, http.StatusInternalServerError, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
				return
			}
			err = fault
		}
	}
	httpx.WriteError(w, r, logger, "project_repository", phase, err)
}

func (h *projectHandler) repositoryPreview(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := transferLogID(h.logger.With("user_id", p.UserID), "project_id", r.PathValue("projectId"))
	input, err := repositoryInput(w, r, true)
	if err != nil {
		repositoryError(w, r, logger, "preview", err)
		return
	}
	ops, ok := h.projects.(repositoryOperations)
	if !ok {
		repositoryError(w, r, logger, "preview", errors.New("repository operations unavailable"))
		return
	}
	result, err := ops.RepositoryPreview(r.Context(), p, r.PathValue("projectId"), input.RepoURL, input.ExpectedUserID)
	if err != nil {
		repositoryError(w, r, logger, "preview", err)
		return
	}
	var target *string
	if result.TargetGitHubRepositoryID != nil {
		value := strconv.FormatInt(*result.TargetGitHubRepositoryID, 10)
		target = &value
	}
	response := api.RepositoryPreview{ProjectID: result.ProjectID, ProjectName: result.ProjectName, CurrentRepoURL: result.CurrentRepoURL, RepoURL: result.RepoURL, RepositoryVersion: strconv.FormatInt(result.RepositoryVersion, 10), OwnershipVersion: strconv.FormatInt(result.OwnershipVersion, 10), Classification: result.Classification, TargetGitHubRepositoryID: target, UnverifiedReason: result.UnverifiedReason, BindingsInvalidated: result.BindingsInvalidated}
	httpx.WriteJSON(w, r, logger, http.StatusOK, response)
}

func (h *projectHandler) setRepository(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := transferLogID(h.logger.With("user_id", p.UserID), "project_id", r.PathValue("projectId"))
	input, err := repositoryInput(w, r, false)
	if err != nil {
		repositoryError(w, r, logger, "prepare", err)
		return
	}
	ops, ok := h.projects.(repositoryOperations)
	if !ok {
		repositoryError(w, r, logger, "save", errors.New("repository operations unavailable"))
		return
	}
	result, err := ops.SetRepository(r.Context(), p, r.PathValue("projectId"), input)
	if err != nil {
		repositoryError(w, r, logger, "save", err)
		return
	}
	response := api.RepositoryReceipt{ProjectID: result.ProjectID, RepoURL: result.RepoURL, RepositoryVersion: strconv.FormatInt(result.RepositoryVersion, 10), Changed: result.Changed, BindingsInvalidated: result.BindingsInvalidated}
	httpx.WriteMutationJSON(w, r, logger, "project_repository", http.StatusOK, response)
}
