package httpx

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// BotIdentityHeader declares the Bot acting for the authenticated user.
const BotIdentityHeader = "X-Daynight-Bot-Id"

// BotIdentity returns nil when the header is absent. A present header must
// occur once and hold a nonzero canonical lowercase UUID; ownership and
// deletion state are verified by the business operation.
func BotIdentity(request *http.Request) (*string, error) {
	values, exists := request.Header[http.CanonicalHeaderKey(BotIdentityHeader)]
	if !exists {
		return nil, nil
	}
	if len(values) != 1 {
		return nil, InvalidInput(BotIdentityHeader + " must occur exactly once")
	}
	id, err := model.CanonicalID(values[0])
	if err != nil || id != values[0] || id == "00000000-0000-0000-0000-000000000000" {
		return nil, InvalidInput("ID must be a nonzero canonical lowercase UUID")
	}
	return &id, nil
}
