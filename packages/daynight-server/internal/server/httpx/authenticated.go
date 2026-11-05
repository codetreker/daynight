package httpx

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type AuthenticatedHandler func(http.ResponseWriter, *http.Request, model.Principal)
