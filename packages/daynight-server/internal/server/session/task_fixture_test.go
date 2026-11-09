package session_test

import "github.com/codetreker/daynight/packages/daynight-server/api"

func taskCollection(projectID string) string { return "/api/v1/projects/" + projectID + "/tasks" }
func taskPath(task api.Task) string          { return taskCollection(task.ProjectID) + "/" + task.ID }
