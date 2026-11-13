package bot

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const attentionHeader = "Daynight-Bot-Attention"

// Bot responses retain their legacy shape unless the caller advertises support.
func (h *botsHandler) withAttention(next httpx.AuthenticatedHandler) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, principal model.Principal) {
		if values, exists := r.Header[attentionHeader]; exists {
			if len(values) != 1 || values[0] != "1" {
				httpx.WriteError(w, r, h.logger, "bot", "capability", httpx.InvalidInput("Unsupported Bot attention protocol."))
				return
			}
			w.Header().Set(attentionHeader, "1")
		}
		next(w, r, principal)
	}
}

func responseForRequest(r *http.Request, bot model.Bot) api.Bot {
	result := Response(bot)
	if result.BotDefinition != nil && r.Header.Get(attentionHeader) == "1" {
		count := bot.AttentionCount
		result.AttentionCount = &count
	}
	return result
}
