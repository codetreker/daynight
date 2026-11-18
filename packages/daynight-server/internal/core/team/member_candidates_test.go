package team

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type candidateReader struct {
	store.TeamReader
	team      model.Team
	teamErr   error
	teamCalls int
	queries   []store.UserCandidateQuery
	page      store.UserCandidatePage
	queryErr  error
}

func (d *candidateReader) Team(_ context.Context, user, id string) (model.Team, error) {
	d.teamCalls++
	if user != d.team.Membership.UserID || id != d.team.ID {
		panic("unexpected Team lookup")
	}
	return d.team, d.teamErr
}
func (d *candidateReader) MemberCandidates(_ context.Context, q store.UserCandidateQuery) (store.UserCandidatePage, error) {
	d.queries = append(d.queries, q)
	return d.page, d.queryErr
}

func TestCandidateSearchValidation(t *testing.T) {
	p := principal()
	id := uuid.NewString()
	input := CandidateSearchInput{ExpectedUserID: p.UserID, Query: " \u2003MiXeD 中文\u2003 "}
	gotID, got, err := ValidateCandidateSearch(p, id, input)
	if err != nil || gotID != id || got.query != "mixed 中文" || got.limit != 20 || got.afterID != nil {
		t.Fatalf("normalized: %s %+v %v", gotID, got, err)
	}
	zero, large := 0, 51
	empty, oversized := "", strings.Repeat("x", 2049)
	for _, tc := range []struct {
		name  string
		id    string
		input CandidateSearchInput
		code  string
	}{
		{"actor mismatch", id, CandidateSearchInput{ExpectedUserID: uuid.NewString(), Query: "x"}, "identity_mismatch"},
		{"zero team", uuid.Nil.String(), input, "invalid_input"},
		{"zero actor", id, CandidateSearchInput{ExpectedUserID: uuid.Nil.String(), Query: "x"}, "invalid_input"},
		{"invalid utf8", id, CandidateSearchInput{ExpectedUserID: p.UserID, Query: string([]byte{0xff})}, "invalid_input"},
		{"nul", id, CandidateSearchInput{ExpectedUserID: p.UserID, Query: "x\x00"}, "invalid_input"},
		{"long", id, CandidateSearchInput{ExpectedUserID: p.UserID, Query: strings.Repeat("界", 342)}, "invalid_input"},
		{"zero limit", id, CandidateSearchInput{ExpectedUserID: p.UserID, Query: "x", Limit: &zero}, "invalid_input"},
		{"large limit", id, CandidateSearchInput{ExpectedUserID: p.UserID, Query: "x", Limit: &large}, "invalid_input"},
		{"empty cursor", id, CandidateSearchInput{ExpectedUserID: p.UserID, Query: "x", Cursor: &empty}, "invalid_input"},
		{"long cursor", id, CandidateSearchInput{ExpectedUserID: p.UserID, Query: "x", Cursor: &oversized}, "invalid_input"},
		{"blank with cursor", id, CandidateSearchInput{ExpectedUserID: p.UserID, Query: "\u2003", Cursor: &empty}, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := ValidateCandidateSearch(p, tc.id, tc.input)
			faultCode(t, err, tc.code)
		})
	}
}

