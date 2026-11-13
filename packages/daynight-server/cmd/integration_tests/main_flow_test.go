//go:build integration

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func assertOrdinaryType(t *testing.T, item map[string]any) {
	t.Helper()
	parent, present := item["parentId"]
	if item["type"] != "task" || !present || parent != nil {
		t.Fatalf("ordinary resource type/parent differs: %+v", item)
	}
}

func assertOrdinaryPage(t *testing.T, page map[string]any, field string) {
	t.Helper()
	items, ok := page[field].([]any)
	if !ok || len(items) == 0 {
		t.Fatalf("resource page has no %s: %+v", field, page)
	}
	for _, value := range items {
		item, ok := value.(map[string]any)
		if !ok {
			t.Fatalf("resource is not an object: %+v", value)
		}
		assertOrdinaryType(t, item)
	}
}

func TestServerAPINormalFlows(t *testing.T) {
	f := newFixture(t)
	t.Run("public application authorization", func(t *testing.T) { serverAPIPublicApplicationNormalFlow(t, f) })
	t.Run("application work materials", func(t *testing.T) { serverAPIApplicationMaterialNormalFlow(t, f) })
	t.Run("application Webhook management", func(t *testing.T) { serverAPIApplicationWebhookNormalFlow(t, f) })
	t.Run("browser REST response headers", func(t *testing.T) { serverAPICORSNormalFlow(t, f) })
	t.Run("worker readonly directory", func(t *testing.T) { serverAPIWorkerReadOnlyNormalFlow(t, f) })
	t.Run("assistant task collaboration", func(t *testing.T) { serverAPIAssistantTaskFlow(t, f) })
	t.Run("worker tool paths adoption", func(t *testing.T) { serverAPIWorkerToolPathsFlow(t, f) })
	t.Run("personal task inventory", func(t *testing.T) { serverAPIPersonalTaskNormalFlow(t, f) })
	t.Run("GitHub reads", func(t *testing.T) { serverAPIGitHubReadNormalFlow(t, f) })
	t.Run("direct Team member", func(t *testing.T) { serverAPIDirectMemberNormalFlow(t, f) })
	t.Run("project tag catalog", func(t *testing.T) { serverAPITagCatalogNormalFlow(t, f) })
	t.Run("task tags", func(t *testing.T) { serverAPITaskTagsNormalFlow(t, f) })
	t.Run("Goal and child", func(t *testing.T) {
		project := createProject(t, f, "API Goal")
		goal := createTask(t, f, project, "Goal", map[string]any{"type": "goal"})
		if goal.Type != "goal" || goal.Status != "todo" || goal.Ready || goal.AssignedTo == nil || *goal.AssignedTo != f.userID || goal.Progress == nil || goal.Progress.Total != 0 {
			t.Fatalf("initial Goal differs: %+v", goal)
		}
		child := createTask(t, f, project, "Child", map[string]any{"parentId": goal.ID, "status": "todo"})
		if child.ParentID == nil || *child.ParentID != goal.ID {
			t.Fatalf("child parent differs: %+v", child)
		}
		read := requestJSON[api.Task](t, f, http.MethodGet, taskPath(goal), nil, http.StatusOK)
		if read.Progress == nil || read.Progress.Total != 1 || read.Progress.Unfinished != 1 {
			t.Fatalf("Goal progress differs: %+v", read)
		}
		messagePath := taskPath(goal) + "/thread/messages"
		message := requestJSON[api.ThreadMessage](t, f, http.MethodPost, messagePath, map[string]any{"body": "Goal material"}, http.StatusCreated)
		messages := requestJSON[api.ThreadPage](t, f, http.MethodGet, messagePath+"?fromBeginning=true", nil, http.StatusOK)
		if expectID(t, messages.Items, message.ID, func(item api.ThreadMessage) string { return item.ID }).Body != "Goal material" {
			t.Fatal("Goal Thread content differs")
		}
		goal = setStatus(t, f, read, "done", nil)
		childRead := requestJSON[api.Task](t, f, http.MethodGet, taskPath(child), nil, http.StatusOK)
		if childRead.Version != child.Version || childRead.Status != child.Status || childRead.ParentID == nil || *childRead.ParentID != goal.ID {
			t.Fatalf("Goal completion changed child: %+v", childRead)
		}
	})
	t.Run("personal worker prompts", func(t *testing.T) { serverAPIPromptNormalFlow(t, f) })
	t.Run("MCP manual and repository project context", func(t *testing.T) {
		const repository = "https://github.com/example/manual-integration"
		project := requestJSON[api.Project](t, f, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "MCP manual integration", RepoURL: repository, ExpectedUserID: f.userID}, http.StatusCreated)
		if project.ID == "" || project.RepoURL != repository {
			t.Fatalf("created Project differs: %+v", project)
		}
		task := createTask(t, f, project, "MCP context task", nil)
		ready := createTask(t, f, project, "MCP ready task", map[string]any{"status": "todo"})

		client := sdk.NewClient(&sdk.Implementation{Name: "daynight-manual-integration", Version: "1"}, nil)
		session, err := client.Connect(f.context, &sdk.StreamableClientTransport{Endpoint: f.origin + "/mcp", HTTPClient: f.client, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = session.Close() })
		listing, err := session.ListResources(f.context, nil)
		if err != nil {
			t.Fatal(err)
		}
		const (
			uri                 = "daynight://manuals/concepts.md"
			expectedManualCount = 12
		)
		var manual *sdk.Resource
		for _, resource := range listing.Resources {
			if resource.URI == uri {
				manual = resource
			}
		}
		if len(listing.Resources) != expectedManualCount || listing.NextCursor != "" || manual == nil || manual.MIMEType != "text/markdown" {
			t.Fatalf("manual discovery differs: %+v", listing)
		}
		read, err := session.ReadResource(f.context, &sdk.ReadResourceParams{URI: manual.URI})
		if err != nil {
			t.Fatal(err)
		}
		if len(read.Contents) != 1 || read.Contents[0].URI != uri || read.Contents[0].MIMEType != "text/markdown" || int64(len(read.Contents[0].Text)) != manual.Size || !strings.Contains(read.Contents[0].Text, "project_resolve") {
			t.Fatalf("manual content differs: %+v", read)
		}

		call := func(name string, arguments map[string]any) map[string]any {
			t.Helper()
			result, err := session.CallTool(f.context, &sdk.CallToolParams{Name: name, Arguments: arguments})
			if err != nil || result == nil || result.IsError {
				t.Fatalf("%s: result=%+v error=%v", name, result, err)
			}
			encoded, err := json.Marshal(result.StructuredContent)
			if err != nil {
				t.Fatal(err)
			}
			var envelope struct {
				Data map[string]any `json:"data"`
			}
			if err := json.Unmarshal(encoded, &envelope); err != nil || envelope.Data == nil {
				t.Fatalf("%s structured content: %s (%v)", name, encoded, err)
			}
			return envelope.Data
		}
		resolved := call("project_resolve", map[string]any{"repoUrl": "git@github.com:example/manual-integration.git"})
		if resolved["id"] != project.ID || resolved["repoUrl"] != repository {
			t.Fatalf("resolved Project differs: %+v", resolved)
		}
		createdTag := call("tag_create", map[string]any{"projectId": project.ID, "name": " backend "})
		tagID, ok := createdTag["id"].(string)
		if !ok || tagID == "" || createdTag["name"] != "backend" || createdTag["version"] != "1" {
			t.Fatalf("created tag differs: %+v", createdTag)
		}
		conflict := func(name string, arguments map[string]any) {
			t.Helper()
			result, err := session.CallTool(f.context, &sdk.CallToolParams{Name: name, Arguments: arguments})
			if err != nil || result == nil || !result.IsError {
				t.Fatalf("%s conflict: result=%+v error=%v", name, result, err)
			}
			encoded, err := json.Marshal(result.StructuredContent)
			if err != nil {
				t.Fatal(err)
			}
			var envelope struct {
				Error struct {
					Code         string `json:"code"`
					WriteOutcome string `json:"writeOutcome"`
				} `json:"error"`
			}
			if err := json.Unmarshal(encoded, &envelope); err != nil || envelope.Error.Code != "tag_name_conflict" || envelope.Error.WriteOutcome != "not_committed" {
				t.Fatalf("%s conflict result: %s (%v)", name, encoded, err)
			}
		}
		conflict("tag_create", map[string]any{"projectId": project.ID, "name": "BACKEND"})
		other := call("tag_create", map[string]any{"projectId": project.ID, "name": "other"})
		conflict("tag_rename", map[string]any{"projectId": project.ID, "tagId": other["id"], "ifVersion": other["version"], "name": "BACKEND"})
		call("tag_delete", map[string]any{"projectId": project.ID, "tagId": other["id"], "ifVersion": other["version"], "confirm": true})
		catalog := call("tag_list", map[string]any{"projectId": project.ID, "query": "back"})
		tags, ok := catalog["items"].([]any)
		if !ok || len(tags) != 1 || tags[0].(map[string]any)["id"] != tagID || catalog["catalogEpoch"] == "" {
			t.Fatalf("tag catalog differs: %+v", catalog)
		}
		shown := call("tag_show", map[string]any{"projectId": project.ID, "tagId": tagID})
		if shown["id"] != tagID || shown["version"] != "1" {
			t.Fatalf("tag read differs: %+v", shown)
		}
		renamed := call("tag_rename", map[string]any{"projectId": project.ID, "tagId": tagID, "ifVersion": shown["version"], "name": "platform"})
		if renamed["id"] != tagID || renamed["name"] != "platform" || renamed["version"] != "2" {
			t.Fatalf("tag rename differs: %+v", renamed)
		}
		deleted := call("tag_delete", map[string]any{"projectId": project.ID, "tagId": tagID, "ifVersion": renamed["version"], "confirm": true})
		if deleted["projectId"] != project.ID || deleted["tagId"] != tagID || deleted["deleted"] != true {
			t.Fatalf("tag deletion differs: %+v", deleted)
		}
		actual := call("task_show", map[string]any{"projectId": resolved["id"], "taskId": task.ID, "view": "full"})
		assertOrdinaryType(t, actual)
		if actual["id"] != task.ID || actual["projectId"] != project.ID || actual["title"] != task.Title {
			t.Fatalf("Task from resolved Project differs: %+v", actual)
		}
		listed := call("task_list", map[string]any{"projectId": project.ID, "view": "summary"})
		assertOrdinaryPage(t, listed, "items")
		readyPage := call("task_ready", map[string]any{"projectId": project.ID, "view": "summary"})
		assertOrdinaryPage(t, readyPage, "items")
		items := readyPage["items"].([]any)
		found := false
		for _, value := range items {
			if value.(map[string]any)["id"] == ready.ID {
				found = true
			}
		}
		if !found {
			t.Fatalf("ready Task missing from MCP result: %+v", readyPage)
		}
	})
	t.Run("task lifecycle", func(t *testing.T) {
		project := createProject(t, f, "API lifecycle")
		task := createTask(t, f, project, "Created task", nil)
		if task.Status != "proposed" || task.Ready || task.Version != 1 {
			t.Fatalf("initial task state differs: %+v", task)
		}
		assertTaskContent(t, requestJSON[api.Task](t, f, http.MethodGet, taskPath(task), nil, http.StatusOK), task)
		assertOrdinaryType(t, requestJSON[map[string]any](t, f, http.MethodGet, taskPath(task), nil, http.StatusOK))
		updated := requestJSON[api.Task](t, f, http.MethodPatch, taskPath(task), map[string]any{"version": task.Version, "title": "Updated task", "description": "Normal API content"}, http.StatusOK)
		if updated.ID != task.ID || updated.Version != task.Version+1 || updated.Title != "Updated task" || updated.Description != "Normal API content" {
			t.Fatalf("task update differs: %+v", updated)
		}
		started := setStatus(t, f, updated, "in_progress", nil)
		done := setStatus(t, f, started, "done", nil)
		if done.Ready {
			t.Fatal("completed task remains ready")
		}
		proposed := setStatus(t, f, done, "proposed", nil)
		if proposed.Ready || proposed.StartedAt != nil || proposed.CompletedAt != nil {
			t.Fatalf("returning to proposed retained execution state: %+v", proposed)
		}
		done = setStatus(t, f, proposed, "done", nil)
		if done.StartedAt != nil || done.CompletedAt == nil {
			t.Fatalf("direct proposed completion has invalid timing: %+v", done)
		}
		assertTaskContent(t, requestJSON[api.Task](t, f, http.MethodGet, taskPath(done), nil, http.StatusOK), done)
		page := requestJSON[api.TaskPage](t, f, http.MethodGet, taskCollection(project.ID)+"?status=done&ready=false", nil, http.StatusOK)
		if len(page.Items) != 1 {
			t.Fatalf("completed task list differs: %+v", page)
		}
		assertTaskContent(t, expectID(t, page.Items, done.ID, func(task api.Task) string { return task.ID }), done)
	})
	t.Run("search pagination and dependency graph", func(t *testing.T) {
		project := createProject(t, f, "API search and graph")
		root := createTask(t, f, project, "Prerequisite", nil)
		root = setStatus(t, f, setStatus(t, f, root, "in_progress", nil), "done", nil)
		first := createTask(t, f, project, "Cache title", map[string]any{"dependsOn": []string{root.ID}})
		second := createTask(t, f, project, "Other title", map[string]any{"description": "Normal cache content"})
		page := requestJSON[api.TaskSearchPage](t, f, http.MethodPost, taskCollection(project.ID)+"/search", map[string]any{"query": "cache", "limit": 1}, http.StatusOK)
		assertOrdinaryPage(t, requestJSON[map[string]any](t, f, http.MethodPost, taskCollection(project.ID)+"/search", map[string]any{"query": "cache", "limit": 1}, http.StatusOK), "items")
		if page.ProjectID != project.ID || page.Total != 2 || len(page.Items) != 1 || page.NextCursor == nil {
			t.Fatalf("first search page differs: %+v", page)
		}
		next := requestJSON[api.TaskSearchPage](t, f, http.MethodPost, taskCollection(project.ID)+"/search", map[string]any{"query": "cache", "limit": 1, "cursor": *page.NextCursor}, http.StatusOK)
		if next.ProjectID != project.ID || next.Total != 2 || len(next.Items) != 1 || next.NextCursor != nil || next.Items[0].ID == page.Items[0].ID {
			t.Fatalf("next search page differs: %+v", next)
		}
		items := append(page.Items, next.Items...)
		if actual := expectID(t, items, first.ID, func(task api.TaskSearchItem) string { return task.ID }); actual.Title != first.Title {
			t.Fatal("search lost title content")
		}
		if actual := expectID(t, items, second.ID, func(task api.TaskSearchItem) string { return task.ID }); actual.Match.DescriptionSnippet == nil || *actual.Match.DescriptionSnippet != second.Description {
			t.Fatal("search lost description content")
		}
		idPage := requestJSON[api.TaskSearchPage](t, f, http.MethodPost, taskCollection(project.ID)+"/search", map[string]any{"query": "id:" + first.ID}, http.StatusOK)
		if idPage.ProjectID != project.ID || idPage.Total != 1 || len(idPage.Items) != 1 || idPage.Items[0].ID != first.ID || idPage.Items[0].Title != first.Title || !reflect.DeepEqual(idPage.Items[0].Match.Fields, []string{"id"}) || idPage.Items[0].Match.DescriptionSnippet != nil || idPage.NextCursor != nil {
			t.Fatalf("ID search differs: %+v", idPage)
		}
		graph := requestJSON[api.TaskGraph](t, f, http.MethodGet, "/api/v1/projects/"+project.ID+"/task-graph?taskId="+first.ID, nil, http.StatusOK)
		assertOrdinaryPage(t, requestJSON[map[string]any](t, f, http.MethodGet, "/api/v1/projects/"+project.ID+"/task-graph?taskId="+first.ID, nil, http.StatusOK), "tasks")
		if graph.Project.ID != project.ID || graph.Summary.Total != 2 || len(graph.Tasks) != 2 {
			t.Fatalf("graph identity/count differs: %+v", graph)
		}
		dependent := expectID(t, graph.Tasks, first.ID, func(task api.GraphTask) string { return task.ID })
		if !reflect.DeepEqual(dependent.DependsOn, []string{root.ID}) || dependent.Status != first.Status {
			t.Fatalf("graph dependency differs: %+v", dependent)
		}
		if actual := expectID(t, graph.Tasks, root.ID, func(task api.GraphTask) string { return task.ID }); actual.Status != "done" {
			t.Fatal("graph did not read the completed prerequisite")
		}
	})
	t.Run("property and sync readback", func(t *testing.T) {
		project := createProject(t, f, "API properties and sync")
		task := createTask(t, f, project, "Synchronized task", nil)
		baseline := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK)
		assertOrdinaryPage(t, requestJSON[map[string]any](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK), "tasks")
		if baseline.Project.ID != project.ID || baseline.Epoch == "" || baseline.ObservedAt.IsZero() {
			t.Fatalf("snapshot identity differs: %+v", baseline)
		}
		value := []api.PullRequestProperty{{URL: "https://github.com/example/tasks/pull/1", Title: "Normal evidence"}}
		propertyPath := taskPath(task) + "/properties/pullRequests"
		updated := requestJSON[api.PropertyResource](t, f, http.MethodPut, propertyPath, map[string]any{"version": task.Version, "valueText": `[{"url":"https://github.com/example/tasks/pull/1","title":"Normal evidence"}]`}, http.StatusOK)
		if updated.ProjectID != project.ID || updated.TaskID != task.ID || updated.Version != task.Version+1 {
			t.Fatalf("property mutation identity differs: %+v", updated)
		}
		read := requestJSON[api.Task](t, f, http.MethodGet, taskPath(task), nil, http.StatusOK)
		requireProperty(t, read.Properties, "pullRequests", value)
		for _, path := range []string{syncPath(project.ID), deltaPath(project.ID, baseline)} {
			result := requestJSON[api.TaskSync](t, f, http.MethodGet, path, nil, http.StatusOK)
			if result.Project.ID != project.ID || result.Epoch != baseline.Epoch {
				t.Fatalf("sync identity differs: %+v", result)
			}
			actual := expectID(t, result.Tasks, task.ID, func(task api.TaskViewRecord) string { return task.ID })
			if actual.Version != resourceVersion(updated.Version) {
				t.Fatal("sync lost property mutation version")
			}
			requireProperty(t, actual.Properties, "pullRequests", value)
		}
		removed := requestJSON[api.PropertyResource](t, f, http.MethodDelete, propertyPath, map[string]any{"version": updated.Version}, http.StatusOK)
		if removed.TaskID != task.ID || removed.Version != updated.Version+1 {
			t.Fatalf("property delete identity differs: %+v", removed)
		}
		current := requestJSON[api.Task](t, f, http.MethodGet, taskPath(task), nil, http.StatusOK)
		if _, exists := current.Properties["pullRequests"]; exists || current.Version != removed.Version {
			t.Fatal("deleted property remained in Task readback")
		}
		result := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK)
		actual := expectID(t, result.Tasks, task.ID, func(task api.TaskViewRecord) string { return task.ID })
		if _, exists := actual.Properties["pullRequests"]; exists || actual.Version != resourceVersion(removed.Version) {
			t.Fatal("deleted property remained in Sync readback")
		}
	})
	t.Run("step reads and writes", func(t *testing.T) {
		project := createProject(t, f, "API Steps")
		task := createTask(t, f, project, "Step parent", nil)
		path := taskPath(task) + "/steps"
		first := requestJSON[api.StepsResource](t, f, http.MethodPost, path, map[string]any{"version": task.Version, "id": "abcdef01", "title": "First Step", "description": "Initial content"}, http.StatusCreated)
		second := requestJSON[api.StepsResource](t, f, http.MethodPost, path, map[string]any{"version": first.Version, "id": "12345678", "title": "Second Step"}, http.StatusCreated)
		read := requestJSON[api.StepsResource](t, f, http.MethodGet, path, nil, http.StatusOK)
		if read.ProjectID != project.ID || read.TaskID != task.ID || read.Version != second.Version || !reflect.DeepEqual(read.Steps, second.Steps) {
			t.Fatalf("Step list differs: %+v", read)
		}
		single := requestJSON[api.StepResource](t, f, http.MethodGet, path+"/abcdef01", nil, http.StatusOK)
		if single.TaskID != task.ID || single.Step.ID != "abcdef01" || single.Step.Description != "Initial content" {
			t.Fatalf("Step get differs: %+v", single)
		}
		changed := requestJSON[api.StepsResource](t, f, http.MethodPatch, path+"/abcdef01", map[string]any{"version": second.Version, "title": "Edited Step", "description": "Updated content"}, http.StatusOK)
		active := requestJSON[api.StepsResource](t, f, http.MethodPut, path+"/abcdef01/status", map[string]any{"version": changed.Version, "status": "in_progress"}, http.StatusOK)
		moved := requestJSON[api.StepsResource](t, f, http.MethodPut, path+"/12345678/position", map[string]any{"version": active.Version, "position": "first"}, http.StatusOK)
		if len(moved.Steps) != 2 || moved.Steps[0].ID != "12345678" || moved.Steps[1].ID != "abcdef01" || moved.Steps[1].Title != "Edited Step" || moved.Steps[1].Description != "Updated content" || moved.Steps[1].Status != "in_progress" {
			t.Fatalf("Step move/content differs: %+v", moved)
		}
		removed := requestJSON[api.StepsResource](t, f, http.MethodDelete, path+"/12345678", map[string]any{"version": moved.Version}, http.StatusOK)
		current := requestJSON[api.StepsResource](t, f, http.MethodGet, path, nil, http.StatusOK)
		if current.ProjectID != project.ID || current.TaskID != task.ID || current.Version != removed.Version || len(current.Steps) != 1 || current.Steps[0].ID != "abcdef01" || !reflect.DeepEqual(current.Steps, removed.Steps) {
			t.Fatalf("Step deletion readback differs: %+v", current)
		}
	})
	t.Run("thread messages and replies", func(t *testing.T) {
		project := createProject(t, f, "API Thread")
		task := createTask(t, f, project, "Thread parent", nil)
		path := taskPath(task) + "/thread/messages"
		first := requestJSON[api.ThreadMessage](t, f, http.MethodPost, path, map[string]any{"body": "Normal discussion"}, http.StatusCreated)
		if first.ID == "" || first.Body != "Normal discussion" || first.Author.UserID != f.userID || first.Author.Agent {
			t.Fatalf("Thread post differs: %+v", first)
		}
		reply := requestJSON[api.ThreadMessage](t, f, http.MethodPost, path, map[string]any{"body": "Normal reply", "replyTo": first.ID}, http.StatusCreated)
		page := requestJSON[api.ThreadPage](t, f, http.MethodGet, path+"?fromBeginning=true", nil, http.StatusOK)
		readFirst := expectID(t, page.Items, first.ID, func(message api.ThreadMessage) string { return message.ID })
		readReply := expectID(t, page.Items, reply.ID, func(message api.ThreadMessage) string { return message.ID })
		if readFirst.Body != first.Body || readReply.Body != reply.Body || readReply.ReplyTo == nil || *readReply.ReplyTo != first.ID || readReply.Author.UserID != f.userID {
			t.Fatal("Thread readback lost content, identity or reply target")
		}
	})
	t.Run("attachment bytes and lifecycle", func(t *testing.T) {
		project := createProject(t, f, "API Attachments")
		task := createTask(t, f, project, "Attachment parent", nil)
		path := taskPath(task) + "/attachments/files/notes/result.txt"
		payload := []byte("Normal attachment content\n")
		_, data := f.request(t, http.MethodPut, path, "text/plain; charset=utf-8", payload, http.StatusCreated)
		created := decodeAttachment(t, data)
		if created.Path != "notes/result.txt" || created.SizeBytes != int64(len(payload)) {
			t.Fatalf("attachment creation differs: %+v", created)
		}
		_, downloaded := f.request(t, http.MethodGet, path, "", nil, http.StatusOK)
		if !bytes.Equal(downloaded, payload) {
			t.Fatal("attachment download differs from uploaded bytes")
		}
		replacement := []byte("Replaced normal content\n")
		_, data = f.request(t, http.MethodPut, path, "text/plain; charset=utf-8", replacement, http.StatusOK)
		updated := decodeAttachment(t, data)
		_, downloaded = f.request(t, http.MethodGet, path, "", nil, http.StatusOK)
		if updated.Path != created.Path || updated.SizeBytes != int64(len(replacement)) || !bytes.Equal(downloaded, replacement) {
			t.Fatal("attachment replacement readback differs")
		}
		page := requestJSON[api.AttachmentPage](t, f, http.MethodGet, taskPath(task)+"/attachments", nil, http.StatusOK)
		if len(page.Items) != 1 || page.Items[0].Path != created.Path || page.Items[0].SizeBytes != updated.SizeBytes {
			t.Fatalf("attachment list differs: %+v", page)
		}
		f.request(t, http.MethodDelete, path, "", nil, http.StatusNoContent)
		empty := requestJSON[api.AttachmentPage](t, f, http.MethodGet, taskPath(task)+"/attachments", nil, http.StatusOK)
		if len(empty.Items) != 0 {
			t.Fatalf("deleted attachment remained in list: %+v", empty)
		}
		readProject := requestJSON[api.Project](t, f, http.MethodGet, "/api/v1/projects/"+project.ID, nil, http.StatusOK)
		if readProject.ID != project.ID || readProject.Name != project.Name {
			t.Fatalf("attachment flow changed its owning Project: %+v", readProject)
		}
	})
	t.Run("worker claim and Agent discussion", func(t *testing.T) {
		project := createProject(t, f, "API Worker claim")
		task := createTask(t, f, project, "Worker task", map[string]any{"assignedTo": f.userID, "status": "todo"})
		task = requestJSON[api.Task](t, f, http.MethodPatch, taskPath(task), map[string]any{"version": task.Version, "allowAgents": true}, http.StatusOK)
		claimID, workerID := uuid.NewString(), uuid.NewString()
		claimed := requestJSON[api.Task](t, f, http.MethodPost, taskPath(task)+"/worker-claim", map[string]any{"version": task.Version, "claimId": claimID, "workerId": workerID, "machine": map[string]any{"id": uuid.NewString(), "name": "Integration machine"}, "platform": "linux", "agent": "codex", "worktreeId": uuid.NewString()}, http.StatusOK)
		claim := workerClaim(t, claimed)
		if claim.ClaimID != claimID || claim.WorkerID != workerID || claim.UserID != f.userID || claim.State != "active" || claimed.ID != task.ID || claimed.Status != "in_progress" {
			t.Fatalf("Worker claim identity differs: %+v %+v", claimed, claim)
		}
		active := requestJSON[api.Task](t, f, http.MethodPatch, taskPath(claimed)+"/worker-claim", map[string]any{"version": claimed.Version, "claimId": claimID, "phase": "executing"}, http.StatusOK)
		read := requestJSON[api.Task](t, f, http.MethodGet, taskPath(active), nil, http.StatusOK)
		if actual := workerClaim(t, read); actual.ClaimID != claimID || actual.WorkerID != workerID || actual.Phase != "executing" {
			t.Fatalf("Worker phase readback differs: %+v", actual)
		}
		path := taskPath(active) + "/thread/messages"
		message := requestJSON[api.ThreadMessage](t, f, http.MethodPost, path, map[string]any{"body": "Agent discussion", "claimId": claimID}, http.StatusCreated)
		page := requestJSON[api.ThreadPage](t, f, http.MethodGet, path+"?details=true", nil, http.StatusOK)
		actual := expectID(t, page.Items, message.ID, func(message api.ThreadMessage) string { return message.ID })
		if actual.Body != message.Body || !actual.Author.Agent || actual.Author.UserID != f.userID || actual.Author.Execution == nil || actual.Author.Execution.ClaimID != claimID || actual.Author.Execution.WorkerID != workerID {
			t.Fatalf("Agent attribution readback differs: %+v", actual)
		}
		released := requestJSON[api.Task](t, f, http.MethodPost, taskPath(active)+"/worker-claim/release", map[string]any{"version": active.Version, "claimId": claimID, "stoppedConfirmed": true}, http.StatusOK)
		if released.Version != active.Version+1 || released.Status != "todo" || released.StartedAt != nil || released.CompletedAt != nil || released.Properties["worker"] != nil || released.Properties["sessionStartup"] != nil || !released.AllowAgents || released.AssignedTo == nil || *released.AssignedTo != f.userID {
			t.Fatalf("release did not clear execution while preserving ordinary fields: %+v", released)
		}
		newClaimID, newWorkerID, newWorktreeID := uuid.NewString(), uuid.NewString(), uuid.NewString()
		reclaimed := requestJSON[api.Task](t, f, http.MethodPost, taskPath(released)+"/worker-claim", map[string]any{"version": released.Version, "claimId": newClaimID, "workerId": newWorkerID, "machine": map[string]any{"id": uuid.NewString(), "name": "Replacement machine"}, "platform": "linux", "agent": "codex", "worktreeId": newWorktreeID}, http.StatusOK)
		if next := workerClaim(t, reclaimed); next.ClaimID != newClaimID || next.WorkerID != newWorkerID || next.WorktreeID != newWorktreeID || next.ClaimID == claimID {
			t.Fatalf("reclaim inherited previous execution: %+v", next)
		}
		page = requestJSON[api.ThreadPage](t, f, http.MethodGet, path+"?details=true", nil, http.StatusOK)
		actual = expectID(t, page.Items, message.ID, func(message api.ThreadMessage) string { return message.ID })
		if actual.Author.Execution == nil || actual.Author.Execution.ClaimID != claimID || actual.Author.Execution.WorkerID != workerID {
			t.Fatalf("reclaim changed historical attribution: %+v", actual.Author)
		}
		done := setStatus(t, f, reclaimed, "done", &newClaimID)
		read = requestJSON[api.Task](t, f, http.MethodGet, taskPath(done), nil, http.StatusOK)
		assertTaskContent(t, read, done)
		if actual := workerClaim(t, read); actual.State != "completed" || actual.ClaimID != newClaimID {
			t.Fatalf("completed Worker claim readback differs: %+v", actual)
		}
	})
}
