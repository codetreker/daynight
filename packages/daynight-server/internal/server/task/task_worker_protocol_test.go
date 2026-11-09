package task_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func extendedWorkerTestHandler(handler *resourceTestHandler) {
	original := handler.Handler
	handler.Handler = http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		request.Header.Set("Daynight-Worker-Protocol", "2")
		original.ServeHTTP(w, request)
	})
}

func protocolRequest(handler http.Handler, method, path, body, protocol string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	if protocol != "" {
		request.Header.Set("Daynight-Worker-Protocol", protocol)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertWorkerProtocolContext(t *testing.T, ctx context.Context, extended bool) {
	t.Helper()
	sentinel := &model.WorkerClaim{Agent: model.AgentClaude, AgentControlMode: model.AgentControlModeWeb}
	legacy := taskcore.RequireCompatibleWorker(ctx, sentinel) != nil
	if legacy == extended {
		t.Fatalf("worker protocol context: legacy=%t extended=%t", legacy, extended)
	}
}

func TestWorkerProtocolLegacyAndExtendedResponses(t *testing.T) {
	for _, protocol := range []string{"", "1", "unexpected", "2"} {
		t.Run("read/"+protocol, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			returned, worker := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeHerdr, model.WorkerActive)
			h.Tasks.ObserveFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.TaskObservation, error) {
				assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
				return taskservice.TaskObservation{Task: returned, Epoch: testEpoch}, nil
			}
			response := protocolRequest(h, http.MethodGet, strings.TrimSuffix(workerHTTPPath(), "/worker-claim"), "", protocol)
			got := decodeResponse[api.Task](t, response, http.StatusOK)
			if got.ID != returned.ID || got.Version != returned.Version || apiWorker(t, got.Properties) == nil || apiWorker(t, got.Properties).ClaimID != worker.ClaimID {
				t.Fatal("legacy Herdr projection lost identity")
			}
			if strings.Contains(response.Body.String(), "agentControlMode") != (protocol == "2") {
				t.Fatalf("worker schema negotiation: %s", response.Body)
			}
			if response.Header().Get("Daynight-Task-Epoch") != testEpoch {
				t.Fatal("read lost observed epoch")
			}
		})
	}
	t.Run("legacy claim", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		returned, _ := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeHerdr, model.WorkerActive)
		h.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ClaimWorker) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			assertWorkerProtocolContext(t, ctx, false)
			if input.AgentControlMode != model.AgentControlModeHerdr {
				t.Fatal("legacy claim lost default mode")
			}
			return returned, nil
		}
		response := protocolRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, workerClaimBody(returned.Version-1)), "")
		decodeResponse[api.Task](t, response, http.StatusOK)
		if strings.Contains(response.Body.String(), "agentControlMode") {
			t.Fatal("legacy claim received extended schema")
		}
	})
}

