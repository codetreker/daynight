package project

import (
	"context"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

func TestTransferHTTPContracts(t *testing.T) {
	h := newHTTPHarness(t)
	target := "55555555-5555-4555-8555-555555555555"
	source := model.TeamRef{ID: h.Project.Ownership.TeamID, Kind: "personal"}
	privateName := "Destination private"
	destination := model.TeamRef{ID: target, Kind: "shared", Name: &privateName}
	role := model.ProjectAdmin
	h.Projects.TransferPreviewFunc = func(ctx context.Context, p model.Principal, id, targetID string) (coreproject.TransferPreview, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		if targetID != target {
			t.Fatalf("preview target %q", targetID)
		}
		return coreproject.TransferPreview{SourceTeam: source, TargetTeam: destination, Ownership: h.Project.Ownership, TargetTeamVersion: 9007199254740993, ActorRole: &role}, nil
	}
	path := "/api/v1/projects/" + h.Project.ID
	previewResponse := h.call("POST", path+"/transfer-preview", `{"targetTeamId":"`+target+`"}`, h.Cookie)
	preview := decodeResponse[api.TransferPreview](t, previewResponse, 200)
	if preview.TargetTeam.ID != target || preview.TargetTeam.Name == nil || *preview.TargetTeam.Name != privateName || preview.TargetTeam.Version != 9007199254740993 || preview.SourceTeam.ID != source.ID || preview.Ownership.Version != h.Project.Ownership.Version || preview.ActorRole == nil || *preview.ActorRole != "admin" {
		t.Fatalf("preview: %s", previewResponse.Body)
	}
	if previewResponse.Header().Get("Cache-Control") != "no-store" || previewResponse.Header().Get("Daynight-User-ID") != h.Principal.UserID || !strings.Contains(previewResponse.Body.String(), `"version":9007199254740993`) {
		t.Fatal("preview headers or precision", previewResponse.Body, previewResponse.Header())
	}
	input := coreproject.TransferInput{Ownership: model.ProjectOwnership{TeamID: h.Project.Ownership.TeamID, Version: h.Project.Ownership.Version}, TargetTeam: coreproject.TeamVersion{ID: target, Version: 9007199254740993}, ExpectedUserID: h.Principal.UserID}
	body := `{"ownership":{"teamId":"` + input.Ownership.TeamID + `","version":1},"targetTeam":{"id":"` + target + `","version":9007199254740993},"expectedUserId":"` + h.Principal.UserID + `"}`
	other := "66666666-6666-4666-8666-666666666666"
	for _, test := range []struct {
		body  string
		input coreproject.TransferInput
		code  string
	}{
		{strings.Replace(body, h.Principal.UserID, other, 1), coreproject.TransferInput{Ownership: input.Ownership, TargetTeam: input.TargetTeam, ExpectedUserID: other}, "identity_mismatch"},
		{strings.Replace(body, `"version":9007199254740993`, `"version":1`, 1), coreproject.TransferInput{Ownership: input.Ownership, TargetTeam: coreproject.TeamVersion{ID: target, Version: 1}, ExpectedUserID: h.Principal.UserID}, "version_conflict"},
	} {
		h.Projects.TransferFunc = func(ctx context.Context, p model.Principal, id string, in coreproject.TransferInput) (coreproject.TransferReceipt, error) {
			assertProjectInvocation(t, h, ctx, p, id)
			if !reflect.DeepEqual(in, test.input) {
				t.Fatalf("transfer input %+v want %+v", in, test.input)
			}
			return coreproject.TransferReceipt{}, &model.Fault{Code: test.code, Message: "Transfer refused."}
		}
		assertProjectError(t, h.call("POST", path+"/transfer", test.body, h.Cookie), 409, test.code)
	}
	h.Projects.TransferFunc = func(ctx context.Context, p model.Principal, id string, in coreproject.TransferInput) (coreproject.TransferReceipt, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		if !reflect.DeepEqual(in, input) {
			t.Fatalf("transfer input %+v want %+v", in, input)
		}
		return coreproject.TransferReceipt{ProjectID: id, Changed: true, SourceTeam: source, OwnerTeam: destination, Ownership: model.ProjectOwnership{TeamID: target, Version: 2}}, nil
	}
	response := h.call("POST", path+"/transfer", body, h.Cookie)
	receipt := decodeResponse[api.TransferReceipt](t, response, 200)
	if !receipt.Changed || receipt.ProjectID != h.Project.ID || receipt.SourceTeam.ID != source.ID || receipt.OwnerTeam.ID != target || receipt.Ownership.TeamID != target || receipt.Ownership.Version != 2 || receipt.ActorAccess != nil {
		t.Fatalf("receipt: %s", response.Body)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.Principal.UserID || !strings.Contains(response.Body.String(), `"actorAccess":null`) {
		t.Fatal("receipt headers or lost-access result", response.Body, response.Header())
	}
	h.Projects.GetWithAccessFunc = func(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		return model.Project{}, model.ProjectAccess{}, coreproject.ProjectNotFound(model.ErrNotFound)
	}
	assertProjectError(t, h.call("GET", path, "", h.Cookie), 404, "not_found")
	if strings.Contains(h.Logs.String(), privateName) || !strings.Contains(h.Logs.String(), `"component":"project_transfer"`) || !strings.Contains(h.Logs.String(), `"outcome":"success"`) {
		t.Fatalf("transfer logs: %s", &h.Logs)
	}
	h.assertCalls(map[string]int{"TransferPreview": 1, "Transfer": 3, "GetWithAccess": 1})
}

func TestTransferHTTPStrictInput(t *testing.T) {
	h := newHTTPHarness(t)
	h.Project.Ownership.TeamID = "abcdefab-cdef-4abc-8def-abcdefabcdef"
	path := "/api/v1/projects/" + h.Project.ID
	team := h.Project.Ownership.TeamID
	valid := `{"ownership":{"teamId":"` + team + `","version":1},"targetTeam":{"id":"` + team + `","version":1},"expectedUserId":"` + h.Principal.UserID + `"}`
	for _, body := range []string{`{}`, `null`, `{"targetTeamId":null}`, `{"targetTeamId":"` + team + `","extra":1}`, `{"targetTeamId":"` + team + `","targetTeamId":"` + team + `"}`} {
		assertProjectError(t, h.call("POST", path+"/transfer-preview", body, h.Cookie), 400, "invalid_input")
	}
	for _, body := range []string{`{}`, `{"ownership":null}`, strings.Replace(valid, `"version":1`, `"version":0`, 1), strings.Replace(valid, `"version":1`, `"version":1.0`, 1), strings.Replace(valid, `"version":1`, `"version":9223372036854775808`, 1), strings.Replace(valid, `"teamId":`, `"teamId":"`+team+`","teamId":`, 1), strings.Replace(valid, `"teamId":`, `"extra":true,"teamId":`, 1), strings.Replace(valid, `"expectedUserId"`, `"unexpected"`, 1)} {
		assertProjectError(t, h.call("POST", path+"/transfer", body, h.Cookie), 400, "invalid_input")
	}
	assertProjectError(t, h.call("POST", path+"/transfer?unexpected=1", valid, h.Cookie), 400, "invalid_input")
	for _, endpoint := range []string{"/transfer", "/transfer-preview"} {
		response := h.call("GET", path+endpoint, "", h.Cookie)
		assertProjectError(t, response, 405, "method_not_allowed")
		if response.Header().Get("Allow") != "POST" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(response.Header())
		}
	}
	h.assertCalls(map[string]int{})
	for _, target := range []string{strings.ToUpper(team), "https://example.test/teams/" + team} {
		h.Projects.TransferPreviewFunc = func(ctx context.Context, p model.Principal, id, got string) (coreproject.TransferPreview, error) {
			assertProjectInvocation(t, h, ctx, p, id)
			if got != target {
				t.Fatalf("target %q want %q", got, target)
			}
			return coreproject.TransferPreview{}, &model.Fault{Code: "invalid_input", Message: "Invalid Team ID."}
		}
		assertProjectError(t, h.call("POST", path+"/transfer-preview", `{"targetTeamId":"`+target+`"}`, h.Cookie), 400, "invalid_input")
	}
	h.Projects.TransferFunc = func(ctx context.Context, p model.Principal, id string, in coreproject.TransferInput) (coreproject.TransferReceipt, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		want := coreproject.TransferInput{Ownership: model.ProjectOwnership{TeamID: strings.ToUpper(team), Version: 1}, TargetTeam: coreproject.TeamVersion{ID: team, Version: 1}, ExpectedUserID: h.Principal.UserID}
		if !reflect.DeepEqual(in, want) {
			t.Fatalf("uppercase input %+v", in)
		}
		return coreproject.TransferReceipt{}, &model.Fault{Code: "invalid_input", Message: "Invalid owner Team ID."}
	}
	assertProjectError(t, h.call("POST", path+"/transfer", strings.Replace(valid, team, strings.ToUpper(team), 1), h.Cookie), 400, "invalid_input")
	access := routeAccess(h)
	h.Projects.TransferFunc = func(ctx context.Context, p model.Principal, id string, in coreproject.TransferInput) (coreproject.TransferReceipt, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		want := coreproject.TransferInput{Ownership: model.ProjectOwnership{TeamID: team, Version: 1}, TargetTeam: coreproject.TeamVersion{ID: team, Version: 1}, ExpectedUserID: h.Principal.UserID}
		if !reflect.DeepEqual(in, want) {
			t.Fatalf("no-op input %+v", in)
		}
		return coreproject.TransferReceipt{ProjectID: id, SourceTeam: access.OwnerTeam, OwnerTeam: access.OwnerTeam, Ownership: want.Ownership, ActorAccess: &access}, nil
	}
	receipt := decodeResponse[api.TransferReceipt](t, h.call("POST", path+"/transfer", valid, h.Cookie), 200)
	if receipt.Changed || receipt.Ownership.Version != 1 || receipt.ActorAccess == nil {
		t.Fatalf("verified no-op: %#v", receipt)
	}
	h.assertCalls(map[string]int{"TransferPreview": 2, "Transfer": 2})
}

func TestTransferHTTPLostResponseAndSubsequent404(t *testing.T) {
	h := newHTTPHarness(t)
	target := "55555555-5555-4555-8555-555555555555"
	h.Projects.TransferFunc = func(ctx context.Context, p model.Principal, id string, in coreproject.TransferInput) (coreproject.TransferReceipt, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		want := coreproject.TransferInput{Ownership: model.ProjectOwnership{TeamID: h.Project.Ownership.TeamID, Version: 1}, TargetTeam: coreproject.TeamVersion{ID: target, Version: 1}, ExpectedUserID: h.Principal.UserID}
		if !reflect.DeepEqual(in, want) {
			t.Fatalf("transfer input %+v", in)
		}
		return coreproject.TransferReceipt{ProjectID: id, Changed: true, Ownership: model.ProjectOwnership{TeamID: target, Version: 2}, OwnerTeam: model.TeamRef{ID: target}}, nil
	}
	base := "/api/v1/projects/" + h.Project.ID
	body := `{"ownership":{"teamId":"` + h.Project.Ownership.TeamID + `","version":1},"targetTeam":{"id":"` + target + `","version":1},"expectedUserId":"` + h.Principal.UserID + `"}`
	before := h.Logs.Len()
	w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
	h.Handler.ServeHTTP(w, h.request("POST", base+"/transfer", body))
	if w.calls != 1 || w.Body.Len() != 0 {
		t.Fatalf("failed response was replayed: %d %q", w.calls, w.Body.String())
	}
	logs := h.Logs.String()[before:]
	if strings.Count(logs, `"component":"project_transfer"`) != 1 || !strings.Contains(logs, `"phase":"response"`) || !strings.Contains(logs, `"outcome":"unknown"`) || !strings.Contains(logs, `"error_code":"write_outcome_unknown"`) {
		t.Fatalf("response loss classification: %s", logs)
	}
	h.Projects.GetWithAccessFunc = func(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		return model.Project{}, model.ProjectAccess{}, coreproject.ProjectNotFound(model.ErrNotFound)
	}
	assertProjectError(t, h.call("GET", base, "", h.Cookie), 404, "not_found")
	h.assertCalls(map[string]int{"Transfer": 1, "GetWithAccess": 1})
}
