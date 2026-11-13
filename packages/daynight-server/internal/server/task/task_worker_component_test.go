package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func componentWorkerHTTPTask(t *testing.T) model.Task {
	t.Helper()
	_, current, actor := taskHTTPMockModels()
	current.Title, current.Description = "Interoperable execution", "initial description"
	current.AssignedTo, current.AllowAgents = &actor.UserID, true
	return current
}

func workerHTTPProperties(t *testing.T, before model.TaskProperties, worker *model.WorkerClaim) model.TaskProperties {
	t.Helper()
	result := copyTaskHTTPProperties(before)
	if worker == nil {
		delete(result, "worker")
		delete(result, "sessionStartup")
		return result
	}
	encoded, err := taskproperty.EncodeWorker(worker)
	if err != nil {
		t.Fatal(err)
	}
	result["worker"] = encoded
	return result
}

func workerHTTPWriteValues(task model.Task) store.TaskWrite {
	return copyTaskHTTPWrite(store.TaskWrite{Type: task.Type, ParentID: task.ParentID, Title: task.Title, Description: task.Description, Status: task.Status,
		AssignedTo: task.AssignedTo, RequiredPlatform: task.RequiredPlatform, AllowAgents: task.AllowAgents,
		Properties: task.Properties, DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn})
}

type workerHTTPWritePlan struct {
	t                       *testing.T
	TaskDAO                 *taskHTTPWriterMock
	AccessCalls, TaskReads  int
	AccessError             error
	ObservedCalls           int
	access, reads, observed int
	writes, updates, drains int
	receipts, captures      int
	wantUpdate, wantCapture bool
	active                  bool
	ctx                     context.Context
}

func expectWorkerHTTPWrite(t *testing.T, database *httpTestStore, current model.Task, actor model.Principal, role model.ProjectRole, expected *store.TaskWrite, returned model.Task, observedAt *time.Time, completion store.TransactionOutcome) *workerHTTPWritePlan {
	t.Helper()
	current, returned = copyTaskHTTPTask(current), copyTaskHTTPTask(returned)
	if expected != nil {
		values := copyTaskHTTPWrite(*expected)
		expected = &values
	}
	observedAt = copyTaskHTTPPointer(observedAt)
	plan := &workerHTTPWritePlan{t: t, AccessCalls: 1, TaskReads: 1, wantUpdate: expected != nil}
	base := newTaskHTTPMockBase(t, "worker HTTP write")
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project")}
	tasks := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("task")}
	plan.TaskDAO = tasks
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base.withLabel("session")}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base.withLabel("capture")}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base.withLabel("scope"),
		ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return tasks },
		SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
	checkContext := func(ctx context.Context) {
		if !plan.active || ctx != plan.ctx {
			t.Fatal("Worker DAO escaped its request transaction")
		}
	}
	project.ProjectAccessFn = func(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
		checkContext(ctx)
		plan.access++
		if principal != actor || plan.access > plan.AccessCalls {
			t.Fatalf("unexpected Worker authorization: %#v", principal)
		}
		return model.ProjectAccess{ProjectID: current.ProjectID, UserID: actor.UserID, Role: role}, plan.AccessError
	}
	tasks.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		checkContext(ctx)
		plan.reads++
		if id != current.ID || plan.reads > plan.TaskReads {
			t.Fatalf("unexpected Worker Task lookup: %s", id)
		}
		return copyTaskHTTPTask(current), nil
	}
	if observedAt != nil {
		plan.ObservedCalls = 1
		tasks.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			checkContext(ctx)
			plan.observed++
			if plan.observed != 1 {
				t.Fatal("Worker claim sampled the clock more than once")
			}
			return *observedAt, nil
		}
	}
	if expected != nil {
		tasks.UpdateTaskFn = func(ctx context.Context, id string, actual store.TaskWrite) (model.Task, error) {
			checkContext(ctx)
			plan.updates++
			if id != current.ID || plan.updates != 1 || !reflect.DeepEqual(actual, *expected) {
				t.Fatalf("Worker proposed write: got %#v, want %#v", actual, *expected)
			}
			return copyTaskHTTPTask(returned), nil
		}
		wantDrain := store.TaskSessionDrain{SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle",
			RemoveFields:   []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
			SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}}
		worker, err := taskproperty.Worker(returned.Properties)
		if err != nil {
			t.Fatal(err)
		}
		if returned.Status == model.TaskInProgress && worker != nil && worker.State == model.WorkerActive && worker.AgentControlMode == model.AgentControlModeWeb {
			wantDrain.ActiveClaim = &worker.ClaimID
		}
		sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, actual store.TaskSessionDrain) error {
			checkContext(ctx)
			plan.drains++
			if id != current.ID || plan.drains != 1 || plan.updates != 1 || !reflect.DeepEqual(actual, wantDrain) {
				t.Fatalf("Worker Session drain: %#v", actual)
			}
			return nil
		}
		wantReceipt := store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}}
		sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, actual store.TaskSessionReceiptTransition) error {
			checkContext(ctx)
			plan.receipts++
			if id != current.ID || plan.receipts != 1 || plan.drains != 1 || !reflect.DeepEqual(actual, wantReceipt) {
				t.Fatalf("Worker receipt transition: %#v", actual)
			}
			return nil
		}
		if current.Status != returned.Status {
			plan.wantCapture = true
			capture.FreezeAudienceFn = func(ctx context.Context, projectID string, types []string) ([]store.WebhookAudience, error) {
				checkContext(ctx)
				plan.captures++
				if projectID != current.ProjectID || plan.captures != 1 || plan.receipts != 1 || !reflect.DeepEqual(types, []string{protocol.StatusChanged}) {
					t.Fatalf("Worker status capture: %s %v", projectID, types)
				}
				return []store.WebhookAudience{}, nil
			}
		}
	}
	database.WriteProjectCall = func(ctx context.Context, projectID string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		plan.writes++
		if projectID != current.ProjectID || work == nil || plan.writes != 1 || plan.active {
			t.Fatal("Worker action did not use one independent Project transaction")
		}
		plan.ctx, plan.active = ctx, true
		defer func() { plan.active = false }()
		err := work(scope)
		return store.Completion{Outcome: completion}, err
	}
	return plan
}

