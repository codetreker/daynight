package server

import "github.com/codetreker/daynight/packages/daynight-server/api"

func threadPath(task api.Task) string { return taskPath(task) + "/thread/messages" }