func TestWorkerProtocolLegacyReadsRemainAvailableWithoutControllingExtendedClaims(t *testing.T) {
	for _, configuration := range []struct {
		provider model.WorkerAgent
		mode     model.WorkerAgentControlMode
	}{{model.AgentCodex, model.AgentControlModeWeb}, {model.AgentClaude, model.AgentControlModeWeb}, {model.AgentClaude, model.AgentControlModeHerdr}} {
		t.Run(string(configuration.provider)+"-"+string(configuration.mode), func(t *testing.T) {
			returned, worker := workerHTTPTask(t, configuration.provider, configuration.mode, model.WorkerActive)
			for _, protocol := range []string{"", "2"} {
				t.Run("read/"+protocol, func(t *testing.T) {
					h := newHTTPFixture(t, io.Discard)
					h.Tasks.ObserveFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.TaskObservation, error) {
						assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
						return taskservice.TaskObservation{Task: returned, Epoch: testEpoch}, nil
					}
					got := decodeResponse[api.Task](t, protocolRequest(h, http.MethodGet, strings.TrimSuffix(workerHTTPPath(), "/worker-claim"), "", protocol), http.StatusOK)
					if got.Status != "in_progress" || got.Ready || got.Version != returned.Version || (apiWorker(t, got.Properties) != nil) != (protocol == "2") {
						t.Fatal("unsupported claim projection changed lifecycle or leaked worker")
					}
				})
			}
			t.Run("ordinary list", func(t *testing.T) {
				h := newHTTPFixture(t, io.Discard)
				h.Tasks.ListFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
					if projectID != testProjectID || !reflect.DeepEqual(p, testPrincipal()) || input.WorkerID != nil {
						t.Fatalf("ordinary list input: %+v", input)
					}
					return taskservice.TaskPage{Items: []model.Task{returned}}, nil
				}
				page := decodeResponse[api.TaskPage](t, protocolRequest(h, http.MethodGet, taskCollection(testProjectID), "", ""), http.StatusOK)
				if len(page.Items) != 1 || page.Items[0].ID != returned.ID || apiWorker(t, page.Items[0].Properties) != nil {
					t.Fatal("ordinary legacy list hid Task or exposed incompatible claim")
				}
			})
			t.Run("inventory refusal", func(t *testing.T) {
				h := newHTTPFixture(t, io.Discard)
				h.Tasks.ListFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
					if projectID != testProjectID || input.WorkerID == nil || *input.WorkerID != worker.WorkerID {
						t.Fatalf("inventory input: %+v", input)
					}
					return taskservice.TaskPage{Items: []model.Task{returned}}, nil
				}
				assertProjectError(t, protocolRequest(h, http.MethodGet, taskCollection(testProjectID)+"?workerId="+worker.WorkerID, "", ""), http.StatusConflict, "invalid_transition")
			})
			for _, operation := range []string{"claim", "update", "release", "withdraw", "resume", "complete", "metadata", "delete"} {
				for _, protocol := range []string{"", "2"} {
					t.Run(operation+"/"+protocol, func(t *testing.T) {
						h := newHTTPFixture(t, io.Discard)
						path, method, body := workerHTTPPath(), http.MethodPost, workerClaimBody(returned.Version)
						body["agent"], body["agentControlMode"] = string(configuration.provider), string(configuration.mode)
						check := func(ctx context.Context, p model.Principal, projectID, taskID string) error {
							assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
							assertWorkerProtocolContext(t, ctx, protocol == "2")
							if protocol == "" {
								return &model.Fault{Code: "invalid_transition", Message: "Execution requires extended protocol"}
							}
							return nil
						}
						switch operation {
						case "claim":
							h.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ClaimWorker) (model.Task, error) {
								if input.Version != returned.Version || !reflect.DeepEqual(input.WorkerDescriptor, workerHTTPDescriptor(body)) {
									t.Fatalf("claim input: %+v", input)
								}
								return returned, check(ctx, p, projectID, taskID)
							}
						case "update":
							method = http.MethodPatch
							body = map[string]any{"version": returned.Version, "claimId": worker.ClaimID, "phase": "waiting"}
							h.Tasks.UpdateWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.UpdateWorker) (model.Task, error) {
								if input.Version != returned.Version || input.ClaimID != worker.ClaimID || input.Phase == nil || *input.Phase != model.WorkerWaiting {
									t.Fatalf("update input: %+v", input)
								}
								return returned, check(ctx, p, projectID, taskID)
							}
						case "release":
							path += "/release"
							body = map[string]any{"version": returned.Version, "claimId": worker.ClaimID, "stoppedConfirmed": true}
							h.Tasks.ReleaseWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ReleaseWorker) (model.Task, error) {
								if input.Version != returned.Version || input.ClaimID != worker.ClaimID || !input.StoppedConfirmed {
									t.Fatalf("release input: %+v", input)
								}
								return returned, check(ctx, p, projectID, taskID)
							}
						case "withdraw":
							path += "/withdraw"
							body = map[string]any{"version": returned.Version, "claimId": worker.ClaimID}
							h.Tasks.WithdrawWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.WithdrawWorker) (model.Task, error) {
								if input.Version != returned.Version || input.ClaimID != worker.ClaimID {
									t.Fatalf("withdraw input: %+v", input)
								}
								return returned, check(ctx, p, projectID, taskID)
							}
						case "resume":
							path += "/resume"
							body["previousClaimId"] = worker.ClaimID
							h.Tasks.ResumeWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ResumeWorker) (model.Task, error) {
								if input.Version != returned.Version || input.PreviousClaimID != worker.ClaimID || !reflect.DeepEqual(input.WorkerDescriptor, workerHTTPDescriptor(body)) {
									t.Fatalf("resume input: %+v", input)
								}
								return returned, check(ctx, p, projectID, taskID)
							}
						case "complete":
							method = http.MethodPut
							path = strings.TrimSuffix(path, "/worker-claim") + "/status"
							body = map[string]any{"version": returned.Version, "claimId": worker.ClaimID, "status": "done"}
							h.Tasks.SetStatusFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.SetTaskStatus) (model.Task, error) {
								if input.Version != returned.Version || input.ClaimID == nil || *input.ClaimID != worker.ClaimID || input.Status != model.TaskDone {
									t.Fatalf("completion input: %+v", input)
								}
								return returned, check(ctx, p, projectID, taskID)
							}
						case "metadata":
							method = http.MethodPatch
							path = strings.TrimSuffix(path, "/worker-claim")
							body = map[string]any{"version": returned.Version, "title": "Unconfirmed"}
							h.Tasks.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.UpdateTask) (model.Task, error) {
								if input.Version != returned.Version || input.Title == nil || *input.Title != "Unconfirmed" {
									t.Fatalf("metadata input: %+v", input)
								}
								return returned, check(ctx, p, projectID, taskID)
							}
						case "delete":
							method = http.MethodDelete
							path = strings.TrimSuffix(path, "/worker-claim")
							body = map[string]any{"version": returned.Version}
							h.Tasks.DeleteFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.DeleteTask) error {
								if input.Version != returned.Version || input.RemoveDepends {
									t.Fatalf("delete input: %+v", input)
								}
								return check(ctx, p, projectID, taskID)
							}
						}
						response := protocolRequest(h, method, path, jsonBody(t, body), protocol)
						if protocol == "" {
							assertProjectError(t, response, http.StatusConflict, "invalid_transition")
						} else if operation == "delete" {
							if response.Code != http.StatusNoContent {
								t.Fatalf("extended delete status=%d body=%s", response.Code, response.Body)
							}
						} else {
							got := decodeResponse[api.Task](t, response, http.StatusOK)
							if got.Version != returned.Version || apiWorker(t, got.Properties) == nil {
								t.Fatal("extended operation lost service projection")
							}
						}
					})
				}
			}
		})
	}
}

