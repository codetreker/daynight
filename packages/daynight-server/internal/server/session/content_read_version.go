package session

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// The version belongs to one WebSocket handshake, never a registration or a
// previous connection. Absence explicitly selects legacy content requests.
func contentReadVersion(request *http.Request) (int, error) {
	values := request.Header.Values("X-Daynight-Content-Read-Version")
	if len(values) == 0 {
		return 0, nil
	}
	if len(values) != 1 || values[0] != "1" {
		return 0, httpx.InvalidInput("X-Daynight-Content-Read-Version must be a single supported version: 1.")
	}
	return 1, nil
}
