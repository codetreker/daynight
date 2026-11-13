package remote

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

// Decode errors deliberately exclude the upstream response, which may contain
// credentials or private repository and PR content.
var errInvalidObservation = errors.New("invalid GitHub observation")

type repositoryDTO struct {
	ID       *int64  `json:"id"`
	FullName *string `json:"full_name"`
	Private  *bool   `json:"private"`
}

func decodeObservation(data json.RawMessage, target any) error {
	if !jsonunicode.Valid(data) || json.Unmarshal(data, target) != nil {
		return errInvalidObservation
	}
	return nil
}

func decodeRepository(data json.RawMessage) (githubpr.RepositoryObservation, error) {
	var dto repositoryDTO
	if decodeObservation(data, &dto) != nil || dto.ID == nil || *dto.ID <= 0 || dto.FullName == nil || *dto.FullName == "" || dto.Private == nil {
		return githubpr.RepositoryObservation{}, errInvalidObservation
	}
	return githubpr.RepositoryObservation{ID: *dto.ID, FullName: *dto.FullName, Private: *dto.Private}, nil
}

func decodeInstallation(data json.RawMessage) (githubpr.InstallationObservation, error) {
	var dto struct {
		ID      *int64 `json:"id"`
		Account *struct {
			Login *string `json:"login"`
		} `json:"account"`
	}
	if decodeObservation(data, &dto) != nil || dto.ID == nil || *dto.ID <= 0 || dto.Account == nil || dto.Account.Login == nil || *dto.Account.Login == "" {
		return githubpr.InstallationObservation{}, errInvalidObservation
	}
	return githubpr.InstallationObservation{ID: *dto.ID, AccountLogin: *dto.Account.Login}, nil
}

type pullRequestDTO struct {
	Number *int64  `json:"number"`
	ID     *int64  `json:"id"`
	URL    *string `json:"html_url"`
	Title  *string `json:"title"`
	User   *struct {
		ID    *int64  `json:"id"`
		Login *string `json:"login"`
	} `json:"user"`
	State *string `json:"state"`
	Draft *bool   `json:"draft"`
	Base  *struct {
		Ref  *string `json:"ref"`
		Repo *struct {
			ID *int64 `json:"id"`
		} `json:"repo"`
	} `json:"base"`
	Head *struct {
		Ref  *string `json:"ref"`
		SHA  *string `json:"sha"`
		Repo *struct {
			ID       *int64  `json:"id"`
			FullName *string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
	CreatedAt *time.Time      `json:"created_at"`
	UpdatedAt *time.Time      `json:"updated_at"`
	ClosedAt  json.RawMessage `json:"closed_at"`
	MergedAt  json.RawMessage `json:"merged_at"`
	Body      json.RawMessage `json:"body"`
}

func decodePullRequest(data json.RawMessage) (githubpr.Observation, error) {
	var dto pullRequestDTO
	var fields map[string]json.RawMessage
	var headFields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields["user"] == nil || json.Unmarshal(fields["head"], &headFields) != nil || headFields["repo"] == nil || headFields["ref"] == nil {
		return githubpr.Observation{}, errInvalidObservation
	}
	if decodeObservation(data, &dto) != nil || dto.Number == nil || *dto.Number <= 0 || dto.ID == nil || *dto.ID <= 0 ||
		dto.URL == nil || *dto.URL == "" || dto.Title == nil || dto.State == nil || *dto.State == "" || dto.Draft == nil ||
		dto.Base == nil || dto.Base.Ref == nil || *dto.Base.Ref == "" || dto.Base.Repo == nil || dto.Base.Repo.ID == nil || *dto.Base.Repo.ID <= 0 ||
		dto.Head == nil || dto.Head.SHA == nil || *dto.Head.SHA == "" || dto.CreatedAt == nil || dto.CreatedAt.IsZero() || dto.UpdatedAt == nil || dto.UpdatedAt.IsZero() || len(dto.Body) == 0 || len(dto.ClosedAt) == 0 || len(dto.MergedAt) == 0 {
		return githubpr.Observation{}, errInvalidObservation
	}
	var body *string
	var closedAt, mergedAt *time.Time
	if json.Unmarshal(dto.Body, &body) != nil || json.Unmarshal(dto.ClosedAt, &closedAt) != nil || json.Unmarshal(dto.MergedAt, &mergedAt) != nil {
		return githubpr.Observation{}, errInvalidObservation
	}
	result := githubpr.Observation{
		Number: *dto.Number, GitHubID: *dto.ID, URL: *dto.URL, Title: *dto.Title, State: *dto.State,
		Draft: *dto.Draft, BaseRepositoryID: *dto.Base.Repo.ID, BaseRef: *dto.Base.Ref,
		HeadRef: dto.Head.Ref, HeadSHA: *dto.Head.SHA, CreatedAt: dto.CreatedAt.UTC(), UpdatedAt: dto.UpdatedAt.UTC(),
		ClosedAt: utcTime(closedAt), MergedAt: utcTime(mergedAt), Description: body,
	}
	if dto.User != nil {
		if dto.User.ID == nil || *dto.User.ID <= 0 || dto.User.Login == nil || *dto.User.Login == "" {
			return githubpr.Observation{}, errInvalidObservation
		}
		result.AuthorID, result.AuthorLogin = dto.User.ID, dto.User.Login
	}
	if dto.Head.Repo != nil {
		if dto.Head.Repo.ID == nil || *dto.Head.Repo.ID <= 0 || dto.Head.Repo.FullName == nil || *dto.Head.Repo.FullName == "" {
			return githubpr.Observation{}, errInvalidObservation
		}
		result.HeadRepositoryID, result.HeadRepositoryFullName = dto.Head.Repo.ID, dto.Head.Repo.FullName
	}
	return result, nil
}

func utcTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	u := value.UTC()
	return &u
}
