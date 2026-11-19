package goaldependencies

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

const projectID = "11111111-1111-4111-8111-111111111111"
const goalID = "22222222-2222-4222-8222-222222222222"
const edgeID = "33333333-3333-4333-8333-333333333333"

func TestDecodeEdit(t *testing.T) {
	endpoint := `{"projectId":"` + projectID + `","goalId":"` + goalID + `"}`
	for _, tc := range []struct {
		body string
		want taskcore.GoalDependencyEdit
	}{
		{`{"ifRevision":"9007199254740993","mode":"edit","add":[` + endpoint + `]}`, taskcore.GoalDependencyEdit{IfRevision: 9007199254740993, Mode: "edit", Add: []taskcore.GoalDependencyEndpoint{{ProjectID: projectID, GoalID: goalID}}}},
		{`{"ifRevision":"9223372036854775807","mode":"edit","remove":["` + edgeID + `"]}`, taskcore.GoalDependencyEdit{IfRevision: math.MaxInt64, Mode: "edit", Remove: []string{edgeID}}},
		{`{"ifRevision":"1","mode":"replace","prerequisites":[]}`, taskcore.GoalDependencyEdit{IfRevision: 1, Mode: "replace", Prerequisites: []taskcore.GoalDependencyReference{}}},
		{`{"ifRevision":"2","mode":"replace","prerequisites":[{"edgeId":"` + edgeID + `"},` + endpoint + `]}`, taskcore.GoalDependencyEdit{IfRevision: 2, Mode: "replace", Prerequisites: []taskcore.GoalDependencyReference{{EdgeID: edgeID}, {ProjectID: projectID, GoalID: goalID}}}},
	} {
		t.Run(tc.body, func(t *testing.T) {
			got, err := DecodeEdit([]byte(tc.body))
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("decode: %+v %v; want %+v", got, err, tc.want)
			}
		})
	}
}

func TestDecodeEditRejectsMalformedRequests(t *testing.T) {
	endpoint := `{"projectId":"` + projectID + `","goalId":"` + goalID + `"}`
	bodies := []string{
		`null`, `[]`, `{}`, `{} {}`, `{"mode":"replace","ifRevision":"1","prerequisites":[],"unknown":1}`,
		`{"mode":"replace","ifRevision":"1","ifRevision":"2","prerequisites":[]}`,
		`{"mode":null,"ifRevision":"1","prerequisites":[]}`,
		`{"mode":1,"ifRevision":"1","prerequisites":[]}`,
		`{"mode":"unknown","ifRevision":"1","prerequisites":[]}`,
		`{"mode":"edit","ifRevision":"1"}`,
		`{"mode":"replace","ifRevision":"1"}`,
		`{"mode":"replace","ifRevision":"1","prerequisites":null}`,
		`{"mode":"replace","ifRevision":"1","prerequisites":[],"add":[]}`,
		`{"mode":"replace","ifRevision":"1","prerequisites":[],"remove":[]}`,
		`{"mode":"edit","ifRevision":"1","add":[],"prerequisites":[]}`,
		`{"mode":"edit","ifRevision":"1","add":null}`,
		`{"mode":"edit","ifRevision":"1","remove":null}`,
		`{"mode":"edit","ifRevision":"1","remove":[null]}`,
		`{"mode":"edit","ifRevision":"1","remove":[1]}`,
		`{"mode":"edit","ifRevision":"1","remove":["bad"]}`,
		`{"mode":"edit","ifRevision":"1","add":[null]}`,
		`{"mode":"edit","ifRevision":"1","add":[{"edgeId":"` + edgeID + `"}]}`,
		`{"mode":"edit","ifRevision":"1","add":[{"projectId":null,"goalId":"` + goalID + `"}]}`,
		`{"mode":"edit","ifRevision":"1","add":[{"projectId":"bad","goalId":"` + goalID + `"}]}`,
		`{"mode":"edit","ifRevision":"1","add":[{"projectId":"` + projectID + `","goalId":null}]}`,
		`{"mode":"edit","ifRevision":"1","add":[{"projectId":"` + projectID + `","projectId":"` + projectID + `","goalId":"` + goalID + `"}]}`,
		`{"mode":"edit","ifRevision":"1","add":[` + endpoint + `,` + endpoint + `]}`,
		`{"mode":"edit","ifRevision":"1","remove":["` + edgeID + `","` + edgeID + `"]}`,
		`{"mode":"replace","ifRevision":"1","prerequisites":[{"edgeId":null}]}`,
		`{"mode":"replace","ifRevision":"1","prerequisites":[{"edgeId":""}]}`,
		`{"mode":"replace","ifRevision":"1","prerequisites":[{"edgeId":"` + edgeID + `","goalId":"` + goalID + `"}]}`,
		`{"mode":"replace","ifRevision":"1","prerequisites":[{"projectId":"` + projectID + `"}]}`,
		`{"mode":"replace","ifRevision":"1","prerequisites":[{"projectId":"` + projectID + `","goalId":"` + goalID + `","unknown":true}]}`,
		`{"mode":"edit","ifRevision":"1","add":{}}`,
		`{"mode":"edit","ifRevision":"1","add":[` + strings.Repeat(endpoint+",", 30) + endpoint + `]}`,
		string([]byte{0xff}),
	}
	for _, revision := range []string{`null`, `1`, `""`, `"0"`, `"01"`, `"-1"`, `"+1"`, `" 1"`, `"1.0"`, `"1e0"`, `"9223372036854775808"`} {
		bodies = append(bodies, `{"mode":"replace","ifRevision":`+revision+`,"prerequisites":[]}`)
	}
	for i, body := range bodies {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			_, err := DecodeEdit([]byte(body))
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "invalid_input" {
				t.Fatalf("accepted %s: %v", body, err)
			}
		})
	}
}

