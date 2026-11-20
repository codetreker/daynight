package worker

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type reviewPollCursor struct {
	Version      int    `json:"v"`
	UserID       string `json:"userId"`
	WorkerID     string `json:"workerId"`
	Limit        int    `json:"limit"`
	ProjectID    string `json:"projectId"`
	RepositoryID string `json:"repositoryId"`
	GitHubPRID   string `json:"githubPrId"`
}

// ReviewPollPage validates the page size and binds a cursor to its account,
// Worker and page size. Cursors are positions, not authorization grants.
func ReviewPollPage(request model.PageRequest, userID, workerID string) (*store.ReviewPollKey, error) {
	bad := func() (*store.ReviewPollKey, error) {
		return nil, invalidInput("Cursor is invalid for this Worker review list.")
	}
	if request.Limit < 1 || request.Limit > 100 {
		return nil, invalidInput("limit must be an integer from 1 to 100")
	}
	if request.Cursor == nil {
		return nil, nil
	}
	encoded := *request.Cursor
	if len(encoded) > transport.MaxEncodedCursorBytes {
		return bad()
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || !jsonunicode.Valid(raw) || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return bad()
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return bad()
	}
	allowed := map[string]bool{"v": true, "userId": true, "workerId": true, "limit": true, "projectId": true, "repositoryId": true, "githubPrId": true}
	seen := map[string]bool{}
	for d.More() {
		keyToken, e := d.Token()
		key, ok := keyToken.(string)
		if e != nil || !ok || !allowed[key] || seen[key] {
			return bad()
		}
		seen[key] = true
		var value json.RawMessage
		if d.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return bad()
		}
	}
	if _, err = d.Token(); err != nil || d.Decode(new(any)) != io.EOF || len(seen) != len(allowed) {
		return bad()
	}
	var c reviewPollCursor
	if json.Unmarshal(raw, &c) != nil || c.Version != 1 || c.UserID != userID || c.WorkerID != workerID || c.Limit != request.Limit {
		return bad()
	}
	project, err := model.CanonicalID(c.ProjectID)
	if err != nil || project != c.ProjectID || project == "00000000-0000-0000-0000-000000000000" {
		return bad()
	}
	repo, err := strconv.ParseInt(c.RepositoryID, 10, 64)
	if err != nil || repo < 1 || strconv.FormatInt(repo, 10) != c.RepositoryID {
		return bad()
	}
	pr, err := strconv.ParseInt(c.GitHubPRID, 10, 64)
	if err != nil || pr < 1 || strconv.FormatInt(pr, 10) != c.GitHubPRID {
		return bad()
	}
	return &store.ReviewPollKey{ProjectID: project, RepositoryID: repo, GitHubPRID: pr}, nil
}

func ReviewPollCursor(userID, workerID string, limit int, key store.ReviewPollKey) (string, error) {
	data, err := json.Marshal(reviewPollCursor{1, userID, workerID, limit, key.ProjectID, strconv.FormatInt(key.RepositoryID, 10), strconv.FormatInt(key.GitHubPRID, 10)})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
