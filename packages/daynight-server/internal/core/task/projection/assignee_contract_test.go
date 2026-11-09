package projection

import (
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func assigneeContractID(number int) string {
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", number)
}

func TestTaskAssigneeProfileRequiresMatchingIdentity(t *testing.T) {
	id, other := assigneeContractID(100), assigneeContractID(200)
	person, err := AssigneeProfile(model.TaskAssigneeFact{UserID: id, ProfileID: &id})
	if err != nil || person.UserID != id || person.Name != nil || person.AvatarURL != nil || person.HasProjectAccess {
		t.Fatalf("valid nullable profile rejected: %#v %v", person, err)
	}
	for _, profileID := range []*string{nil, &other} {
		person, err := AssigneeProfile(model.TaskAssigneeFact{UserID: id, ProfileID: profileID, HasProjectAccess: true})
		if err == nil || !reflect.DeepEqual(person, model.TaskAssignee{}) {
			t.Fatal("missing or different person's profile became a qualified identity")
		}
	}
}

func TestTaskAssigneeContentVersionDistinguishesPublicProfileFacts(t *testing.T) {
	id := assigneeContractID(100)
	empty, escaped, unicode := "", "<>&\"\\\n", "中文 😀"
	profiles := []struct {
		userID       string
		name, avatar *string
	}{
		{id, nil, nil}, {id, &empty, nil}, {id, nil, &empty},
		{id, &escaped, &unicode}, {id, &unicode, &escaped},
		{assigneeContractID(101), nil, nil},
	}
	versions := make(map[string]bool, len(profiles))
	for _, profile := range profiles {
		version := AssigneeContentVersion(profile.userID, profile.name, profile.avatar)
		decoded, err := hex.DecodeString(version)
		if err != nil || len(decoded) != 32 || version != strings.ToLower(version) || versions[version] {
			t.Fatalf("distinct public profile facts produced an invalid or repeated version: %q %v", version, err)
		}
		versions[version] = true
		member, err := AssigneeProfile(model.TaskAssigneeFact{UserID: profile.userID, ProfileID: &profile.userID, Name: profile.name, AvatarURL: profile.avatar, HasProjectAccess: true})
		if err != nil {
			t.Fatal(err)
		}
		former, err := AssigneeProfile(model.TaskAssigneeFact{UserID: profile.userID, ProfileID: &profile.userID, Name: profile.name, AvatarURL: profile.avatar})
		if err != nil || member.Version != version || former.Version != version {
			t.Fatalf("project access changed the content version: %#v %#v %v", member, former, err)
		}
	}
}

func BenchmarkTaskAssigneeContentVersion(b *testing.B) {
	avatar := "data:image/png;base64," + strings.Repeat("a", 235_600)
	for _, test := range []struct {
		name   string
		avatar *string
	}{
		{"nullable", nil},
		{"inline-avatar-236KB", &avatar},
	} {
		b.Run(test.name, func(b *testing.B) {
			b.ReportAllocs()
			if test.avatar != nil {
				b.SetBytes(int64(len(*test.avatar)))
			}
			for b.Loop() {
				AssigneeContentVersion("00000000-0000-4000-8000-000000000100", nil, test.avatar)
			}
		})
	}
}

func TestAssigneeQualifiedMissingProfilesRejectWholeResult(t *testing.T) {
	valid, missing := assigneeContractID(101), assigneeContractID(102)
	for _, retained := range []bool{false, true} {
		facts := []model.TaskAssigneeFact{{UserID: valid, ProfileID: &valid, Qualified: true, HasProjectAccess: true}, {UserID: missing, Qualified: true, HasProjectAccess: !retained}}
		for _, read := range []func() (model.TaskAssignees, error){func() (model.TaskAssignees, error) { return Catalogue(facts) }, func() (model.TaskAssignees, error) { return ResolveAssignees([]string{valid, missing}, facts) }} {
			result, err := read()
			if err == nil || errors.Is(err, model.ErrNotFound) || len(result.Items) != 0 || len(result.UnresolvedUserIDs) != 0 {
				t.Fatalf("qualified missing profile became partial/unresolved: %#v %v", result, err)
			}
		}
		result, err := ResolveAssignees([]string{valid}, facts[:1])
		if err != nil || len(result.Items) != 1 || result.Items[0].UserID != valid {
			t.Fatalf("unrequested profile broke bounded resolution: %#v %v", result, err)
		}
	}
}
