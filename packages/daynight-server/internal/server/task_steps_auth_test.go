package server

import (
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestStepsHTTPAuthenticatedMemberAndHEAD(t *testing.T) {
	f, _, task := stepsHTTPFixture(t, io.Discard)
	admin := defaultHTTPPrincipal()
	admin.Kind = model.SessionCredential
	member := model.Principal{UserID: "b6666666-6666-4666-8666-666666666666", CredentialID: "c7777777-7777-4777-8777-777777777777", Kind: model.SessionCredential}
	outsider := model.Principal{UserID: "d8888888-8888-4888-8888-888888888888", CredentialID: "e9999999-9999-4999-8999-999999999999", Kind: model.SessionCredential}
	anonymous := model.Principal{}
	origin := configuredTestConfig().Server.PublicOrigin
	path := taskPath(task) + "/steps"
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: 1}
	current := []model.TaskStep{}
	for index, actor := range []model.Principal{admin, member} {
		f.principal = actor
		f.role = []model.ProjectRole{model.ProjectAdmin, model.ProjectMemberRole}[index]
		f.expectStepsRead(header, current)
		response := f.authenticatedRequest(actor, "GET", path, "", "", 200, "")
		resource := decodeResponse[api.StepsResource](t, response, 200)
		if resource.Steps == nil || len(resource.Steps) != 0 {
			t.Fatal("admin/member read failed")
		}
	}
	for _, suffix := range []string{"", "/00000000"} {
		for _, method := range []string{"GET", "HEAD", "POST"} {
			f.store.ReadSnapshotCall, f.store.WriteProjectCall = nil, nil
			response := f.authenticatedRequest(anonymous, method, path+suffix, "", "", 401, "")
			if method == "HEAD" && response.Body.Len() != 0 {
				t.Fatal("anonymous HEAD returned body")
			}
		}
		f.expectStepAccessError(false)
		f.authenticatedRequest(outsider, "GET", path+suffix, "", origin, 404, "not_found")
	}
	f.principal = member
	f.role = model.ProjectMemberRole
	f.expectStepsRead(header, current)
	response := f.authenticatedRequest(member, "HEAD", path, "", "", 200, "")
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Daynight-User-ID") != member.UserID {
		t.Fatal("HEAD lost identity/type or returned body")
	}
	deny := func(method, suffix, body string, anonymousCheck bool) {
		f.store.ReadSnapshotCall, f.store.WriteProjectCall = nil, nil
		if anonymousCheck {
			f.authenticatedRequest(anonymous, method, path+suffix, body, "", 401, "unauthenticated")
		}
		f.authenticatedRequest(member, method, path+suffix, body, "", 403, "forbidden")
		f.authenticatedRequest(member, method, path+suffix, body, "https://unrelated.invalid", 403, "forbidden")
		f.expectStepAccessError(true)
		f.authenticatedRequest(outsider, method, path+suffix, body, origin, 404, "not_found")
	}
	body := `{"version":1,"id":"00000000","title":"Member add"}`
	deny("POST", "", body, false)
	at := f.observed
	candidate := model.TaskStep{ID: "00000000", Position: 0, Title: "Member add", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.principal = member
	f.role = model.ProjectMemberRole
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "add", Candidate: candidate, Observed: at})
	response = f.authenticatedRequest(member, "POST", path, body, origin, 201, "")
	added := decodeResponse[api.StepsResource](t, response, 201)
	if added.Version != 2 || len(added.Steps) != 1 || response.Header().Get("Location") != path+"/00000000" {
		t.Fatal("member could not add")
	}
	current = []model.TaskStep{candidate}
	header.Version = 2
	at = at.Add(time.Minute)
	candidate = model.TaskStep{ID: "abcdef01", Position: 1, Title: "Admin add", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.principal = admin
	f.role = model.ProjectAdmin
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "add", Candidate: candidate, Observed: at})
	if decodeResponse[api.StepsResource](t, f.authenticatedRequest(admin, "POST", path, `{"version":2,"id":"abcdef01","title":"Admin add"}`, origin, 201, ""), 201).Version != 3 {
		t.Fatal("admin could not add")
	}
	current = append(current, candidate)
	header.Version = 3
	for _, change := range []struct{ method, suffix, body string }{{"PATCH", "/00000000", `{"version":3,"description":"edited"}`}, {"PUT", "/00000000/status", `{"version":4,"status":"in_progress"}`}} {
		deny(change.method, change.suffix, change.body, true)
		at = at.Add(time.Minute)
		candidate = current[0]
		candidate.UpdatedAt = at
		if change.method == "PATCH" {
			candidate.Description = "edited"
		} else {
			candidate.Status = model.TaskStepInProgress
		}
		f.principal = member
		f.role = model.ProjectMemberRole
		f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "change", Candidate: candidate, Observed: at})
		changed := decodeResponse[api.StepsResource](t, f.authenticatedRequest(member, change.method, path+change.suffix, change.body, origin, 200, ""), 200)
		if len(changed.Steps) != 2 {
			t.Fatal("member change lost collection")
		}
		current[0] = candidate
		header.Version++
	}
	moveBody := `{"version":5,"after":"ABCDEF01"}`
	deny("PUT", "/00000000/position", moveBody, true)
	f.principal = member
	f.role = model.ProjectMemberRole
	at = at.Add(time.Minute)
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "move", ID: "00000000", From: 0, To: 1, Observed: at})
	moved := decodeResponse[api.StepsResource](t, f.authenticatedRequest(member, "PUT", path+"/00000000/position", moveBody, origin, 200, ""), 200)
	if moved.Version != 6 || moved.Steps[1].ID != "00000000" {
		t.Fatal("member could not move")
	}
	current = []model.TaskStep{current[1], current[0]}
	current[0].Position = 0
	current[1].Position = 1
	header.Version = 6
	deleteBody := `{"version":6}`
	deny("DELETE", "/ABCDEF01", deleteBody, true)
	f.principal = member
	f.role = model.ProjectMemberRole
	at = at.Add(time.Minute)
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "delete", ID: "abcdef01", From: 0, To: 1, Observed: at})
	deleted := decodeResponse[api.StepsResource](t, f.authenticatedRequest(member, "DELETE", path+"/ABCDEF01", deleteBody, origin, 200, ""), 200)
	if deleted.Version != 7 || len(deleted.Steps) != 1 || deleted.Steps[0].ID != "00000000" {
		t.Fatal("member could not delete")
	}
	current = []model.TaskStep{current[1]}
	current[0].Position = 0
	header.Version = 7
	member.Kind = model.PATCredential
	f.principal = member
	f.expectStepsRead(header, current)
	f.authenticatedRequest(member, http.MethodGet, path, "", "", 200, "")
}