func TestCandidateSearchAdmissionAndTraversal(t *testing.T) {
	p := principal()
	id := uuid.NewString()
	team := namedTeam(p)
	team.ID = id
	firstID, secondID := uuid.NewString(), uuid.NewString()
	reader := &candidateReader{team: team, page: store.UserCandidatePage{Items: []model.UserCandidate{{UserID: firstID}}, HasMore: true}}
	input := CandidateSearchInput{ExpectedUserID: p.UserID, Query: "  AbC "}
	_, search, err := ValidateCandidateSearch(p, id, input)
	if err != nil {
		t.Fatal(err)
	}
	page, err := SearchMemberCandidates(t.Context(), reader, reader, p, id, search)
	if err != nil || page.NextCursor == nil || !reflect.DeepEqual(reader.queries, []store.UserCandidateQuery{{Query: "abc", Limit: 20}}) {
		t.Fatalf("first page %+v queries %+v err %v", page, reader.queries, err)
	}
	input.Cursor = page.NextCursor
	_, second, err := ValidateCandidateSearch(p, id, input)
	if err != nil || second.afterID == nil || *second.afterID != firstID {
		t.Fatalf("cursor %+v %v", second, err)
	}
	reader.page = store.UserCandidatePage{Items: []model.UserCandidate{{UserID: secondID}}}
	page, err = SearchMemberCandidates(t.Context(), reader, reader, p, id, second)
	if err != nil || page.NextCursor != nil || len(page.Items) != 1 || page.Items[0].UserID != secondID || reader.teamCalls != 2 {
		t.Fatalf("second page %+v %v", page, err)
	}
	for _, change := range []func(*model.Principal, *string, *CandidateSearchInput){
		func(_ *model.Principal, id *string, _ *CandidateSearchInput) { *id = uuid.NewString() },
		func(p *model.Principal, _ *string, in *CandidateSearchInput) {
			p.UserID = uuid.NewString()
			in.ExpectedUserID = p.UserID
		},
		func(p *model.Principal, _ *string, _ *CandidateSearchInput) { p.CredentialID = uuid.NewString() },
		func(p *model.Principal, _ *string, _ *CandidateSearchInput) { p.Kind = model.PATCredential },
		func(_ *model.Principal, _ *string, in *CandidateSearchInput) { in.Query = "different" },
		func(_ *model.Principal, _ *string, in *CandidateSearchInput) { n := 1; in.Limit = &n },
	} {
		otherP, otherID, otherInput := p, id, input
		change(&otherP, &otherID, &otherInput)
		_, _, err := ValidateCandidateSearch(otherP, otherID, otherInput)
		faultCode(t, err, "invalid_input")
	}
	blank := CandidateSearchInput{ExpectedUserID: p.UserID, Query: " \u2003"}
	_, empty, err := ValidateCandidateSearch(p, id, blank)
	if err != nil {
		t.Fatal(err)
	}
	reader.queries = nil
	page, err = SearchMemberCandidates(t.Context(), reader, reader, p, id, empty)
	if err != nil || page.Items == nil || len(page.Items) != 0 || len(reader.queries) != 0 {
		t.Fatalf("blank page %+v queries %+v %v", page, reader.queries, err)
	}
	reader.team.Membership.Role = model.ProjectMemberRole
	_, err = SearchMemberCandidates(t.Context(), reader, reader, p, id, search)
	faultCode(t, err, "forbidden")
	reader.team.Membership.Role = model.ProjectAdmin
	reader.team.Kind = "personal"
	_, err = SearchMemberCandidates(t.Context(), reader, reader, p, id, search)
	faultCode(t, err, "personal_team_immutable")
	reader.teamErr = model.ErrNotFound
	_, err = SearchMemberCandidates(t.Context(), reader, reader, p, id, search)
	faultCode(t, err, "not_found")
	reader.teamErr = nil
	reader.team.Kind = "ordinary"
	reader.queryErr = errors.New("store error")
	_, err = SearchMemberCandidates(t.Context(), reader, reader, p, id, search)
	if !errors.Is(err, reader.queryErr) {
		t.Fatalf("lost error: %v", err)
	}
}

func TestCandidateCursorStrictFields(t *testing.T) {
	p := principal()
	id := uuid.NewString()
	after := uuid.NewString()
	c := candidateCursor{Version: 1, TeamID: id, UserID: p.UserID, CredentialID: p.CredentialID, CredentialKind: p.Kind, QueryHash: candidateHash("a"), Limit: 20, AfterID: after}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	encode := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, malformed := range []string{
		strings.Replace(string(raw), `"v":1`, `"v":1,"v":1`, 1),
		strings.Replace(string(raw), `"v":1`, `"v":null`, 1),
		strings.Replace(string(raw), `"v":1`, `"v":2`, 1),
		strings.Replace(string(raw), `"v":1`, `"v":"1"`, 1),
		strings.Replace(string(raw), `"v":1,`, ``, 1),
		strings.Replace(string(raw), `"v":1`, `"v":1,"extra":true`, 1),
		strings.Replace(string(raw), after, uuid.Nil.String(), 1),
		string(raw) + ` {}`,
	} {
		_, err := decodeCandidateCursor(encode(malformed))
		if err == nil {
			t.Fatalf("accepted %s", malformed)
		}
	}
	for _, malformed := range []string{"!", encode(string(raw)) + "=", encode(string(raw)) + "\n"} {
		if _, err := decodeCandidateCursor(malformed); err == nil {
			t.Fatalf("accepted encoding %q", malformed)
		}
	}
}
