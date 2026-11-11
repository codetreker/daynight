package worker

import (
	"net/http"

	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const workerToolPathsHeader = "Daynight-Worker-Tool-Paths"

func workerCapabilities(header http.Header) (workerprotocol.Capabilities, error) {
	var result workerprotocol.Capabilities
	var err error
	result.ControlMode, err = controlModeProtocol(header)
	if err != nil {
		return result, err
	}
	if values, exists := header[workerToolPathsHeader]; exists {
		if len(values) != 1 || values[0] != "1" {
			return result, httpx.InvalidInput("Unsupported Worker tool paths protocol.")
		}
		result.ToolPaths = true
	}
	return result, nil
}

func writeWorkerCapabilities(header http.Header, capabilities workerprotocol.Capabilities) {
	if capabilities.ControlMode {
		header.Set(workerControlModeHeader, "1")
	}
	if capabilities.ToolPaths {
		header.Set(workerToolPathsHeader, "1")
	}
}