func (plan *workerHTTPWritePlan) check() {
	plan.t.Helper()
	wantWrites, wantCapture := 0, 0
	if plan.wantUpdate {
		wantWrites = 1
	}
	if plan.wantCapture {
		wantCapture = 1
	}
	if plan.writes != 1 || plan.access != plan.AccessCalls || plan.reads != plan.TaskReads || plan.observed != plan.ObservedCalls || plan.updates != wantWrites || plan.drains != wantWrites || plan.receipts != wantWrites || plan.captures != wantCapture {
		plan.t.Fatalf("Worker calls: scope/access/read/clock/update/drain/receipt/capture=%d/%d/%d/%d/%d/%d/%d/%d; want 1/%d/%d/%d/%d/%d/%d/%d", plan.writes, plan.access, plan.reads, plan.observed, plan.updates, plan.drains, plan.receipts, plan.captures, plan.AccessCalls, plan.TaskReads, plan.ObservedCalls, wantWrites, wantWrites, wantWrites, wantCapture)
	}
}

func claimHTTPWorker(t *testing.T, handler http.Handler, task api.Task, body map[string]any) api.Task {
	t.Helper()
	body["version"] = task.Version
	response := projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body))
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("worker claim response can be cached")
	}
	return decodeResponse[api.Task](t, response, http.StatusOK)
}