func TestRelationshipProjectionPrivacyAndExactRevision(t *testing.T) {
	revision := int64(9007199254740993)
	edge := edgeID
	visible := taskcore.GoalDependencyTarget{ProjectID: projectID, ProjectName: "Project <&>", GoalID: goalID, Title: "Goal", Status: model.TaskDone, Kind: "external"}
	for _, canEdit := range []bool{false, true} {
		value := taskcore.GoalDependencies{GoalID: goalID, CanEdit: canEdit, Revision: &revision, CompletionBlocked: true, Prerequisites: []taskcore.GoalDependencyPrerequisite{{EdgeID: &edge}, {EdgeID: &edge, Target: &visible}}, Successors: []taskcore.GoalDependencyTarget{visible}}
		data, err := json.Marshal(MapRelationships(value))
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			t.Fatal(err)
		}
		_, revisionPresent := fields["revision"]
		if revisionPresent != canEdit || strings.Contains(string(data), `"edgeId"`) != canEdit || !strings.Contains(string(data), `"target":null`) || canEdit && string(fields["revision"]) != `"9007199254740993"` {
			t.Fatalf("privacy projection: %s", data)
		}
		mapped := MapRelationships(value)
		if mapped.Prerequisites[1].Target.ProjectName != visible.ProjectName || mapped.Successors[0].GoalID != goalID || mapped.NextCursor != nil {
			t.Fatalf("lost projection fields: %+v", mapped)
		}
	}
	data, err := json.Marshal(MapRelationships(taskcore.GoalDependencies{GoalID: goalID}))
	if err != nil || !strings.Contains(string(data), `"prerequisites":[]`) || !strings.Contains(string(data), `"successors":[]`) {
		t.Fatalf("empty arrays: %s %v", data, err)
	}
	receipt, err := json.Marshal(MapReceipt(taskcore.GoalDependencyReceipt{GoalID: goalID, Revision: math.MaxInt64, Changed: true}))
	if err != nil || string(receipt) != `{"goalId":"`+goalID+`","revision":"9223372036854775807","changed":true}` {
		t.Fatalf("receipt: %s %v", receipt, err)
	}
}
