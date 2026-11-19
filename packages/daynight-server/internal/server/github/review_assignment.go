package github

import (
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *handler) reviewAssignment(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "review_assignment", func(id string) (any, error) {
		v, err := query(r, "repositoryId")
		if err != nil {
			return nil, err
		}
		repositoryID, err := repositoryParameter(v)
		if err != nil {
			return nil, err
		}
		s := r.PathValue("number")
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n <= 0 || strconv.FormatInt(n, 10) != s {
			return nil, httpx.InvalidInput("number must be a positive decimal integer")
		}
		result, err := h.reader.ReviewAssignment(r.Context(), p, id, n, repositoryID)
		if err != nil {
			return nil, err
		}
		out := api.PullRequestReviewAssignmentResult{Status: result.Status}
		if result.Assignment != nil {
			a := result.Assignment
			out.Assignment = &api.PullRequestReviewAssignment{WorkerID: a.WorkerID, AssignedAt: a.AssignedAt.UTC(), Online: a.Online, ReviewEnabled: a.ReviewEnabled}
		}
		return out, nil
	})
}
