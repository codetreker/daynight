package project

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type creationDAO struct {
	calls    []string
	personal store.PersonalTeamFacts
	target   store.ProjectCreationTeam
	member   bool
}

func (d *creationDAO) CreationPersonalTeam(_ context.Context, lock bool) (store.PersonalTeamFacts, error) {
	if lock {
		d.calls = append(d.calls, "personal locked")
	} else {
		d.calls = append(d.calls, "personal checked")
	}
	return d.personal, nil
}
func (d *creationDAO) LockCreationTeam(_ context.Context, _ string) (store.ProjectCreationTeam, error) {
	d.calls = append(d.calls, "team locked")
	return d.target, nil
}
func (d *creationDAO) CreationTeamMember(_ context.Context, _ string) (bool, error) {
	d.calls = append(d.calls, "member checked")
	return d.member, nil
}
func (d *creationDAO) InsertProject(_ context.Context, _, _, _, teamID string) (model.Project, model.ProjectAccess, error) {
	d.calls = append(d.calls, "insert "+teamID)
	return model.Project{}, model.ProjectAccess{}, nil
}
func TestCreateTeamAdmission(t *testing.T) {
	user, other, target := "user", "other", "team"
	for _, tc := range []struct {
		name      string
		input     CreateProject
		dao       creationDAO
		calls     []string
		wantError bool
		notFound  bool
	}{
		{name: "personal", dao: creationDAO{personal: store.PersonalTeamFacts{ID: "personal", MemberCount: 1, OwnerAdminCount: 1}}, calls: []string{"personal locked", "insert personal"}},
		{name: "missing personal", dao: creationDAO{}, calls: []string{"personal locked"}, wantError: true},
		{name: "foreign personal", input: CreateProject{TeamID: &target}, dao: creationDAO{target: store.ProjectCreationTeam{ID: target, PersonalUserID: &other}}, calls: []string{"team locked"}, wantError: true, notFound: true},
		{name: "personal invariant", input: CreateProject{TeamID: &target}, dao: creationDAO{target: store.ProjectCreationTeam{ID: target, PersonalUserID: &user}, personal: store.PersonalTeamFacts{ID: target, MemberCount: 2, OwnerAdminCount: 1}}, calls: []string{"team locked", "personal checked"}, wantError: true},
		{name: "ordinary denied", input: CreateProject{TeamID: &target}, dao: creationDAO{target: store.ProjectCreationTeam{ID: target}}, calls: []string{"team locked", "member checked"}, wantError: true, notFound: true},
		{name: "ordinary member", input: CreateProject{TeamID: &target}, dao: creationDAO{target: store.ProjectCreationTeam{ID: target}, member: true}, calls: []string{"team locked", "member checked", "insert team"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := Create(context.Background(), &tc.dao, user, "project", tc.input)
			if (err != nil) != tc.wantError || errors.Is(err, model.ErrNotFound) != tc.notFound {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(tc.dao.calls, tc.calls) {
				t.Fatalf("calls %v, want %v", tc.dao.calls, tc.calls)
			}
		})
	}
}
