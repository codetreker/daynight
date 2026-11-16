package github

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type impactFixture struct {
	summary  store.GitHubAppImpact
	err      error
	teams    store.GitHubAppImpactTeams
	projects store.GitHubAppImpactProjects
	queries  []string
}

func (f *impactFixture) Summary(context.Context, store.GitHubAppImpactQuery) (store.GitHubAppImpact, error) {
	f.queries = append(f.queries, "summary")
	return f.summary, f.err
}
func (f *impactFixture) Teams(context.Context, store.GitHubAppImpactQuery) (store.GitHubAppImpactTeams, error) {
	f.queries = append(f.queries, "teams")
	return f.teams, f.err
}
func (f *impactFixture) Projects(context.Context, store.GitHubAppImpactQuery) (store.GitHubAppImpactProjects, error) {
	f.queries = append(f.queries, "projects")
	return f.projects, f.err
}
func TestImpactCursorScopeAndFailures(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	app, grant := uuid.NewString(), uuid.NewString()
	id := uuid.NewString()
	f := &impactFixture{summary: store.GitHubAppImpact{Version: 1, ImpactVersion: 2}, teams: store.GitHubAppImpactTeams{Items: []store.GitHubAppImpactTeam{{Team: model.TeamRef{ID: id}}}, HasMore: true}}
	in := AppImpactInput{AppID: app, GrantID: &grant, Limit: 1}
	page, err := ReadAppImpact(t.Context(), f, p, in)
	if err != nil || page.NextCursor == nil {
		t.Fatalf("page: %+v %v", page, err)
	}
	in.Cursor = *page.NextCursor
	fail := func(want string, principal model.Principal, request AppImpactInput) {
		t.Helper()
		_, err := ReadAppImpact(t.Context(), f, principal, request)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != want {
			t.Fatalf("expected %s, got %v", want, err)
		}
	}
	if _, err := ReadAppImpact(t.Context(), f, p, in); err != nil {
		t.Fatal(err)
	}
	other := p
	other.UserID = uuid.NewString()
	fail("invalid_input", other, in)
	changed := in
	changed.AppID = uuid.NewString()
	fail("invalid_input", p, changed)
	changed = in
	changed.GrantID = nil
	fail("invalid_input", p, changed)
	_, err = ReadAppImpactProjects(t.Context(), f, p, in)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_input" {
		t.Fatalf("cross-kind cursor: %v", err)
	}
	f.summary.Version = 3
	fail("version_conflict", p, in)
	f.summary.Version = 1
	f.summary.ImpactVersion = 3
	fail("impact_changed", p, in)
	f.summary.ImpactVersion = 2
	f.err = model.ErrNotFound
	fail("not_found", p, in)
	f.err = nil
	raw, err := base64.RawURLEncoding.DecodeString(in.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	changed = in
	changed.Cursor = base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(string(raw), "{", `{"format":1,`, 1)))
	fail("invalid_input", p, changed)
	changed = in
	changed.Cursor = "bad="
	fail("invalid_input", p, changed)
	changed = in
	changed.Cursor = ""
	changed.Limit = 101
	fail("invalid_input", p, changed)
	changed = in
	changed.Cursor = ""
	badID := "bad"
	changed.GrantID = &badID
	fail("invalid_input", p, changed)
}
