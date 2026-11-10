package server

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"net/http"
)

type resourceTestHandler struct {
	http.Handler
	token     string
	principal model.Principal
}

func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if resource, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+resource.token)
	}
}
