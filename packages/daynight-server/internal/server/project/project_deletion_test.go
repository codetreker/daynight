package project

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

func TestProjectDeletionHTTP(t *testing.T) {
	for _, tc := range []struct {
		name, method, suffix, body, code string
		status                           int
	}{
		{"unauthenticated get", "GET", "", "", "unauthenticated", 401},
		{"unauthenticated preview", "GET", "/deletion-preview", "", "unauthenticated", 401},
		{"outsider get", "GET", "", "", "not_found", 404},
		{"outsider preview", "GET", "/deletion-preview", "", "not_found", 404},
		{"member preview", "GET", "/deletion-preview", "", "forbidden", 403},
		{"member delete", "DELETE", "", "", "forbidden", 403},
		{"active claims", "DELETE", "", "", "active_worker_claims", 409},
		{"deleted get", "GET", "", "", "not_found", 404},
		{"deleted preview", "GET", "/deletion-preview", "", "not_found", 404},
		{"deleted delete", "DELETE", "", "", "not_found", 404},
		{"delete query", "DELETE", "?version=1", "", "invalid_input", 400},
		{"delete body", "DELETE", "", "{}", "invalid_input", 400},
		{"preview limit", "GET", "/deletion-preview?limit=0", "", "invalid_input", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPHarness(t)
			fault := &model.Fault{Code: tc.code, Message: "request refused"}
			h.Projects.GetWithAccessFunc = func(_ context.Context, _ model.Principal, id string) (model.Project, model.ProjectAccess, error) {
				if id != h.Project.ID {
					t.Fatal(id)
				}
				return model.Project{}, model.ProjectAccess{}, fault
			}
			h.Projects.DeletionPreviewFunc = func(_ context.Context, _ model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error) {
				if id != h.Project.ID || page.Limit != 50 {
					t.Fatalf("preview id=%s page=%+v", id, page)
				}
				return projectservice.DeletionPreview{}, fault
			}
			h.Projects.DeleteFunc = func(_ context.Context, _ model.Principal, id string) (projectservice.DeletionReceipt, error) {
				if id != h.Project.ID {
					t.Fatal(id)
				}
				return projectservice.DeletionReceipt{}, fault
			}
			var cookies = []*http.Cookie{h.Cookie}
			if tc.status == 401 {
				cookies = []*http.Cookie{nil}
			}
			response := h.call(tc.method, "/api/v1/projects/"+h.Project.ID+tc.suffix, tc.body, cookies...)
			assertProjectError(t, response, tc.status, tc.code)
			calls := map[string]int{}
			if tc.status != 400 && tc.status != 401 {
				operation := "Delete"
				if tc.method == "GET" {
					operation = "GetWithAccess"
					if strings.HasPrefix(tc.suffix, "/deletion-preview") {
						operation = "DeletionPreview"
					}
				}
				calls[operation] = 1
			}
			h.assertCalls(calls)
		})
	}
	t.Run("confirmed receipt", func(t *testing.T) {
		h := newHTTPHarness(t)
		h.Projects.DeleteFunc = func(_ context.Context, _ model.Principal, id string) (projectservice.DeletionReceipt, error) {
			if id != h.Project.ID {
				t.Fatal(id)
			}
			return projectservice.DeletionReceipt{ProjectID: id, Deleted: true}, nil
		}
		response := h.call("DELETE", "/api/v1/projects/"+h.Project.ID, "")
		receipt := decodeResponse[api.ProjectDeletionReceipt](t, response, 200)
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 2 || receipt.ProjectID != h.Project.ID || !receipt.Deleted {
			t.Fatalf("receipt=%s err=%v", response.Body, err)
		}
		if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.Principal.UserID {
			t.Fatal(response.Header())
		}
		if strings.Contains(h.Logs.String(), "Shared project") || strings.Contains(h.Logs.String(), "example.com/shared") {
			t.Fatalf("private text in logs: %s", &h.Logs)
		}
		h.assertCalls(map[string]int{"Delete": 1})
	})
}

func deletionPreviewFixture(h *httpHarness) projectservice.DeletionPreview {
	return projectservice.DeletionPreview{ObservedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), Project: h.Project, OwnerTeam: model.TeamRef{ID: h.Project.Ownership.TeamID, Name: func() *string { s := "Owner"; return &s }()}, Summary: store.ProjectDeletionSummary{TaskCount: 2, UnfinishedTaskCount: 1, AttachmentCount: 1}, ActiveClaims: []projectservice.DeletionClaim{}}
}

