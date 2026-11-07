package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"unicode/utf8"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

func TestWireDecimals(t *testing.T) {
	for _, tc := range []struct {
		input          string
		bytes, version bool
	}{
		{"0", true, false}, {"1", true, true}, {"9223372036854775807", true, true},
		{"", false, false}, {"00", false, false}, {"01", false, false}, {"-1", false, false},
		{"+1", false, false}, {" 1", false, false}, {"9223372036854775808", false, false},
	} {
		_, err := ParseBytes(tc.input)
		if (err == nil) != tc.bytes {
			t.Errorf("ParseBytes(%q): %v", tc.input, err)
		}
		_, err = ParseVersion(tc.input)
		if (err == nil) != tc.version {
			t.Errorf("ParseVersion(%q): %v", tc.input, err)
		}
	}
	if Decimal(math.MaxInt64) != "9223372036854775807" {
		t.Fatal("decimal precision lost")
	}
}

func TestWireTeamResolutionDoesNotAuthorize(t *testing.T) {
	id := "F5BA8B54-C700-4A2F-B19F-BA0083B36F52"
	got, err := ResolveTeamID(context.Background(), nil, core.Principal{}, id)
	if err != nil || got != strings.ToLower(id) {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := ResolveTeamID(context.Background(), nil, core.Principal{}, "not-a-uuid"); err == nil {
		t.Fatal("invalid UUID accepted")
	}
}

func TestWireTaskProjectionsPreserveRawProperties(t *testing.T) {
	const property = `{"version":9007199254740993,"nested":[3,4]}`
	original := core.Task{ID: "id", ProjectID: "project", Title: strings.Repeat("界", 250), Description: strings.Repeat("x", 30000), Version: 9007199254740993,
		Properties: core.TaskProperties{"value": json.RawMessage(property)}, BlockedBy: []string{"a", "b"}}
	full := MapTaskFull(original)
	encoded, err := json.Marshal(full)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"version":"9007199254740993"`) || !strings.Contains(string(encoded), `"version":9007199254740993`) {
		t.Fatalf("precision lost: %s", encoded)
	}
	if !strings.Contains(string(encoded), `"cancelledAt":null`) {
		t.Fatalf("missing nullable cancellation time: %s", encoded)
	}
	original.Properties["value"][0] = '['
	if string(full.Properties["value"]) != property {
		t.Fatal("full projection aliases source properties")
	}
	result := MapTaskSummary(original)
	if !result.TitleTruncated || !utf8.ValidString(result.TitlePreview) || len(result.TitlePreview) > titlePreviewBytes || result.BlockedByCount != 2 || result.Projection != "summary" {
		t.Fatalf("invalid summary: %+v", result)
	}
	encoded, err = json.Marshal(result)
	if err != nil || len(encoded) > 16*1024 || strings.Contains(string(encoded), "description") || strings.Contains(string(encoded), "properties") || strings.Contains(string(encoded), "cancelledAt") {
		t.Fatalf("summary = %s, error %v", encoded, err)
	}
}

func TestWireProjectAndTeamVersions(t *testing.T) {
	project := MapProject(core.Project{Settings: core.ProjectSettings{Version: 9007199254740993}, Ownership: core.ProjectOwnership{TeamID: "team", Version: math.MaxInt64}})
	team := MapTeam(core.Team{Version: 9007199254740993, Membership: core.TeamMember{Version: math.MaxInt64}})
	if project.Settings.Version != "9007199254740993" || project.Ownership.Version != "9223372036854775807" || team.Version != "9007199254740993" || team.Membership.Version != "9223372036854775807" {
		t.Fatal("version precision lost")
	}
}

type wireIdentityScope struct {
	dao    wireIdentityDAO
	userID string
	teamID string
	err    error
}

type wireIdentityDAO struct {
	store.IdentityDAO
	scope *wireIdentityScope
}

func (s *wireIdentityScope) IdentityDAO() store.IdentityDAO         { s.dao.scope = s; return &s.dao }
func (s *wireIdentityScope) PersonalTeamDAO() store.PersonalTeamDAO { return nil }
func (d *wireIdentityDAO) IdentityPersonalTeam(_ context.Context, id string) (store.PersonalTeamFacts, error) {
	s := d.scope
	s.userID = id
	return store.PersonalTeamFacts{ID: s.teamID, MemberCount: 1, OwnerAdminCount: 1}, s.err
}
func (s *wireIdentityScope) WriteIdentity(ctx context.Context, f func(store.IdentityScope) error) (store.Completion, error) {
	if err := f(s); err != nil {
		return store.Completion{}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestWirePersonalTeamResolutionUsesPrincipalAndPropagatesFailure(t *testing.T) {
	dao := &wireIdentityScope{teamID: "f5ba8b54-c700-4a2f-b19f-ba0083b36f52"}
	id := identity.New(dao, nil, "")
	principal := core.Principal{UserID: "caller"}
	got, err := ResolveTeamID(context.Background(), id, principal, "personal")
	if err != nil || got != dao.teamID || dao.userID != principal.UserID {
		t.Fatalf("got %q, %v, user %q", got, err, dao.userID)
	}
	dao.err = errors.New("unavailable")
	if _, err = ResolveTeamID(context.Background(), id, principal, "personal"); err == nil {
		t.Fatal("identity error discarded")
	}
}
