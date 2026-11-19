package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// PullSummary retains only the facts needed to select and check a candidate.
type PullSummary struct {
	Number, RepositoryID int64
	State                string
	UpdatedAt            time.Time
	ClosedAt, MergedAt   *time.Time
}

func decodePullSummary(data json.RawMessage) (PullSummary, error) {
	var dto struct {
		Number    *int64          `json:"number"`
		State     *string         `json:"state"`
		UpdatedAt *time.Time      `json:"updated_at"`
		ClosedAt  json.RawMessage `json:"closed_at"`
		MergedAt  json.RawMessage `json:"merged_at"`
		Base      *struct {
			Repo *struct {
				ID *int64 `json:"id"`
			} `json:"repo"`
		} `json:"base"`
	}
	if decodeObservation(data, &dto) != nil || dto.Number == nil || *dto.Number <= 0 || dto.State == nil || dto.UpdatedAt == nil || dto.UpdatedAt.IsZero() || dto.Base == nil || dto.Base.Repo == nil || dto.Base.Repo.ID == nil || *dto.Base.Repo.ID <= 0 || len(dto.ClosedAt) == 0 || len(dto.MergedAt) == 0 {
		return PullSummary{}, errInvalidObservation
	}
	var closed, merged *time.Time
	if json.Unmarshal(dto.ClosedAt, &closed) != nil || json.Unmarshal(dto.MergedAt, &merged) != nil || (*dto.State != "open" && *dto.State != "closed") || (*dto.State == "open" && (closed != nil || merged != nil)) || (*dto.State == "closed" && (closed == nil || closed.IsZero())) || (merged != nil && merged.IsZero()) {
		return PullSummary{}, errInvalidObservation
	}
	return PullSummary{Number: *dto.Number, RepositoryID: *dto.Base.Repo.ID, State: *dto.State, UpdatedAt: dto.UpdatedAt.UTC(), ClosedAt: utcTime(closed), MergedAt: utcTime(merged)}, nil
}

// ListAll scans at most ten 20-item pages from the list head on every call.
// A true result denotes an intentional truncation, not a failed traversal.
func (c *Client) ListAll(ctx context.Context, installationID, repositoryID int64, owner, repo string, visit func([]PullSummary) error) (bool, error) {
	if visit == nil {
		return false, errors.New("missing page visitor")
	}
	p, err := repoPath(owner, repo)
	if err != nil {
		return false, err
	}
	namedPath := p + "/pulls"
	numericPath := "/repositories/" + strconv.FormatInt(repositoryID, 10) + "/pulls"
	target := c.endpoint(namedPath)
	target.RawQuery = "state=all&sort=created&direction=desc&per_page=20"
	seen := map[string]bool{}
	refreshed := false
	for page := 1; target != nil && page <= 10; page++ {
		if seen[target.String()] {
			return false, errors.New("github pagination cycle")
		}
		seen[target.String()] = true
		resp, err := c.installationGet(ctx, installationID, target, &refreshed)
		if err != nil {
			return false, err
		}
		if resp.StatusCode != http.StatusOK {
			err := responseError(resp)
			resp.Body.Close()
			return false, err
		}
		next, err := c.next(resp)
		if err != nil {
			resp.Body.Close()
			return false, err
		}
		if next != nil {
			if err = validateDiscoveryNext(next, namedPath, numericPath, page+1); err != nil || seen[next.String()] {
				resp.Body.Close()
				return false, errors.New("invalid github discovery next link")
			}
		}
		var raw []json.RawMessage
		if err = readJSON(resp, &raw); err != nil {
			return false, err
		}
		if raw == nil || len(raw) > 20 {
			return false, errors.New("invalid github pull request page")
		}
		items := make([]PullSummary, 0, len(raw))
		for _, v := range raw {
			item, e := decodePullSummary(v)
			if e != nil {
				return false, e
			}
			items = append(items, item)
		}
		if err = visit(items); err != nil {
			return false, err
		}
		if page == 10 && next != nil {
			return true, nil
		}
		target = next
	}
	return false, nil
}

func validateDiscoveryNext(next *url.URL, namedPath, numericPath string, page int) error {
	if next.RawPath != "" || (next.Path != namedPath && next.Path != numericPath) {
		return errors.New("invalid discovery path")
	}
	q, err := url.ParseQuery(next.RawQuery)
	if err != nil || len(q) != 5 {
		return errors.New("invalid discovery query")
	}
	for k, want := range map[string]string{"state": "all", "sort": "created", "direction": "desc", "per_page": "20", "page": strconv.Itoa(page)} {
		if len(q[k]) != 1 || q[k][0] != want {
			return errors.New("invalid discovery query")
		}
	}
	return nil
}
