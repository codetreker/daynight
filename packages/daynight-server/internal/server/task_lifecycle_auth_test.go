package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestTaskLifecycleAuthenticationAndMemberAccess(t *testing.T) {
	f := newTaskCredentialFixture(t)
	member := defaultHTTPPrincipal()
	memberSession := member
	memberSession.Kind, memberSession.CredentialID = model.SessionCredential, "77777777-7777-4777-8777-777777777777"
	admin := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
	outsider := model.Principal{UserID: "99999999-9999-4999-8999-999999999999", CredentialID: "88888888-8888-4888-8888-888888888888", Kind: model.SessionCredential}
	session := map[string]string{"Cookie": "__Host-daynight_session=" + httpTestToken(model.SessionCredential), "Origin": f.origin}
	foreign := map[string]string{"Cookie": session["Cookie"], "Origin": "https://foreign.example"}
	bearer := map[string]string{"Authorization": "Bearer " + defaultHTTPToken()}
	prerequisite := f.task
	prerequisite.ID, prerequisite.Title, prerequisite.Status = "66666666-6666-4666-8666-666666666666", "Completed external prerequisite", model.TaskDone
	current := f.task
	current.Title, current.Description = "Member workflow", "Original"
	current.DependsOn, current.ExternalDependsOn = []string{prerequisite.ID}, []string{prerequisite.ID}
	path := "/api/v1/projects/" + f.project.ID + "/tasks/" + current.ID
	next := current
	next.Description, next.AllowAgents, next.Version, next.UpdatedAt = "Revised by a member", true, 2, current.UpdatedAt.Add(time.Second)
	firstInput := taskcore.UpdateTask{Version: current.Version, Description: copyTaskHTTPPointer(&next.Description), AllowAgents: copyTaskHTTPPointer(&next.AllowAgents)}
	f.expectLifecycleUpdate(firstInput, next, nil)
	response := f.request(memberSession, http.MethodPatch, path, map[string]any{"version": current.Version, "description": "Revised by a member", "allowAgents": true}, session, 200, "", taskCredentialCalls("task-update"))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
	current = next

	guardPatch := func(body any, after model.Task, input taskcore.UpdateTask) {
		t.Helper()
		f.expectLifecycleUpdate(input, after, nil)
		f.request(model.Principal{}, http.MethodPatch, path, body, nil, 401, "unauthenticated", map[string]int{})
		f.expectLifecycleUpdate(input, after, &model.Fault{Code: "not_found", Message: "Project was not found."})
		f.request(outsider, http.MethodPatch, path, body, session, 404, "not_found", taskCredentialCalls("task-update"))
		f.expectLifecycleUpdate(input, after, nil)
		f.request(memberSession, http.MethodPatch, path, body, foreign, 403, "forbidden", taskCredentialCalls())
	}
	next = current
	next.AllowAgents, next.Version, next.UpdatedAt = false, 3, current.UpdatedAt.Add(time.Second)
	disable := map[string]any{"version": current.Version, "allowAgents": false}
	disableInput := taskcore.UpdateTask{Version: current.Version, AllowAgents: copyTaskHTTPPointer(&next.AllowAgents)}
	guardPatch(disable, next, disableInput)
	f.expectLifecycleUpdate(disableInput, next, nil)
	response = f.request(member, http.MethodPatch, path, disable, bearer, 200, "", taskCredentialCalls("task-update"))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
	current = next
	next = current
	next.ExternalDependsOn, next.Version, next.UpdatedAt = []string{}, 4, current.UpdatedAt.Add(time.Second)
	classify := map[string]any{"version": current.Version, "externalDependsOn": []string{}}
	classifyInput := taskcore.UpdateTask{Version: current.Version, ExternalDependsOn: copyTaskHTTPPointer(&next.ExternalDependsOn)}
	guardPatch(classify, next, classifyInput)
	f.expectLifecycleUpdate(classifyInput, next, nil)
	response = f.request(member, http.MethodPatch, path, classify, bearer, 200, "", taskCredentialCalls("task-update"))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
	current = next
	next = current
	next.ExternalDependsOn, next.Version, next.UpdatedAt = []string{prerequisite.ID}, 5, current.UpdatedAt.Add(time.Second)
	f.expectLifecycleUpdate(taskcore.UpdateTask{Version: current.Version, ExternalDependsOn: copyTaskHTTPPointer(&next.ExternalDependsOn)}, next, nil)
	response = f.request(memberSession, http.MethodPatch, path, map[string]any{"version": current.Version, "externalDependsOn": []string{prerequisite.ID}}, session, 200, "", taskCredentialCalls("task-update"))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
	current = next
	for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskTodo, model.TaskDone} {
		t.Run(string(status), func(t *testing.T) {
			next := current
			next.Status, next.Version, next.UpdatedAt, next.Ready = status, current.Version+1, current.UpdatedAt.Add(time.Second), status == model.TaskTodo
			if status == model.TaskInProgress {
				next.StartedAt = &next.UpdatedAt
			}
			if status == model.TaskTodo {
				next.StartedAt, next.CompletedAt = nil, nil
			}
			if status == model.TaskDone {
				next.CompletedAt = &next.UpdatedAt
			}
			body := api.TaskStatusUpdateRequest{Version: current.Version, Status: string(status)}
			f.expectLifecycleStatus(taskcore.SetTaskStatus{Version: current.Version, Status: status}, next, nil)
			for _, method := range []string{http.MethodPut, http.MethodDelete} {
				f.request(model.Principal{}, method, path+"/status", body, nil, 401, "unauthenticated", map[string]int{})
			}
			f.request(memberSession, http.MethodPut, path+"/status", body, foreign, 403, "forbidden", taskCredentialCalls())
			f.expectLifecycleStatus(taskcore.SetTaskStatus{Version: current.Version, Status: status}, next, &model.Fault{Code: "not_found", Message: "Project was not found."})
			f.request(outsider, http.MethodPut, path+"/status", body, session, 404, "not_found", taskCredentialCalls("task-status"))
			f.expectTaskRead(current, nil)
			response := f.request(memberSession, http.MethodGet, path, nil, session, 200, "", taskCredentialCalls("task-observe"))
			assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), current)
			f.expectLifecycleStatus(taskcore.SetTaskStatus{Version: current.Version, Status: status}, next, nil)
			actor, headers := member, map[string]string{"Authorization": bearer["Authorization"], "X-Request-ID": "lifecycle-member-" + string(status)}
			if status == model.TaskDone {
				actor, headers = memberSession, map[string]string{"Cookie": session["Cookie"], "Origin": f.origin, "X-Request-ID": "lifecycle-member-done"}
			}
			response = f.request(actor, http.MethodPut, path+"/status", body, headers, 200, "", taskCredentialCalls("task-status"))
			assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
			current = next
		})
	}
	f.authenticationError = model.Unauthenticated(model.ErrNotFound)
	for _, status := range []string{"todo", "in_progress", "done"} {
		body := api.TaskStatusUpdateRequest{Version: current.Version, Status: status}
		f.request(member, http.MethodPut, path+"/status", body, bearer, 401, "unauthenticated", taskCredentialCalls())
		f.request(memberSession, http.MethodPut, path+"/status", body, session, 401, "unauthenticated", taskCredentialCalls())
	}
	f.authenticationError = nil
	f.expectTaskRead(current, nil)
	response = f.request(admin, http.MethodGet, path, nil, session, 200, "", taskCredentialCalls("task-observe"))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), current)
	for _, status := range []string{"todo", "in_progress", "done"} {
		found := false
		for line := range strings.SplitSeq(f.logs.String(), "\n") {
			var entry map[string]any
			if json.Unmarshal([]byte(line), &entry) == nil && entry["component"] == "task" && entry["phase"] == "set_status" && entry["request_id"] == "lifecycle-member-"+status && entry["user_id"] == member.UserID {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s did not log authenticated member and request ID", status)
		}
	}
	for _, credential := range []string{defaultHTTPToken(), httpTestToken(model.SessionCredential)} {
		if strings.Contains(f.logs.String(), credential) {
			t.Fatal("lifecycle diagnostics exposed credential")
		}
	}
}
