package project

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestCreationRepositoryConflictBeforeAnyMutation(t *testing.T) {
	cause := errors.New("occupancy query failed")
	for _, tc := range []struct {
		name, address, code string
		occupied            bool
		err                 error
	}{
		{"conflict", "ssh://git@HOST/repo.git", "project_repository_conflict", true, nil},
		{"query failure", "host:repo", "", false, cause},
		{"unidentifiable", "invalid", "invalid_input", false, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := &creationDAO{personal: store.PersonalTeamFacts{ID: "personal", MemberCount: 1, OwnerAdminCount: 1}, occupied: tc.occupied, occupancyErr: tc.err}
			_, _, err := Create(context.Background(), dao, "user", "project", CreateProject{Name: "New name", RepoURL: tc.address})
			if tc.code != "" {
				transferTestFault(t, err, tc.code)
			} else if !errors.Is(err, cause) {
				t.Fatalf("query error lost: %v", err)
			}
			want := []string{"personal locked", "repository personal"}
			if tc.code == "invalid_input" {
				want = want[:1]
			}
			if !reflect.DeepEqual(dao.calls, want) {
				t.Fatalf("creation changed domain state: %v", dao.calls)
			}
			if tc.occupied && dao.identity != "host/repo" {
				t.Fatalf("identity=%s", dao.identity)
			}
		})
	}
}

func TestTransferRepositoryRefusalsPreserveOwnership(t *testing.T) {
	for _, tc := range []struct {
		name, fail, code  string
		missing, occupied bool
	}{
		{name: "conflict", code: "project_repository_conflict", occupied: true},
		{name: "unknown identity", code: "project_repository_identity_unavailable", missing: true},
		{name: "identity read failure", fail: "identity"},
		{name: "occupancy read failure", fail: "occupancy"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := newTransferTestDAO()
			before := dao.ownership
			dao.identityMissing = tc.missing
			dao.occupied = tc.occupied
			dao.fail = tc.fail
			dao.cause = errors.New("read failed")
			_, err := Transfer(t.Context(), dao, transferTestPrincipal(), transferTestProject, transferTestSource, transferTestTarget, transferTestInput())
			if tc.code != "" {
				transferTestFault(t, err, tc.code)
			} else if !errors.Is(err, dao.cause) {
				t.Fatalf("read error lost: %v", err)
			}
			if dao.ownership != before || dao.accessCount != 1 {
				t.Fatalf("refusal changed ownership/access: %+v %v", dao.ownership, dao.calls)
			}
			for _, call := range dao.calls {
				if call == "move" {
					t.Fatal("refusal moved ownership")
				}
			}
		})
	}
	dao := newTransferTestDAO()
	dao.identityMissing = true
	dao.occupied = true
	dao.target = dao.source
	dao.target.Version = 7
	input := transferTestInput()
	input.TargetTeam.ID = transferTestSource
	receipt, err := Transfer(t.Context(), dao, transferTestPrincipal(), transferTestProject, transferTestSource, transferTestSource, input)
	if err != nil || receipt.Changed {
		t.Fatalf("current Team transfer=%+v %v", receipt, err)
	}
	for _, call := range dao.calls {
		if call == "identity" || call == "occupancy" {
			t.Fatal("no-op checked occupancy")
		}
	}
}
