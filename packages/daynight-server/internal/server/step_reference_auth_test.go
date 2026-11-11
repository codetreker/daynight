package server

import (
	"bytes"
	"io"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestStepsHTTPEditPreservesReferencedAttachment(t *testing.T) {
	f, handler, task := stepsHTTPFixture(t, io.Discard)
	path := taskPath(task) + "/steps"
	file := attachmentFilePath(task, "plans/evidence.bin")
	content := []byte{0, 0xff, 0x80, '\n', 'x'}
	metadata := f.referencedAttachment("plans/evidence.bin", "application/octet-stream", content)
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: 1}
	at := f.observed
	original := model.TaskStep{ID: "abcdef01", Title: "Evidence", Description: "[Evidence](plans/evidence.bin)", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: []model.TaskStep{}, Operation: "add", Candidate: original, Observed: at})
	added := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"version": task.Version, "id": "abcdef01", "title": "Evidence", "description": "[Evidence](plans/evidence.bin)"})), http.StatusCreated)
	if len(added.Steps) != 1 {
		t.Fatalf("initial Step: %+v", added)
	}
	header.Version = 2
	at = at.Add(time.Minute)
	candidate := original
	candidate.Title = "Updated evidence"
	candidate.Description = ""
	candidate.UpdatedAt = at
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: []model.TaskStep{original}, Operation: "change", Candidate: candidate, Observed: at})
	changed := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodPatch, path+"/abcdef01", jsonBody(t, map[string]any{"version": added.Version, "title": "Updated evidence", "description": ""})), http.StatusOK)
	if changed.Version != added.Version+1 || len(changed.Steps) != 1 || changed.Steps[0].ID != original.ID || changed.Steps[0].Title != "Updated evidence" || changed.Steps[0].Description != "" || changed.Steps[0].Status != original.Status || changed.Steps[0].CreatedAt != original.CreatedAt {
		t.Fatalf("edited Step: %+v", changed)
	}
	f.expectAttachmentRead(metadata)
	response := attachmentRequest(handler, http.MethodGet, file, "", nil)
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), content) {
		t.Fatalf("editing changed attachment bytes: %d %x", response.Code, response.Body.Bytes())
	}
	f.expectAttachmentRead(metadata)
	page := decodeResponse[api.AttachmentPage](t, projectRequest(handler, http.MethodGet, taskPath(task)+"/attachments", ""), http.StatusOK)
	want := api.Attachment{Path: metadata.Path, ContentType: metadata.ContentType, SizeBytes: metadata.SizeBytes, CreatedAt: metadata.CreatedAt, UpdatedAt: metadata.UpdatedAt}
	if len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], want) {
		t.Fatalf("editing changed attachment metadata: %+v", page)
	}
}

func TestStepsHTTPRevokedMemberCannotRead(t *testing.T) {
	f, _, task := stepsHTTPFixture(t, io.Discard)
	admin := defaultHTTPPrincipal()
	admin.Kind = model.SessionCredential
	member := model.Principal{UserID: "b6666666-6666-4666-8666-666666666666", CredentialID: "c7777777-7777-4777-8777-777777777777", Kind: model.SessionCredential}
	path := taskPath(task) + "/steps"
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: 1}
	at := f.observed
	step := model.TaskStep{ID: "abcdef01", Title: "Secret Step", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.principal = admin
	f.role = model.ProjectAdmin
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: []model.TaskStep{}, Operation: "add", Candidate: step, Observed: at})
	created := decodeResponse[api.StepsResource](t, f.authenticatedRequest(admin, "POST", path, `{"version":1,"id":"abcdef01","title":"Secret Step"}`, configuredTestConfig().Server.PublicOrigin, 201, ""), 201)
	header.Version = 2
	f.principal = member
	f.role = model.ProjectMemberRole
	f.expectStepsRead(header, []model.TaskStep{step})
	before := decodeResponse[api.StepsResource](t, f.authenticatedRequest(member, "GET", path, "", "", 200, ""), 200)
	if !reflect.DeepEqual(before, created) {
		t.Fatal("member could not read granted Step")
	}
	for _, suffix := range []string{"", "/abcdef01"} {
		f.expectStepAccessError(false)
		f.authenticatedRequest(member, "GET", path+suffix, "", "", 404, "not_found")
	}
	f.principal = admin
	f.role = model.ProjectAdmin
	f.expectStepsRead(header, []model.TaskStep{step})
	after := decodeResponse[api.StepsResource](t, f.authenticatedRequest(admin, "GET", path, "", "", 200, ""), 200)
	if !reflect.DeepEqual(after, created) {
		t.Fatal("denied member read changed owner's Steps")
	}
}
