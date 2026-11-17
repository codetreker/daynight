package worker

import (
	"net/http"

	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const workerToolPathsHeader = "Daynight-Worker-Tool-Paths"
const workerArchiveSessionsHeader = "Daynight-Worker-Archive-Sessions"
const workerControlModeHeader = "Daynight-Worker-Control-Mode"

func workerCapabilities(header http.Header) (workerprotocol.Capabilities, error) {
	var result workerprotocol.Capabilities
	if _, exists := header[workerControlModeHeader]; exists {
		return result, httpx.InvalidInput("Worker control mode protocol is no longer supported; upgrade the Worker or refresh the Web client.")
	}
	if values, exists := header[workerToolPathsHeader]; exists {
		if len(values) != 1 || values[0] != "2" {
			return result, httpx.InvalidInput("Worker tool paths protocol requires version 2; upgrade the Worker or refresh the Web client.")
		}
		result.ToolPaths = true
	}
	if values, exists := header[workerArchiveSessionsHeader]; exists {
		if len(values) != 1 || values[0] != "1" {
			return result, httpx.InvalidInput("Unsupported Worker archive sessions protocol.")
		}
		result.ArchiveSessions = true
	}
	return result, nil
}

func writeWorkerCapabilities(header http.Header, capabilities workerprotocol.Capabilities) {
	if capabilities.ToolPaths {
		header.Set(workerToolPathsHeader, "2")
	}
	if capabilities.ArchiveSessions {
		header.Set(workerArchiveSessionsHeader, "1")
	}
}

// The two-tool contract is mandatory only for report, configuration and detail.
func requireToolPaths(capabilities workerprotocol.Capabilities) error {
	if !capabilities.ToolPaths {
		return httpx.InvalidInput("Worker tool paths protocol requires version 2; upgrade the Worker or refresh the Web client.")
	}
	return nil
}
