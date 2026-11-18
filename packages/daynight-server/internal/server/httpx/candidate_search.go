package httpx

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type CandidateSearchRequest struct {
	ExpectedUserID string
	Query          string
	Limit          *int
	Cursor         *string
}

func DecodeCandidateSearch(w http.ResponseWriter, r *http.Request) (CandidateSearchRequest, error) {
	if _, err := QueryValues(r); err != nil {
		return CandidateSearchRequest{}, err
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		return CandidateSearchRequest{}, InvalidInput("query parameters are not accepted")
	}
	fields, err := DecodeObject(w, r, "expectedUserId", "query", "limit", "cursor")
	if err != nil {
		return CandidateSearchRequest{}, err
	}
	for _, key := range []string{"expectedUserId", "query", "cursor"} {
		if raw, ok := fields[key]; ok && !jsonunicode.Valid(raw) {
			return CandidateSearchRequest{}, InvalidInput(key + " must contain valid Unicode")
		}
	}
	expected, err := RequiredString(fields, "expectedUserId")
	if err != nil {
		return CandidateSearchRequest{}, err
	}
	query, err := RequiredString(fields, "query")
	if err != nil {
		return CandidateSearchRequest{}, err
	}
	cursor, err := OptionalString(fields, "cursor")
	if err != nil {
		return CandidateSearchRequest{}, err
	}
	var limit *int
	if raw, ok := fields["limit"]; ok {
		var value int
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
			return CandidateSearchRequest{}, InvalidInput("limit must be an integer")
		}
		limit = &value
	}
	return CandidateSearchRequest{ExpectedUserID: expected, Query: query, Limit: limit, Cursor: cursor}, nil
}