func TestWorkerHTTPClaimRequiresAuthenticatedAssignee(t *testing.T) {
	f := newTaskHTTPFixture(t)
	other := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, assigned := range []*string{nil, &other, &f.principal.UserID} {
		current := componentWorkerHTTPTask(t)
		current.Title, current.AssignedTo = "Worker assignment eligibility", assigned
		path := taskCollection(current.ProjectID) + "/" + current.ID
		body := workerCredentialClaimBody(current.Version)
		var returned model.Task
		if assigned == nil || *assigned != f.principal.UserID {
			plan := expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, nil, model.Task{}, nil, store.TransactionCommitted)
			assertProjectError(t, projectRequest(f.handler, http.MethodPost, path+"/worker-claim", jsonBody(t, body)), http.StatusConflict, "invalid_transition")
			plan.check()
			f.expectRead(current)
			actual := readHTTPTask(t, f.handler, api.Task{ID: current.ID, ProjectID: current.ProjectID})
			expected := api.Task{ID: current.ID, Type: current.Type, ParentID: current.ParentID, ProjectID: current.ProjectID, Title: current.Title, Description: current.Description,
				Status: "todo", Version: current.Version, CreatedAt: current.CreatedAt, UpdatedAt: current.UpdatedAt,
				Properties: api.TaskProperties{}, Tags: tagHTTPReferences(current.Tags), AssignedTo: assigned, AllowAgents: true, Ready: true,
				DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}}
			if !reflect.DeepEqual(actual, expected) {
				t.Fatal("rejected automatic claim changed task facts")
			}
			continue
		}
		claimedAt := current.UpdatedAt.Add(time.Second)
		worker := model.WorkerClaim{ClaimID: body["claimId"].(string), WorkerID: body["workerId"].(string), UserID: f.principal.UserID,
			Machine: model.WorkerMachine{ID: body["machine"].(map[string]any)["id"].(string), Name: "Worker machine"}, Platform: model.PlatformLinux,
			Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: body["worktreeId"].(string),
			State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
		returned = current
		returned.Status, returned.Version, returned.Ready = model.TaskInProgress, current.Version+1, false
		returned.StartedAt, returned.UpdatedAt = &claimedAt, claimedAt
		returned.Properties = workerHTTPProperties(t, current.Properties, &worker)
		values := workerHTTPWriteValues(returned)
		plan := expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, &values, returned, &claimedAt, store.TransactionCommitted)
		claimed := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, path+"/worker-claim", jsonBody(t, body)), http.StatusOK)
		plan.check()
		if claimed.Status != "in_progress" || !reflect.DeepEqual(claimed.AssignedTo, assigned) || apiWorker(t, claimed.Properties).UserID != f.principal.UserID {
			t.Fatalf("claim did not use authenticated assignee: %#v", claimed)
		}
	}
}

