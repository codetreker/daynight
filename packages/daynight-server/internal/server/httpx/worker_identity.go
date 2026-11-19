package httpx

import "net/http"

const WorkerIdentityHeader = "Daynight-Worker-Identity"

// WorkerIdentityProtocol keeps retained claim identities opt-in for strict clients.
func WorkerIdentityProtocol(header http.Header) (bool, error) {
	values := header.Values(WorkerIdentityHeader)
	if len(values) == 0 {
		return false, nil
	}
	if len(values) != 1 || values[0] != "1" {
		return false, InvalidInput("Worker identity protocol must be exactly 1.")
	}
	return true, nil
}
