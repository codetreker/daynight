package server

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestThreadHTTPAuthenticationAndExecutionAttribution(t *testing.T) {
	f := newTaskCredentialFixture(t)
	member := defaultHTTPPrincipal()
	admin := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
	outsider := model.Principal{UserID: "99999999-9999-4999-8999-999999999999", CredentialID: "88888888-8888-4888-8888-888888888888", Kind: model.SessionCredential}
	memberSession := member
	memberSession.Kind = model.SessionCredential
	memberSession.CredentialID = "77777777-7777-4777-8777-777777777777"
	session := map[string]string{"Cookie": "__Host-daynight_session=" + httpTestToken(model.SessionCredential), "Origin": f.origin}
	foreign := map[string]string{"Cookie": session["Cookie"], "Origin": "https://foreign.example"}
	bearer := map[string]string{"Authorization": "Bearer " + defaultHTTPToken()}
	claim := model.WorkerClaim{ClaimID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", State: model.WorkerActive, UserID: member.UserID, WorkerID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Machine: model.WorkerMachine{ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Name: "Thread worker"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", Phase: model.WorkerExecuting, ClaimedAt: f.task.CreatedAt}
	encoded, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	current := f.task
	current.Status, current.AllowAgents = model.TaskInProgress, true
	current.Properties = model.TaskProperties{"worker": encoded}
	path := "/api/v1/projects/" + f.project.ID + "/tasks/" + f.task.ID + "/thread/messages"
	body := map[string]any{"body": "Explicit authenticated discussion"}
	input := taskservice.CreateThreadMessage{Body: "Explicit authenticated discussion"}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodDelete} {
		code := "unauthenticated"
		if method == http.MethodHead {
			code = ""
		}
		response := f.request(model.Principal{}, method, path, body, nil, 401, code, map[string]int{})
		if method == http.MethodHead && response.Body.Len() != 0 {
			t.Fatal("anonymous HEAD returned a body")
		}
	}
	list := taskservice.ThreadListRequest{Count: 50}
	empty := api.ThreadPage{Items: []api.ThreadMessage{}}
	f.expectThreadRead(list, model.ThreadPage{Items: []model.ThreadMessage{}}, empty, &model.Fault{Code: "forbidden", Message: "Project access is required."})
	f.request(outsider, http.MethodGet, path, nil, session, 403, "forbidden", taskCredentialCalls("thread-list"))
	f.expectPost(input, model.ThreadMessage{}, api.ThreadMessage{}, &model.Fault{Code: "forbidden", Message: "Project access is required."})
	f.request(outsider, http.MethodPost, path, body, session, 403, "forbidden", taskCredentialCalls("thread-post"))
	f.request(memberSession, http.MethodPost, path, body, foreign, 403, "forbidden", taskCredentialCalls())
	name := "Member"
	plain := model.ThreadMessage{TaskID: f.task.ID, ID: "00000000-0000-4000-8000-000000000001", Author: model.ThreadAuthor{UserID: member.UserID, DisplayName: &name}, Body: "Explicit authenticated discussion", CreatedAt: time.Date(2026, 1, 2, 3, 4, 6, 0, time.UTC)}
	plainJSON := api.ThreadMessage{ID: "00000000-0000-4000-8000-000000000001", Author: api.ThreadAuthor{UserID: member.UserID, DisplayName: copyTaskHTTPPointer(&name)}, Body: "Explicit authenticated discussion", CreatedAt: "2026-01-02T03:04:06.000Z"}
	f.expectPost(input, plain, plainJSON, nil)
	response := f.request(member, http.MethodPost, path, body, bearer, 201, "", taskCredentialCalls("thread-post"))
	plainResource := taskCredentialDecode[api.ThreadMessage](t, response)
	if !reflect.DeepEqual(plainResource, plainJSON) {
		t.Fatalf("ordinary message wire=%#v, want=%#v", plainResource, plainJSON)
	}
	if plainResource.Author.UserID != member.UserID || plainResource.Author.Agent || plainResource.Author.Execution != nil {
		t.Fatal("PAT author was not derived from authenticated account")
	}
	body["claimId"] = claim.ClaimID
	input.ClaimID = copyTaskHTTPPointer(&claim.ClaimID)
	agent := model.ThreadMessage{TaskID: f.task.ID, ID: "00000000-0000-4000-8000-000000000002", Author: model.ThreadAuthor{UserID: member.UserID, DisplayName: &name, Agent: true, Execution: &model.ThreadExecution{ClaimID: claim.ClaimID, WorkerID: claim.WorkerID, Provider: "codex"}}, Body: "Explicit authenticated discussion", CreatedAt: time.Date(2026, 1, 2, 3, 4, 7, 0, time.UTC)}
	agentJSON := api.ThreadMessage{ID: "00000000-0000-4000-8000-000000000002", Author: api.ThreadAuthor{UserID: member.UserID, DisplayName: copyTaskHTTPPointer(&name), Agent: true}, Body: "Explicit authenticated discussion", CreatedAt: "2026-01-02T03:04:07.000Z"}
	f.expectPost(input, agent, agentJSON, &model.Fault{Code: "forbidden", Message: "Only the current execution owner may post as the agent."})
	f.request(admin, http.MethodPost, path, body, session, 403, "forbidden", taskCredentialCalls("thread-post"))
	f.expectPost(input, agent, agentJSON, nil)
	response = f.request(member, http.MethodPost, path, body, bearer, 201, "", taskCredentialCalls("thread-post"))
	agentResource := taskCredentialDecode[api.ThreadMessage](t, response)
	if !reflect.DeepEqual(agentResource, agentJSON) {
		t.Fatalf("agent message wire=%#v, want=%#v", agentResource, agentJSON)
	}
	if !agentResource.Author.Agent || agentResource.Author.UserID != member.UserID || agentResource.Author.Execution != nil {
		t.Fatal("default author resource exposed details or lost Agent marker")
	}
	messages := model.ThreadPage{Items: []model.ThreadMessage{plain, agent}}
	detailedAgentJSON := api.ThreadMessage{ID: "00000000-0000-4000-8000-000000000002", Author: api.ThreadAuthor{UserID: member.UserID, DisplayName: copyTaskHTTPPointer(&name), Agent: true, Execution: &api.ThreadExecution{ClaimID: claim.ClaimID, WorkerID: claim.WorkerID, Provider: "codex"}}, Body: "Explicit authenticated discussion", CreatedAt: "2026-01-02T03:04:07.000Z"}
	detailedJSON := api.ThreadPage{Items: []api.ThreadMessage{plainJSON, detailedAgentJSON}}
	f.expectThreadRead(taskservice.ThreadListRequest{Count: 50, Details: true}, messages, detailedJSON, nil)
	response = f.request(member, http.MethodGet, path+"?details=true", nil, bearer, 200, "", taskCredentialCalls("thread-list"))
	if response.Header().Get("Daynight-User-ID") != member.UserID {
		t.Fatal("Thread response lost authenticated identity header")
	}
	page := taskCredentialDecode[api.ThreadPage](t, response)
	if !reflect.DeepEqual(page, detailedJSON) {
		t.Fatalf("detailed page wire=%#v, want=%#v", page, detailedJSON)
	}
	if len(page.Items) != 2 || page.Items[0].Author.Execution != nil || page.Items[1].Author.Execution == nil || page.Items[1].Author.Execution.ClaimID != claim.ClaimID || page.Items[1].Author.Execution.WorkerID != claim.WorkerID || page.Items[1].Author.Execution.Provider != "codex" {
		t.Fatal("detailed author did not retain bounded verified execution source")
	}
	f.expectTaskRead(current, nil)
	response = f.request(member, http.MethodGet, "/api/v1/projects/"+f.project.ID+"/tasks/"+f.task.ID, nil, bearer, 200, "", taskCredentialCalls("task-observe"))
	observed := taskCredentialDecode[api.Task](t, response)
	if observed.Version != current.Version || observed.UpdatedAt != current.UpdatedAt {
		t.Fatal("Thread Task observation changed metadata")
	}
	f.expectPost(input, model.ThreadMessage{}, api.ThreadMessage{}, &model.Fault{Code: "claim_conflict", Message: "Task worker claim does not match the active execution."})
	f.request(member, http.MethodPost, path, body, bearer, 409, "claim_conflict", taskCredentialCalls("thread-post"))
	f.expectThreadRead(taskservice.ThreadListRequest{Count: 50, Details: true}, messages, detailedJSON, nil)
	response = f.request(member, http.MethodGet, path+"?details=true", nil, bearer, 200, "", taskCredentialCalls("thread-list"))
	if taskCredentialDecode[api.ThreadPage](t, response).Items[1].Author.Execution.ClaimID != claim.ClaimID {
		t.Fatal("current claim state changed historical author attribution")
	}
	f.expectThreadRead(list, messages, api.ThreadPage{Items: []api.ThreadMessage{plainJSON, agentJSON}}, nil)
	response = f.request(member, http.MethodHead, path, nil, bearer, 200, "", taskCredentialCalls("thread-list"))
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "application/json" {
		t.Fatal("HEAD returned a body or lost response metadata")
	}
	for _, private := range []string{defaultHTTPToken(), httpTestToken(model.SessionCredential), "Explicit authenticated discussion"} {
		if strings.Contains(f.logs.String(), private) {
			t.Fatal("Thread leaked credentials or discussion to logs")
		}
	}
}