func TestTaskHTTPWorkerInventoryFiltersAndCursor(t *testing.T) {
	f := newTaskHTTPFixture(t)
	workerID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	var wanted []model.Task
	paused := map[string]string{}
	for index, value := range []string{"true", "false", ""} {
		current := componentWorkerHTTPTask(t)
		current.ID = fmt.Sprintf("55555555-5555-4555-8555-%012d", index+1)
		current.Title, current.Status, current.Ready = "Inventory task", model.TaskInProgress, false
		worker := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: f.principal.UserID, WorkerID: workerID,
			Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Worker machine"}, Platform: model.PlatformLinux,
			Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: uuid.NewString(),
			State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: current.UpdatedAt}
		current.Properties = workerHTTPProperties(t, current.Properties, &worker)
		if value != "" {
			current.Properties["paused"] = json.RawMessage(value)
			paused[current.ID] = value
		}
		wanted = append(wanted, current)
	}
	collection := taskCollection(f.project.ID)
	query := "?limit=1&workerId=" + strings.ToUpper(workerID)
	var cursor *string
	var ids []string
	for index, current := range wanted {
		requestPath := collection + query
		var after *store.Position
		if cursor != nil {
			requestPath += "&cursor=" + url.QueryEscape(*cursor)
			previous := wanted[index-1]
			after = &store.Position{CreatedAt: previous.CreatedAt, ID: previous.ID}
		}
		expected := store.TaskQuery{Page: store.Page{After: after, Limit: 1}, Worker: &store.WorkerQuery{UserID: f.principal.UserID, WorkerID: workerID}}
		f.expectList([]store.TaskQuery{expected}, []store.TaskPage{{Items: []model.Task{current}, HasMore: index < len(wanted)-1}})
		response := projectRequest(f.handler, http.MethodGet, requestPath, "")
		page := decodeResponse[api.TaskPage](t, response, http.StatusOK)
		if response.Header().Get("Cache-Control") != "no-store" || len(page.Items) != 1 || apiWorker(t, page.Items[0].Properties) == nil || apiWorker(t, page.Items[0].Properties).WorkerID != workerID || apiWorker(t, page.Items[0].Properties).State != "active" {
			t.Fatalf("wrong inventory page: %s", response.Body)
		}
		item := page.Items[0]
		value, exists := item.Properties["paused"]
		wantValue, wantExists := paused[item.ID]
		if exists != wantExists || string(value) != wantValue {
			t.Fatalf("inventory changed paused presence/value: %#v", item.Properties)
		}
		ids = append(ids, item.ID)
		if index == len(wanted)-1 {
			if page.NextCursor != nil {
				t.Fatal("final inventory page unexpectedly continues")
			}
			break
		}
		if page.NextCursor == nil {
			t.Fatal("inventory omitted cursor for later task")
		}
		cursor = page.NextCursor
		for _, changed := range []string{"", "&workerId=" + uuid.NewString()} {
			assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?limit=1&cursor="+url.QueryEscape(*cursor)+changed, ""), http.StatusBadRequest, "invalid_input")
		}
		query = "?limit=1&workerId=" + workerID
	}
	wantedIDs := make([]string, len(wanted))
	for index := range wanted {
		wantedIDs[index] = wanted[index].ID
	}
	if !slices.Equal(ids, wantedIDs) {
		t.Fatalf("inventory filtering hid later tasks: got %v want %v", ids, wantedIDs)
	}
	for _, query := range []string{"workerId=", "workerId=invalid", "workerId=null", "workerId=true", "workerId=" + workerID + "&workerId=" + workerID, "WorkerId=" + workerID, "userId=" + f.principal.UserID} {
		assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
}

