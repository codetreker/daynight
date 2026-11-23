package github

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *handler) authors(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "authors", func(id string) (any, error) {
		v, err := query(r, "q", "limit", "cursor", "repositoryId")
		if err != nil {
			return nil, err
		}
		input := coregithub.AuthorsRequest{Limit: 50}
		input.RepositoryID, err = repositoryParameter(v)
		if err != nil {
			return nil, err
		}
		if x, ok := v["q"]; ok {
			input.Query = x[0]
		}
		if x, ok := v["cursor"]; ok {
			input.Cursor = x[0]
		}
		if x, ok := v["limit"]; ok {
			n, e := strconv.Atoi(x[0])
			if e != nil || n < 1 || n > 100 || strconv.Itoa(n) != x[0] {
				return nil, httpx.InvalidInput("limit must be an integer from 1 to 100")
			}
			input.Limit = n
		}
		if !utf8.ValidString(input.Query) || strings.ContainsRune(input.Query, 0) || len(input.Query) > 1024 {
			return nil, httpx.InvalidInput("q must be valid UTF-8 without NUL and at most 1024 bytes")
		}
		result, err := h.reader.Authors(r.Context(), p, id, input)
		if err != nil {
			return nil, err
		}
		out := api.PullRequestAuthorPage{ProjectID: result.Connection.ProjectID, Revision: decimal(result.Connection.Revision), Items: make([]api.PullRequestDirectoryAuthor, 0, len(result.Items)), NextCursor: result.NextCursor}
		out.Repository = repositoryResponse(result.Repository)
		for _, item := range result.Items {
			out.Items = append(out.Items, api.PullRequestDirectoryAuthor{ID: decimal(item.ID), Login: item.Login, LoginAmbiguous: item.LoginAmbiguous})
		}
		return out, nil
	})
}
