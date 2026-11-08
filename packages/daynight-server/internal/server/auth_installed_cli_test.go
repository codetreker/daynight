package server

import (
	"sync/atomic"
)

type identityCLIRequests struct {
	all, bearer, anonymous, authenticatedPAT, unauthorized atomic.Int64
}