func TestTaskHTTPAssignmentExecutionLocksAndPreservesClaim(t *testing.T) {
	for _, workerExecution := range []bool{false, true} {
		t.Run(map[bool]string{false: "manual", true: "worker"}[workerExecution], func(t *testing.T) {
			f := newTaskHTTPFixture(t)
			other := "c6666666-6666-4666-8666-666666666666"
			declared := f.target
			declared.Title = "Executing assignment"
			task, _ := assignmentHTTPCreate(f, declared, jsonBody(t, map[string]any{"status": "todo", "title": declared.Title, "assignedTo": f.principal.UserID}), nil)
			after := platformHTTPResult(task, task)
			after.AllowAgents = true
			task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true}, nil, true)
			if workerExecution {
				body := workerCredentialClaimBody(task.Version)
				claimedAt := task.UpdatedAt.Add(time.Second)
				claim := model.WorkerClaim{ClaimID: body["claimId"].(string), WorkerID: body["workerId"].(string), UserID: f.principal.UserID,
					Machine: model.WorkerMachine{ID: body["machine"].(map[string]any)["id"].(string), Name: "Worker machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: body["worktreeId"].(string), State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
				after = task
				after.Status, after.Version, after.Ready = model.TaskInProgress, task.Version+1, false
				after.StartedAt, after.UpdatedAt = copyTaskHTTPPointer(&claimedAt), claimedAt
				after.Properties = workerHTTPProperties(t, task.Properties, &claim)
				values := workerHTTPWriteValues(after)
				plan := expectWorkerHTTPWrite(t, f.store, task, f.principal, model.ProjectAdmin, &values, after, &claimedAt, store.TransactionCommitted)
				got := claimHTTPWorker(t, f.handler, assignmentHTTPAPI(t, task), body)
				plan.check()
				platformHTTPCheck(t, got, assignmentHTTPAPI(t, after))
				task = after
			} else {
				task = platformHTTPStatus(f, task, model.TaskInProgress)
			}
			if task.AssignedTo == nil || *task.AssignedTo != f.principal.UserID {
				t.Fatal("start discarded assignment")
			}
			assignmentHTTPUpdate(f, task, task, map[string]any{"assignedTo": f.principal.UserID}, nil, false)
			assignmentHTTPMutation(f, &task, nil, nil, nil, false, nil, nil, store.TransactionCommitted)
			same := setHTTPTask(t, f.handler, assignmentHTTPAPI(t, task), "in_progress")
			platformHTTPCheck(t, same, assignmentHTTPAPI(t, task))
			for _, target := range []*string{nil, &other} {
				candidate := task
				candidate.AssignedTo, candidate.Title = target, "Must not save"
				values := platformHTTPValues(candidate)
				assignmentHTTPMutation(f, &task, &values, nil, nil, true, nil, nil, store.TransactionCommitted)
				assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), jsonBody(t, map[string]any{"version": task.Version, "assignedTo": target, "title": "Must not save"})), http.StatusConflict, "invalid_transition")
				f.expectRead(task)
				platformHTTPCheck(t, readHTTPTask(t, f.handler, assignmentHTTPAPI(t, task)), assignmentHTTPAPI(t, task))
			}
			if workerExecution {
				claim := apiWorker(t, task.Properties)
				completed := *claim
				completed.State = "completed"
				after = platformHTTPResult(task, task)
				after.Status, after.Ready = model.TaskDone, false
				after.CompletedAt = copyTaskHTTPPointer(&after.UpdatedAt)
				raw, err := json.Marshal(completed)
				if err != nil {
					t.Fatal(err)
				}
				after.Properties = model.TaskProperties{"worker": raw}
				values := workerHTTPWriteValues(after)
				plan := expectWorkerHTTPWrite(t, f.store, task, f.principal, model.ProjectAdmin, &values, after, nil, store.TransactionCommitted)
				got := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPut, taskPath(assignmentHTTPAPI(t, task))+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: "done", ClaimID: &claim.ClaimID})), http.StatusOK)
				plan.check()
				platformHTTPCheck(t, got, assignmentHTTPAPI(t, after))
				task = after
			} else {
				task = platformHTTPStatus(f, task, model.TaskDone)
			}
			before := task
			after = platformHTTPResult(task, task)
			after.AssignedTo, after.AllowAgents = &other, false
			task = assignmentHTTPUpdate(f, task, after, map[string]any{"assignedTo": other}, nil, true)
			assertHTTPAssignmentTransition(t, assignmentHTTPAPI(t, before), assignmentHTTPAPI(t, task), &other)
			if !reflect.DeepEqual(apiWorker(t, assignmentHTTPAPI(t, task).Properties), apiWorker(t, assignmentHTTPAPI(t, before).Properties)) {
				t.Fatal("completed assignment changed claim history")
			}
		})
	}
}

type workerHTTPCredential struct {
	principal model.Principal
	value     string
}

func workerCredentialClaimBody(version int64) map[string]any {
	return map[string]any{"version": version, "claimId": uuid.NewString(), "workerId": uuid.NewString(),
		"machine": map[string]any{"id": uuid.NewString(), "name": "Worker machine"}, "platform": "linux", "agent": "codex", "worktreeId": uuid.NewString()}
}

