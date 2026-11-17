package team

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/google/uuid"
)

type CandidateSearchInput struct {
	ExpectedUserID string
	Query          string
	Limit          *int
	Cursor         *string
}

type CandidateSearch struct {
	query   string
	limit   int
	afterID *string
}

type CandidatePage struct {
	Items      []model.TeamMemberCandidate
	NextCursor *string
}

type candidateCursor struct {
	Version        int                  `json:"v"`
	TeamID         string               `json:"teamId"`
	UserID         string               `json:"userId"`
	CredentialID   string               `json:"credentialId"`
	CredentialKind model.CredentialKind `json:"credentialKind"`
	QueryHash      string               `json:"queryHash"`
	Limit          int                  `json:"limit"`
	AfterID        string               `json:"afterId"`
}

func candidateHash(query string) string {
	sum := sha256.Sum256([]byte(query))
	return hex.EncodeToString(sum[:])
}

// ValidateCandidateSearch validates request scope before entering the snapshot.
func ValidateCandidateSearch(p model.Principal, id string, input CandidateSearchInput) (string, CandidateSearch, error) {
	id, err := validateMemberActor(p, id, input.ExpectedUserID)
	if err != nil {
		return "", CandidateSearch{}, err
	}
	if !utf8.ValidString(input.Query) || strings.ContainsRune(input.Query, 0) {
		return "", CandidateSearch{}, invalidInput("Query must be valid Unicode text without NUL characters.")
	}
	q := strings.TrimSpace(input.Query)
	if len(q) > 1024 {
		return "", CandidateSearch{}, invalidInput("Query must not exceed 1024 bytes.")
	}
	q = strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, q)
	search := CandidateSearch{query: q, limit: 20}
	if input.Limit != nil {
		search.limit = *input.Limit
	}
	if search.limit < 1 || search.limit > 50 {
		return "", CandidateSearch{}, invalidInput("Limit must be between 1 and 50.")
	}
	if input.Cursor != nil {
		if q == "" {
			return "", CandidateSearch{}, invalidInput("An empty query cannot have a cursor.")
		}
		c, err := decodeCandidateCursor(*input.Cursor)
		if err != nil || c.TeamID != id || c.UserID != p.UserID || c.CredentialID != p.CredentialID || c.CredentialKind != p.Kind || c.QueryHash != candidateHash(q) || c.Limit != search.limit {
			return "", CandidateSearch{}, invalidInput("Invalid candidate cursor or search scope.")
		}
		search.afterID = &c.AfterID
	}
	return id, search, nil
}

func decodeCandidateCursor(encoded string) (candidateCursor, error) {
	var c candidateCursor
	if len(encoded) == 0 || len(encoded) > 2048 {
		return c, fmt.Errorf("invalid length")
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != encoded || !utf8.Valid(data) {
		return c, fmt.Errorf("invalid encoding")
	}
	fields, err := jsonobject.Decode(data, "cursor", "v", "teamId", "userId", "credentialId", "credentialKind", "queryHash", "limit", "afterId")
	if err != nil || len(fields) != 8 {
		return c, fmt.Errorf("invalid fields")
	}
	for _, field := range fields {
		if string(field) == "null" {
			return c, fmt.Errorf("null field")
		}
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, err
	}
	if c.Version != 1 || c.Limit < 1 || c.Limit > 50 || !canonicalNonzeroID(c.TeamID) || !canonicalNonzeroID(c.UserID) || !canonicalNonzeroID(c.CredentialID) || !canonicalNonzeroID(c.AfterID) || (c.CredentialKind != model.SessionCredential && c.CredentialKind != model.PATCredential && c.CredentialKind != model.OAuthCredential) || len(c.QueryHash) != 64 {
		return c, fmt.Errorf("invalid values")
	}
	hash, err := hex.DecodeString(c.QueryHash)
	if err != nil || hex.EncodeToString(hash) != c.QueryHash {
		return c, fmt.Errorf("invalid hash")
	}
	return c, nil
}

func canonicalNonzeroID(id string) bool {
	canonical, err := model.CanonicalID(id)
	return err == nil && canonical == id && canonical != uuid.Nil.String()
}

// SearchMemberCandidates reauthorizes each page in the caller's snapshot.
func SearchMemberCandidates(ctx context.Context, dao store.TeamReader, p model.Principal, id string, search CandidateSearch) (CandidatePage, error) {
	t, err := Get(ctx, dao, p, id)
	if err != nil {
		return CandidatePage{}, err
	}
	if err := authorizeOrdinaryAdmin(t); err != nil {
		return CandidatePage{}, err
	}
	result := CandidatePage{Items: []model.TeamMemberCandidate{}}
	if search.query == "" {
		return result, nil
	}
	page, err := dao.MemberCandidates(ctx, store.TeamMemberCandidateQuery{Query: search.query, AfterID: search.afterID, Limit: search.limit})
	if err != nil {
		return CandidatePage{}, err
	}
	result.Items = page.Items
	if result.Items == nil {
		result.Items = []model.TeamMemberCandidate{}
	}
	if page.HasMore {
		if len(page.Items) == 0 {
			return CandidatePage{}, fmt.Errorf("candidate page has continuation without items")
		}
		c := candidateCursor{Version: 1, TeamID: id, UserID: p.UserID, CredentialID: p.CredentialID, CredentialKind: p.Kind, QueryHash: candidateHash(search.query), Limit: search.limit, AfterID: page.Items[len(page.Items)-1].UserID}
		data, err := json.Marshal(c)
		if err != nil {
			return CandidatePage{}, fmt.Errorf("encode candidate cursor: %w", err)
		}
		encoded := base64.RawURLEncoding.EncodeToString(data)
		result.NextCursor = &encoded
	}
	return result, nil
}
