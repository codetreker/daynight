package server

func graphPath(projectID, taskID string) string {
	return "/api/v1/projects/" + projectID + "/task-graph?taskId=" + taskID
}