func TestWorkerHTTPAuthenticatedOwnerAndWithdrawal(t *testing.T) {
	database := newHTTPTestStore(t)
	var logs bytes.Buffer
	origin := "https://daynight.example"
	handler := taskComponentHandler(t, database, &logs, defaultHTTPPrincipal())
	var authActor *workerHTTPCredential
	writes, authenticates := 0, 0
	authentication := &taskHTTPIdentityWriter{t: t}
	authentication.WriteIdentityCall = func(ctx context.Context, run func() error) (store.Completion, error) {
		writes++
		if authActor == nil || writes != 1 || run == nil || ctx.Err() != nil {
			t.Fatal("worker request authenticated more than once or without a credential")
		}
		err := run()
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	authentication.AuthenticateCall = func(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
		authenticates++
		if authActor == nil || authenticates != 1 || kind != authActor.principal.Kind || !bytes.Equal(hash, secret.Hash(authActor.value)) || now.IsZero() || now.Location() != time.UTC || ctx.Err() != nil {
			t.Fatal("worker authentication changed credential kind, hash, time, or context")
		}
		return authActor.principal, nil
	}
	handler.AuthenticateFunc = identityservice.New(authentication, nil, origin+"/api/v1/auth/callback").Authenticate
	admin := workerHTTPCredential{principal: model.Principal{UserID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CredentialID: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", Kind: model.SessionCredential}, value: secret.Random("dnst_")}
	member := workerHTTPCredential{principal: model.Principal{UserID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", CredentialID: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", Kind: model.SessionCredential}, value: secret.Random("dnst_")}
	outsider := workerHTTPCredential{principal: model.Principal{UserID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", CredentialID: "cccccccc-1111-4111-8111-cccccccccccc", Kind: model.SessionCredential}, value: secret.Random("dnst_")}
	bearer := workerHTTPCredential{principal: model.Principal{UserID: member.principal.UserID, CredentialID: "dddddddd-1111-4111-8111-dddddddddddd", Kind: model.PATCredential}, value: secret.Random("dnpat_")}
	request := func(actor *workerHTTPCredential, plan *workerHTTPWritePlan, method, path string, body any, requestOrigin string, status int, code string) *httptest.ResponseRecorder {
		t.Helper()
		authActor, writes, authenticates = actor, 0, 0
		if plan == nil {
			database.WriteProjectCall = nil
		}
		req := httptest.NewRequest(method, origin+path, strings.NewReader(jsonBody(t, body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Request-ID", "worker-owner-test")
		if requestOrigin != "" {
			req.Header.Set("Origin", requestOrigin)
		}
		if actor != nil {
			if actor.principal.Kind == model.PATCredential {
				req.Header.Set("Authorization", "Bearer "+actor.value)
			} else {
				req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: actor.value})
			}
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("worker response status/cache=%d/%q body=%s", response.Code, response.Header().Get("Cache-Control"), response.Body)
		}
		if code != "" && decodeResponse[api.ErrorResponse](t, response, status).Error.Code != code {
			t.Fatalf("unexpected worker refusal code: %s", response.Body)
		}
		if code == "" && response.Header().Get("Daynight-User-ID") != actor.principal.UserID {
			t.Fatal("worker response lost its authenticated identity")
		}
		wantAuth := 0
		if actor != nil {
			wantAuth = 1
		}
		if writes != wantAuth || authenticates != wantAuth {
			t.Fatalf("worker authentication write/DAO calls=%d/%d want=%d", writes, authenticates, wantAuth)
		}
		if plan != nil {
			plan.check()
		}
		database.WriteProjectCall = nil
		return response
	}
	current := componentWorkerHTTPTask(t)
	current.Title, current.AssignedTo = "Owned execution", &member.principal.UserID
	platform := model.TaskPlatform("linux")
	current.RequiredPlatform = &platform
	taskPath := "/api/v1/projects/" + current.ProjectID + "/tasks/" + current.ID
	path := taskPath + "/worker-claim"
	refusal := func(actor workerHTTPCredential, role model.ProjectRole, accessCalls int, method, path string, body any, status int, code string) {
		t.Helper()
		plan := expectWorkerHTTPWrite(t, database, current, actor.principal, role, nil, model.Task{}, nil, store.TransactionCommitted)
		plan.AccessCalls = accessCalls
		if actor.principal == outsider.principal {
			plan.AccessError, plan.TaskReads = model.ErrNotFound, 0
		}
		request(&actor, plan, method, path, body, origin, status, code)
	}
	assertAuthenticationRefusals := func(method, actionPath string, body any) {
		t.Helper()
		request(nil, nil, method, actionPath, body, "", http.StatusUnauthorized, "unauthenticated")
		refusal(outsider, model.ProjectMemberRole, 1, method, actionPath, body, http.StatusNotFound, "not_found")
		request(&member, nil, method, actionPath, body, "https://foreign.example", http.StatusForbidden, "forbidden")
	}
	claimedAt := current.UpdatedAt.Add(time.Minute)
	claimResult := func(before model.Task, body map[string]any, owner string) (model.Task, model.WorkerClaim) {
		t.Helper()
		machine := body["machine"].(map[string]any)
		claim := model.WorkerClaim{ClaimID: body["claimId"].(string), State: model.WorkerActive, UserID: owner, WorkerID: body["workerId"].(string), Machine: model.WorkerMachine{ID: machine["id"].(string), Name: machine["name"].(string)}, Platform: "linux", Agent: "codex", AgentControlMode: model.AgentControlModeHerdr, WorktreeID: body["worktreeId"].(string), Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
		after := before
		after.Status, after.Ready, after.Version = model.TaskInProgress, false, before.Version+1
		startedAt := claimedAt
		after.UpdatedAt, after.StartedAt = claimedAt, &startedAt
		after.Properties = workerHTTPProperties(t, before.Properties, &claim)
		return after, claim
	}
	apply := func(actor workerHTTPCredential, role model.ProjectRole, accesses int, method, actionPath string, body any, after model.Task, clock *time.Time) api.Task {
		t.Helper()
		expected := workerHTTPWriteValues(after)
		plan := expectWorkerHTTPWrite(t, database, current, actor.principal, role, &expected, after, clock, store.TransactionCommitted)
		plan.AccessCalls = accesses
		requestOrigin := origin
		if actor.principal.Kind == model.PATCredential {
			requestOrigin = ""
		}
		response := request(&actor, plan, method, actionPath, body, requestOrigin, http.StatusOK, "")
		task := decodeResponse[api.Task](t, response, http.StatusOK)
		if task.Version != after.Version || task.Status != string(after.Status) || task.AssignedTo == nil || *task.AssignedTo != member.principal.UserID {
			t.Fatalf("worker resource did not reflect the supplied authoritative row: %#v", task)
		}
		return task
	}
	body := workerCredentialClaimBody(current.Version)
	assertAuthenticationRefusals(http.MethodPost, path, body)
	after, firstClaim := claimResult(current, body, member.principal.UserID)
	task := apply(bearer, model.ProjectMemberRole, 1, http.MethodPost, path, body, after, &claimedAt)
	current = after
	if claim := apiWorker(t, task.Properties); claim == nil || claim.UserID != member.principal.UserID || claim.UserID == admin.principal.UserID {
		t.Fatal("PAT claim did not derive its execution owner from authentication")
	}
	for _, action := range []struct {
		method, path string
		body         map[string]any
	}{
		{http.MethodPatch, path, map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID, "phase": "executing"}},
		{http.MethodPost, path + "/release", map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID, "stoppedConfirmed": true}},
		{http.MethodPost, path + "/withdraw", map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID}},
	} {
		assertAuthenticationRefusals(action.method, action.path, action.body)
	}
	refusal(admin, model.ProjectAdmin, 1, http.MethodPatch, path, map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID, "phase": "executing"}, http.StatusForbidden, "forbidden")
	withdrawn := current
	withdrawn.Status, withdrawn.AllowAgents, withdrawn.Ready = model.TaskTodo, false, true
	withdrawn.StartedAt, withdrawn.CompletedAt = nil, nil
	withdrawn.Version, withdrawn.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Microsecond)
	withdrawn.Properties = workerHTTPProperties(t, current.Properties, nil)
	task = apply(bearer, model.ProjectMemberRole, 1, http.MethodPost, path+"/withdraw", map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID}, withdrawn, nil)
	current = withdrawn
	if apiWorker(t, task.Properties) != nil || task.AllowAgents || task.Status != "todo" || task.StartedAt != nil || task.CompletedAt != nil {
		t.Fatal("owner withdrawal did not reset execution and disable automatic claims")
	}
	refusal(member, model.ProjectMemberRole, 1, http.MethodPatch, path, map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID, "phase": "executing"}, http.StatusConflict, "claim_conflict")
	enabled := current
	enabled.AllowAgents, enabled.Version, enabled.UpdatedAt = true, current.Version+1, current.UpdatedAt.Add(time.Microsecond)
	expected := workerHTTPWriteValues(enabled)
	enabledPlan := expectWorkerHTTPWrite(t, database, current, member.principal, model.ProjectMemberRole, &expected, enabled, nil, store.TransactionCommitted)
	dependencyReads := 0
	enabledPlan.TaskDAO.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
		dependencyReads++
		if !enabledPlan.active || ctx != enabledPlan.ctx || dependencyReads != 1 || len(ids) != 0 {
			t.Fatal("worker permission update changed its prerequisite read")
		}
		return []model.Task{}, nil
	}
	request(&member, enabledPlan, http.MethodPatch, taskPath, map[string]any{"version": current.Version, "allowAgents": true}, origin, http.StatusOK, "")
	if dependencyReads != 1 {
		t.Fatal("worker permission update omitted its prerequisite read")
	}
	current = enabled
	claimedAt = current.UpdatedAt.Add(time.Minute)
	body = workerCredentialClaimBody(current.Version)
	after, secondClaim := claimResult(current, body, member.principal.UserID)
	apply(member, model.ProjectMemberRole, 1, http.MethodPost, path, body, after, &claimedAt)
	current = after
	after = current
	after.Status, after.Ready, after.StartedAt = model.TaskTodo, true, nil
	after.Version, after.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Microsecond)
	after.Properties = workerHTTPProperties(t, current.Properties, nil)
	apply(admin, model.ProjectAdmin, 2, http.MethodPost, path+"/release", map[string]any{"version": current.Version, "claimId": secondClaim.ClaimID, "stoppedConfirmed": true}, after, nil)
	current = after
	claimedAt = current.UpdatedAt.Add(time.Minute)
	body = workerCredentialClaimBody(current.Version)
	after, reclaimed := claimResult(current, body, member.principal.UserID)
	task = apply(member, model.ProjectMemberRole, 1, http.MethodPost, path, body, after, &claimedAt)
	current = after
	if claim := apiWorker(t, task.Properties); claim == nil || claim.UserID != member.principal.UserID || claim.ClaimID != body["claimId"] {
		t.Fatal("ordinary reclaim did not establish the assigned user's new claim")
	}
	withdraw := map[string]any{"version": current.Version, "claimId": reclaimed.ClaimID}
	other := bearer
	other.principal.UserID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	refusal(other, model.ProjectMemberRole, 2, http.MethodPost, path+"/withdraw", withdraw, http.StatusForbidden, "forbidden")
	after = current
	after.Status, after.AllowAgents, after.Ready, after.StartedAt, after.CompletedAt = model.TaskTodo, false, true, nil, nil
	after.Version, after.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Microsecond)
	after.Properties = workerHTTPProperties(t, current.Properties, nil)
	task = apply(admin, model.ProjectAdmin, 2, http.MethodPost, path+"/withdraw", withdraw, after, nil)
	if apiWorker(t, task.Properties) != nil || task.AllowAgents || task.Status != "todo" {
		t.Fatal("administrator withdrawal retained ownership")
	}
	for _, value := range []string{bearer.value, member.value, admin.value, outsider.value, "Owned execution", "Worker machine"} {
		if strings.Contains(logs.String(), value) {
			t.Fatal("worker authentication or execution content leaked to logs")
		}
	}
	if !reflect.DeepEqual(current.AssignedTo, after.AssignedTo) {
		t.Fatal("worker withdrawal changed the assignee")
	}
}
