package project

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type directMemberFixture struct {
	store.ProjectWriteDAO
	store.ProjectDirectMemberDAO
	access                             model.ProjectAccess
	accessErr, userErr, participantErr error
	person                             model.ProjectParticipant
	calls                              []string
	createRole                         model.ProjectRole
}

func (f *directMemberFixture) ProjectAccess(_ context.Context, _ model.Principal) (model.ProjectAccess, error) {
	f.calls = append(f.calls, "access")
	return f.access, f.accessErr
}
func (f *directMemberFixture) LockUser(_ context.Context, _ string) error {
	f.calls = append(f.calls, "user")
	return f.userErr
}
func (f *directMemberFixture) Participant(_ context.Context, _ string) (model.ProjectParticipant, error) {
	f.calls = append(f.calls, "participant")
	if f.participantErr != nil {
		err := f.participantErr
		f.participantErr = nil
		return model.ProjectParticipant{}, err
	}
	return f.person, nil
}
func (f *directMemberFixture) CreateGrant(_ context.Context, _ string, role model.ProjectRole) (model.ProjectGrant, error) {
	f.calls = append(f.calls, "create")
	f.createRole = role
	return model.ProjectGrant{}, nil
}

func TestAddExistingMemberDecisions(t *testing.T) {
	actor := model.Principal{Kind: model.SessionCredential, CredentialID: "10000000-0000-4000-8000-000000000003", UserID: "10000000-0000-4000-8000-000000000001"}
	target := "10000000-0000-4000-8000-000000000002"
	admin := model.ProjectAccess{Role: model.ProjectAdmin}
	participant := model.ProjectParticipant{UserID: target, EffectiveRole: model.ProjectAdmin}
	for _, tc := range []struct {
		name  string
		setup func(*directMemberFixture)
		code  string
		added bool
		calls []string
	}{
		{"existing", func(f *directMemberFixture) { f.person = participant }, "", false, []string{"access", "user", "participant"}},
		{"new", func(f *directMemberFixture) { f.participantErr = model.ErrNotFound; f.person = participant }, "", true, []string{"access", "user", "participant", "create", "participant"}},
		{"missing user", func(f *directMemberFixture) { f.userErr = model.ErrNotFound }, "user_not_found", false, []string{"access", "user"}},
		{"non admin", func(f *directMemberFixture) { f.access.Role = model.ProjectMemberRole }, "forbidden", false, []string{"access"}},
		{"no access", func(f *directMemberFixture) { f.accessErr = model.ErrNotFound }, "not_found", false, []string{"access"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &directMemberFixture{access: admin}
			tc.setup(f)
			got, err := AddExistingMember(t.Context(), f, f, actor, target)
			if tc.code != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != tc.code {
					t.Fatalf("error %v", err)
				}
			} else if err != nil || got.Added != tc.added || got.Participant != participant || got.ActorAccess != admin {
				t.Fatalf("result %+v, %v", got, err)
			}
			if !reflect.DeepEqual(f.calls, tc.calls) {
				t.Fatalf("calls %v want %v", f.calls, tc.calls)
			}
			if tc.added && f.createRole != model.ProjectMemberRole {
				t.Fatalf("role %q", f.createRole)
			}
		})
	}
}

func TestValidateExistingMemberIDs(t *testing.T) {
	actor := model.Principal{Kind: model.SessionCredential, CredentialID: "10000000-0000-4000-8000-000000000003", UserID: "10000000-0000-4000-8000-000000000001"}
	project := "10000000-0000-4000-8000-000000000004"
	target := "10000000-0000-4000-8000-000000000002"
	zero := "00000000-0000-0000-0000-000000000000"
	for _, tc := range []struct{ name, id, user, expected, code string }{
		{"zero project", zero, target, actor.UserID, "invalid_input"}, {"zero user", project, zero, actor.UserID, "invalid_input"}, {"zero expected", project, target, zero, "invalid_input"},
		{"uppercase target", project, "AAAAAAAA-0000-4000-8000-000000000002", actor.UserID, "invalid_input"},
		{"wrong actor", project, target, target, "identity_mismatch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := ValidateExistingMember(actor, tc.id, tc.user, tc.expected)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != tc.code {
				t.Fatalf("error %v", err)
			}
		})
	}
}