func TestWorkerProtocolLegacyCandidatesAdvanceAcrossUnsupportedPages(t *testing.T) {
	unsupported := func(t *testing.T, index int) model.Task {
		task, _ := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeWeb, model.WorkerReleased)
		task.ID = fmt.Sprintf("b2222222-b222-4222-8222-b2222222222%d", index)
		return task
	}
	first, second := testTask("first compatible"), testTask("second compatible")
	first.ID = "b2222222-b222-4222-8222-b22222222227"
	second.ID = "b2222222-b222-4222-8222-b22222222228"
	cursor := func(value string) *string { return &value }
	for _, limit := range []int{1, 3} {
		t.Run(fmt.Sprint(limit), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			pages := []taskservice.TaskPage{{Items: []model.Task{unsupported(t, 1)}, NextCursor: cursor("scan-a")}, {Items: []model.Task{unsupported(t, 2)}, NextCursor: cursor("scan-b")}, {Items: []model.Task{first}, NextCursor: cursor("scan-c")}, {Items: []model.Task{unsupported(t, 3)}, NextCursor: cursor("scan-d")}, {Items: []model.Task{second}}}
			inputs := []*string{nil, cursor("scan-a"), cursor("scan-b"), cursor("scan-c"), cursor("scan-d")}
			if limit == 3 {
				pages = []taskservice.TaskPage{{Items: []model.Task{unsupported(t, 1), unsupported(t, 2), unsupported(t, 3)}, NextCursor: cursor("scan-a")}, {Items: []model.Task{first, unsupported(t, 4), second}}}
				inputs = []*string{nil, cursor("scan-a")}
			}
			calls := 0
			h.Tasks.ExpectCalls("List", len(pages))
			h.Tasks.ListFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
				if projectID != testProjectID || !reflect.DeepEqual(p, testPrincipal()) || input.Limit != limit || input.Ready == nil || !*input.Ready || input.AllowAgents == nil || !*input.AllowAgents || input.CompatiblePlatform == nil || *input.CompatiblePlatform != model.PlatformLinux || !reflect.DeepEqual(input.Cursor, inputs[calls]) {
					t.Fatalf("candidate page input call=%d: %+v", calls, input)
				}
				page := pages[calls]
				calls++
				return page, nil
			}
			path := taskCollection(testProjectID) + fmt.Sprintf("?ready=true&allowAgents=true&compatiblePlatform=linux&limit=%d", limit)
			page := decodeResponse[api.TaskPage](t, protocolRequest(h, http.MethodGet, path, "", ""), http.StatusOK)
			ids := make([]string, 0, 2)
			for _, item := range page.Items {
				ids = append(ids, item.ID)
			}
			if page.NextCursor != nil {
				if len(page.Items) == 0 {
					t.Fatal("filtered page exposed empty continuation")
				}
				next := decodeResponse[api.TaskPage](t, protocolRequest(h, http.MethodGet, path+"&cursor="+*page.NextCursor, "", ""), http.StatusOK)
				for _, item := range next.Items {
					ids = append(ids, item.ID)
				}
				if next.NextCursor != nil {
					t.Fatal("last filtered page invented continuation")
				}
			}
			if !reflect.DeepEqual(ids, []string{first.ID, second.ID}) {
				t.Fatalf("compatible candidates = %v", ids)
			}
		})
	}
	t.Run("unsupported only", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		calls := 0
		h.Tasks.ExpectCalls("List", 3)
		h.Tasks.ListFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
			if input.Limit != 1 || input.Cursor == nil && calls != 0 || input.Cursor != nil && *input.Cursor != fmt.Sprint(calls) {
				t.Fatalf("exhausted page cursor: %+v", input)
			}
			calls++
			var next *string
			if calls < 3 {
				next = cursor(fmt.Sprint(calls))
			}
			return taskservice.TaskPage{Items: []model.Task{unsupported(t, calls)}, NextCursor: next}, nil
		}
		page := decodeResponse[api.TaskPage](t, protocolRequest(h, http.MethodGet, taskCollection(testProjectID)+"?ready=true&allowAgents=true&compatiblePlatform=linux&limit=1", "", ""), http.StatusOK)
		if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
			t.Fatal("unsupported-only discovery did not exhaust")
		}
	})
	for _, protocol := range []string{"", "2"} {
		t.Run("ordinary/"+protocol, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			items := []model.Task{unsupported(t, 1), unsupported(t, 2), unsupported(t, 3), first, unsupported(t, 4), second}
			h.Tasks.ListFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
				return taskservice.TaskPage{Items: items}, nil
			}
			path := taskCollection(testProjectID) + "?ready=true&allowAgents=true"
			if protocol == "2" {
				path += "&compatiblePlatform=linux"
			}
			page := decodeResponse[api.TaskPage](t, protocolRequest(h, http.MethodGet, path, "", protocol), http.StatusOK)
			if len(page.Items) != len(items) {
				t.Fatal("ordinary or extended list hid service tasks")
			}
		})
	}
	t.Run("worker decoding failure", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		bad := testTask("corrupt claim")
		bad.Properties["worker"] = []byte(`{"agent":3}`)
		h.Tasks.ListFunc = func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error) {
			return taskservice.TaskPage{Items: []model.Task{bad}}, nil
		}
		assertProjectError(t, protocolRequest(h, http.MethodGet, taskCollection(testProjectID)+"?ready=true&allowAgents=true&compatiblePlatform=linux", "", ""), http.StatusInternalServerError, "internal_error")
	})
}
