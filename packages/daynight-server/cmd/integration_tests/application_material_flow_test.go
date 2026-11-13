//go:build integration

package main

import (
	"bytes"
	"mime"
	"net/http"
	"reflect"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func serverAPIApplicationMaterialNormalFlow(t *testing.T, f *fixture) {
	t.Helper()
	application := newApplicationFixture(t, f)
	project := createProject(t, application, "Application material")
	goal := createTask(t, application, project, "Application Goal", map[string]any{"type": "goal"})
	child := createTask(t, application, project, "Application child", map[string]any{
		"parentId": goal.ID, "status": "todo", "assignedTo": f.userID, "requiredPlatform": "linux",
	})
	child = requestJSON[api.Task](t, application, http.MethodPatch, taskPath(child), map[string]any{"version": child.Version, "allowAgents": true}, http.StatusOK)
	if child.Type != "task" || child.ParentID == nil || *child.ParentID != goal.ID || child.AssignedTo == nil || *child.AssignedTo != f.userID || child.RequiredPlatform == nil || *child.RequiredPlatform != "linux" || !child.AllowAgents {
		t.Fatalf("application child identity or execution settings differ: %+v", child)
	}
	goalRead := requestJSON[api.Task](t, application, http.MethodGet, taskPath(goal), nil, http.StatusOK)
	if goalRead.ID != goal.ID || goalRead.ProjectID != project.ID || goalRead.Progress == nil || goalRead.Progress.Total != 1 || goalRead.Progress.Unfinished != 1 || goalRead.Progress.Done != 0 {
		t.Fatalf("application Goal progress differs: %+v", goalRead)
	}

	stepsPath := taskPath(child) + "/steps"
	created := requestJSON[api.StepsResource](t, application, http.MethodPost, stepsPath, map[string]any{
		"version": child.Version, "id": "a11ce001", "title": "Publish material", "description": "Prepare shared content",
	}, http.StatusCreated)
	completed := requestJSON[api.StepsResource](t, application, http.MethodPut, stepsPath+"/a11ce001/status", map[string]any{"version": created.Version, "status": "done"}, http.StatusOK)
	steps := requestJSON[api.StepsResource](t, application, http.MethodGet, stepsPath, nil, http.StatusOK)
	if created.Version != child.Version+1 || completed.Version != created.Version+1 || steps.ProjectID != project.ID || steps.TaskID != child.ID || steps.Version != completed.Version || len(steps.Steps) != 1 || steps.Steps[0].ID != "a11ce001" || steps.Steps[0].Title != "Publish material" || steps.Steps[0].Description != "Prepare shared content" || steps.Steps[0].Status != "done" || !reflect.DeepEqual(steps.Steps, completed.Steps) {
		t.Fatalf("application Step identity, version or content differs: %+v", steps)
	}

	threadPath := taskPath(child) + "/thread/messages"
	message := requestJSON[api.ThreadMessage](t, application, http.MethodPost, threadPath, map[string]any{"body": "Application material is ready"}, http.StatusCreated)
	reply := requestJSON[api.ThreadMessage](t, application, http.MethodPost, threadPath, map[string]any{"body": "Read the attached result", "replyTo": message.ID}, http.StatusCreated)
	thread := requestJSON[api.ThreadPage](t, application, http.MethodGet, threadPath+"?fromBeginning=true", nil, http.StatusOK)
	first := expectID(t, thread.Items, message.ID, func(item api.ThreadMessage) string { return item.ID })
	second := expectID(t, thread.Items, reply.ID, func(item api.ThreadMessage) string { return item.ID })
	if first.Body != message.Body || first.Author.UserID != f.userID || first.Author.Agent || second.Body != reply.Body || second.Author.UserID != f.userID || second.Author.Agent || second.ReplyTo == nil || *second.ReplyTo != first.ID {
		t.Fatal("application Thread readback lost the same author, content or reply target")
	}

	attachmentPath := taskPath(child) + "/attachments/files/results/application.txt"
	payload := []byte("Application-owned task material\n")
	_, encoded := application.request(t, http.MethodPut, attachmentPath, "text/plain; charset=utf-8", payload, http.StatusCreated)
	metadata := decodeAttachment(t, encoded)
	if metadata.Path != "results/application.txt" || metadata.SizeBytes != int64(len(payload)) {
		t.Fatalf("application attachment metadata differs: %+v", metadata)
	}
	response, content := application.request(t, http.MethodGet, attachmentPath, "", nil, http.StatusOK)
	media, parameters, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || media != "text/plain" || parameters["charset"] != "utf-8" || response.Header.Get("Daynight-User-ID") != f.userID || !bytes.Equal(content, payload) {
		t.Fatal("application protected attachment bytes or MIME differs")
	}
	head, content := application.request(t, http.MethodHead, attachmentPath, "", nil, http.StatusOK)
	if len(content) != 0 || head.Header.Get("Daynight-User-ID") != f.userID || head.Header.Get("Content-Type") != response.Header.Get("Content-Type") || head.Header.Get("Content-Length") != strconv.Itoa(len(payload)) {
		t.Fatal("application protected HEAD did not describe the same attachment")
	}
	page := requestJSON[api.AttachmentPage](t, application, http.MethodGet, taskPath(child)+"/attachments", nil, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].Path != metadata.Path || page.Items[0].SizeBytes != metadata.SizeBytes || page.Items[0].ContentType != metadata.ContentType {
		t.Fatalf("application attachment listing differs from its upload: %+v", page)
	}
	_, nativeContent := f.request(t, http.MethodGet, attachmentPath, "", nil, http.StatusOK)
	if !bytes.Equal(nativeContent, payload) {
		t.Fatal("native owner did not read the application's persisted attachment")
	}

	current := requestJSON[api.Task](t, application, http.MethodGet, taskPath(child), nil, http.StatusOK)
	if current.Version != completed.Version {
		t.Fatal("application material reads or independent records changed the Task version")
	}
	done := setStatus(t, application, current, "done", nil)
	native := requestJSON[api.Task](t, f, http.MethodGet, taskPath(child), nil, http.StatusOK)
	assertTaskContent(t, native, done)
	if native.ParentID == nil || *native.ParentID != goal.ID || native.AssignedTo == nil || *native.AssignedTo != f.userID || native.RequiredPlatform == nil || *native.RequiredPlatform != "linux" || !native.AllowAgents {
		t.Fatal("native owner did not read the application's persisted Task settings")
	}
	goalRead = requestJSON[api.Task](t, application, http.MethodGet, taskPath(goal), nil, http.StatusOK)
	if goalRead.Progress == nil || goalRead.Progress.Total != 1 || goalRead.Progress.Done != 1 || goalRead.Progress.Unfinished != 0 {
		t.Fatalf("application child completion was not reflected in the same Goal: %+v", goalRead)
	}
}
