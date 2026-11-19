package github

import (
	"net/http"
	"net/url"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func repositoryParameter(v url.Values) (*int64, error) {
	value, ok := v["repositoryId"]
	if !ok {
		return nil, nil
	}
	id, err := strconv.ParseInt(value[0], 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != value[0] {
		return nil, httpx.InvalidInput("repositoryId must be a positive decimal integer")
	}
	return &id, nil
}

func repositoryResponse(repository *githubpr.Repository) *api.PullRequestRepository {
	if repository == nil {
		return nil
	}
	return &api.PullRequestRepository{RepositoryID: decimal(repository.RepositoryID), FullName: repository.FullName}
}

func (h *handler) repositories(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "repositories", func(id string) (any, error) {
		v, err := query(r, "limit", "cursor")
		if err != nil {
			return nil, err
		}
		input := coregithub.RepositoriesRequest{Limit: 100}
		if value, ok := v["limit"]; ok {
			input.Limit, err = strconv.Atoi(value[0])
			if err != nil || input.Limit < 1 || input.Limit > 100 || strconv.Itoa(input.Limit) != value[0] {
				return nil, httpx.InvalidInput("limit must be an integer from 1 to 100")
			}
		}
		if value, ok := v["cursor"]; ok {
			input.Cursor = value[0]
		}
		result, err := h.reader.Repositories(r.Context(), p, id, input)
		if err != nil {
			return nil, err
		}
		out := api.PullRequestRepositoryPage{CurrentRepositoryID: optionalDecimal(result.CurrentRepositoryID), Items: make([]api.PullRequestRepository, 0, len(result.Items)), NextCursor: result.NextCursor}
		for _, item := range result.Items {
			out.Items = append(out.Items, api.PullRequestRepository{RepositoryID: decimal(item.RepositoryID), FullName: item.FullName})
		}
		return out, nil
	})
}