func TestProjectDeletionHTTPPreviewProjection(t *testing.T) {
	h := newHTTPHarness(t)
	input := deletionPreviewFixture(h)
	input.ActiveClaims = []projectservice.DeletionClaim{{TaskID: "00000000-0000-4000-8000-000000000001", Title: "private running task", MachineName: "fixture", Platform: "linux", Phase: model.WorkerExecuting, Paused: true, Connectivity: "online"}}
	h.Projects.DeletionPreviewFunc = func(_ context.Context, _ model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error) {
		if id != h.Project.ID || page.Limit != 50 || page.Cursor != nil {
			t.Fatalf("id=%s page=%+v", id, page)
		}
		return input, nil
	}
	response := h.call("GET", "/api/v1/projects/"+h.Project.ID+"/deletion-preview", "")
	result := decodeResponse[api.ProjectDeletionPreview](t, response, 200)
	if !result.ObservedAt.Equal(input.ObservedAt) || result.Project.ID != h.Project.ID || result.Project.Name != h.Project.Name || result.Project.RepoURL != h.Project.RepoURL || result.Project.OwnerTeam.ID != input.OwnerTeam.ID || result.Project.OwnerTeam.Name == nil || *result.Project.OwnerTeam.Name != *input.OwnerTeam.Name || result.NextCursor != nil || len(result.ActiveClaims) != 1 {
		t.Fatalf("preview=%s", response.Body)
	}
	claim := result.ActiveClaims[0]
	if claim.TaskID != input.ActiveClaims[0].TaskID || claim.Title != "private running task" || claim.Worker.MachineName != "fixture" || claim.Worker.Platform != "linux" || claim.Worker.Phase != "executing" || !claim.Worker.Paused || claim.Worker.Connectivity != "online" {
		t.Fatalf("claim=%+v", claim)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.Principal.UserID || strings.Contains(h.Logs.String(), "private running task") || strings.Contains(h.Logs.String(), h.Project.RepoURL) {
		t.Fatalf("headers=%v logs=%s", response.Header(), &h.Logs)
	}
	h.assertCalls(map[string]int{"DeletionPreview": 1})
}

func TestProjectDeletionHTTPClaimPagesAndPhases(t *testing.T) {
	h := newHTTPHarness(t)
	phases := []model.WorkerPhase{model.WorkerPreparing, model.WorkerExecuting, model.WorkerPaused, model.WorkerWaiting}
	index := 0
	h.Projects.DeletionPreviewFunc = func(_ context.Context, _ model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error) {
		if id != h.Project.ID || page.Limit != 1 {
			t.Fatalf("id=%s page=%+v", id, page)
		}
		wantCursor := ""
		if index > 0 {
			wantCursor = fmt.Sprintf("cursor-%d", index)
		}
		if (page.Cursor == nil && wantCursor != "") || (page.Cursor != nil && *page.Cursor != wantCursor) {
			t.Fatalf("cursor=%v want=%q", page.Cursor, wantCursor)
		}
		out := deletionPreviewFixture(h)
		out.ActiveClaims = []projectservice.DeletionClaim{{TaskID: fmt.Sprintf("00000000-0000-4000-8000-%012d", index+1), Title: strings.Repeat("<", 256), MachineName: "offline", Platform: "linux", Phase: phases[index], Paused: index == 2, Connectivity: "offline"}}
		if index < len(phases)-1 {
			cursor := fmt.Sprintf("cursor-%d", index+1)
			out.NextCursor = &cursor
		}
		return out, nil
	}
	path := "/api/v1/projects/" + h.Project.ID + "/deletion-preview?limit=1"
	for i, phase := range phases {
		index = i
		response := h.call("GET", path, "")
		page := decodeResponse[api.ProjectDeletionPreview](t, response, 200)
		want := fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
		if len(page.ActiveClaims) != 1 || page.ActiveClaims[0].TaskID != want || page.ActiveClaims[0].Worker.Phase != string(phase) || page.ActiveClaims[0].Worker.Connectivity != "offline" || page.ActiveClaims[0].Title != strings.Repeat("<", 256) || page.ActiveClaims[0].Worker.Paused != (i == 2) || (page.NextCursor != nil) != (i < len(phases)-1) {
			t.Fatalf("page=%s", response.Body)
		}
		if page.NextCursor != nil {
			path = "/api/v1/projects/" + h.Project.ID + "/deletion-preview?limit=1&cursor=" + *page.NextCursor
		}
	}
	h.assertCalls(map[string]int{"DeletionPreview": 4})
}

func TestProjectDeletionHTTPPreviewPageCount(t *testing.T) {
	h := newHTTPHarness(t)
	first := projectservice.DeletionClaim{TaskID: "00000000-0000-4000-8000-000000000001", Title: strings.Repeat("<", 256), MachineName: "fixture", Platform: "linux", Phase: model.WorkerWaiting, Connectivity: "unknown"}
	second := first
	second.TaskID = "00000000-0000-4000-8000-000000000002"
	cursor := "next-page"
	h.Projects.DeletionPreviewFunc = func(_ context.Context, _ model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error) {
		if id != h.Project.ID {
			t.Fatal(id)
		}
		out := deletionPreviewFixture(h)
		switch {
		case page.Limit == 100 && page.Cursor == nil:
			out.ActiveClaims = []projectservice.DeletionClaim{first, second}
		case page.Limit == 1 && page.Cursor == nil:
			out.ActiveClaims = []projectservice.DeletionClaim{first}
			out.NextCursor = &cursor
		case page.Limit == 1 && page.Cursor != nil && *page.Cursor == cursor:
			out.ActiveClaims = []projectservice.DeletionClaim{second}
		default:
			t.Fatalf("unexpected page %+v", page)
		}
		return out, nil
	}
	base := "/api/v1/projects/" + h.Project.ID + "/deletion-preview"
	full := decodeResponse[api.ProjectDeletionPreview](t, h.call("GET", base+"?limit=100", ""), 200)
	page := decodeResponse[api.ProjectDeletionPreview](t, h.call("GET", base+"?limit=1", ""), 200)
	next := decodeResponse[api.ProjectDeletionPreview](t, h.call("GET", base+"?limit=1&cursor="+*page.NextCursor, ""), 200)
	if len(full.ActiveClaims) != 2 || full.NextCursor != nil || len(page.ActiveClaims) != 1 || len(next.ActiveClaims) != 1 || next.NextCursor != nil || !reflect.DeepEqual(full.ActiveClaims, append(page.ActiveClaims, next.ActiveClaims...)) {
		t.Fatalf("full=%+v page=%+v next=%+v", full, page, next)
	}
	if full.Project.ID != h.Project.ID || full.Project.OwnerTeam.ID != h.Project.Ownership.TeamID || full.Summary.TaskCount != 2 || full.Summary.UnfinishedTaskCount != 1 || full.Summary.AttachmentCount != 1 {
		t.Fatalf("preview %+v", full)
	}
	h.assertCalls(map[string]int{"DeletionPreview": 3})
}
