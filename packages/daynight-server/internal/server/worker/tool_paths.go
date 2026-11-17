package worker

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const workerToolPathsHeader = "Daynight-Worker-Tool-Paths"

func requireToolProtocol(header http.Header) error {
	values := header.Values(workerToolPathsHeader)
	if len(values) != 1 || values[0] != "2" {
		return httpx.InvalidInput("Worker tool protocol version 2 is required; upgrade the Worker or refresh Web.")
	}
	return nil
}

func writeToolProtocol(header http.Header) { header.Set(workerToolPathsHeader, "2") }
